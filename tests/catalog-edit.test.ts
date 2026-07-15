// Batch item editing: get-modify-upsert to Square (image-preserving), correction logging, and the
// learning-loop patterns report. PGlite + a fake Square catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { applyEdits, getEditPatterns, nameDiverges, type EditPushOps } from '../src/review/catalog-edit.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into category_map (client_id, path, square_category_id) values
    ('RE','Cat A Path','CAT_A'), ('RE','Cat B Path','CAT_B')`);
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, item_description, retail_price, category_path, status)
    values ('RE','NeoMetal','NEO-1','ITEM1','VAR1','Bezel-Set End [NEO 18g]','old desc',60.00,'Cat A Path','PUSHED')`);
  return db;
}

async function seqOf(db: PGlite): Promise<string> {
  const r = await db.query<{ seq: string }>(`select seq::text as seq from catalog_mapping where vendor_sku='NEO-1'`);
  return r.rows[0]!.seq;
}

function fakeOps() {
  const pushed: any[] = [];
  const store: Record<string, any> = {
    ITEM1: { id: 'ITEM1', version: 1, type: 'ITEM', item_data: { name: 'Bezel-Set End [NEO 18g]', description: 'old desc', image_ids: ['IMG1'], reporting_category: { id: 'CAT_A' }, categories: [{ id: 'CAT_A' }, { id: 'CAT_V' }], variations: [{ id: 'VAR1' }] } },
    VAR1: { id: 'VAR1', version: 1, type: 'ITEM_VARIATION', item_variation_data: { item_id: 'ITEM1', name: '4MM', pricing_type: 'FIXED_PRICING', price_money: { amount: 6000, currency: 'USD' } } },
  };
  const ops: EditPushOps = {
    getObject: async (id) => JSON.parse(JSON.stringify(store[id])),
    upsert: async (body: any) => { pushed.push(body.object); return { catalog_object: body.object }; },
  };
  return { ops, pushed };
}

test('nameDiverges ignores spacing/case, flags real word changes', () => {
  assert.equal(nameDiverges('18G Bezel End', '18g  bezel end'), false);
  assert.equal(nameDiverges('18G Bezel End', '18G Bezel Cluster'), true);
});

test('price edit pushes the variation and logs the correction', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, pushed } = fakeOps();
  const r = await applyEdits(q, 'RE', [{ seq: await seqOf(db), retailPrice: '75' }], { ops });

  assert.equal(r.rowsChanged, 1);
  assert.equal(r.pushed, 1);
  assert.equal(pushed[0].item_variation_data.price_money.amount, 7500);
  const map = await db.query<{ rp: string }>(`select retail_price::text as rp from catalog_mapping where vendor_sku='NEO-1'`);
  assert.equal(map.rows[0]!.rp, '75.00');
  const log = await db.query<{ field: string; old_value: string; new_value: string }>(`select field, old_value, new_value from catalog_edits`);
  assert.equal(log.rows[0]!.field, 'retail_price');
  assert.equal(log.rows[0]!.old_value, '60.00');
  assert.equal(log.rows[0]!.new_value, '75.00');
});

test('name+category+description: one item upsert, images preserved, 3 corrections logged', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, pushed } = fakeOps();
  const r = await applyEdits(q, 'RE', [{ seq: await seqOf(db), itemName: 'Bezel-Set Cluster', description: 'new desc', categoryPath: 'Cat B Path' }], { ops });

  assert.equal(r.pushed, 1); // a single item-level upsert covers all three
  assert.equal(r.fieldsChanged, 3);
  const obj = pushed[0];
  assert.deepEqual(obj.item_data.image_ids, ['IMG1']); // never touched
  assert.equal(obj.item_data.name, 'Bezel-Set Cluster [NEO 18g]'); // base changed, suffix kept
  assert.equal(obj.item_data.description, 'new desc');
  assert.equal(obj.item_data.reporting_category.id, 'CAT_B');
  assert.deepEqual(obj.item_data.categories.map((c: any) => c.id), ['CAT_B', 'CAT_V']); // leaf swapped, vendor cat kept

  const fields = (await db.query<{ field: string; diverged: boolean }>(`select field, diverged from catalog_edits order by field`)).rows;
  assert.deepEqual(fields.map((f) => f.field), ['category', 'description', 'item_name']);
  assert.equal(fields.find((f) => f.field === 'item_name')!.diverged, true);
});

test('no-op edits push nothing and log nothing', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, pushed } = fakeOps();
  const r = await applyEdits(q, 'RE', [{ seq: await seqOf(db), retailPrice: '60', categoryPath: 'Cat A Path', itemName: 'Bezel-Set End' }], { ops });
  assert.equal(r.rowsChanged, 0);
  assert.equal(pushed.length, 0);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int as n from catalog_edits`)).rows[0]!.n, 0);
});

test('getEditPatterns surfaces recurring category moves + name deviations', async () => {
  const db = await seeded();
  await db.exec(`insert into catalog_edits (client_id, field, old_value, new_value, vendor) values
    ('RE','category','Cat A Path','Cat B Path','NeoMetal'),
    ('RE','category','Cat A Path','Cat B Path','NeoMetal'),
    ('RE','category','Cat A Path','Cat B Path','BVLA')`);
  await db.exec(`insert into catalog_edits (client_id, field, old_value, new_value, vendor, diverged) values
    ('RE','item_name','X End','X Cluster','NeoMetal',true)`);
  const rep = await getEditPatterns(db as unknown as Queryable, 'RE');

  assert.equal(rep.totalEdits, 4);
  assert.equal(rep.byField.category, 3);
  assert.equal(rep.categoryCandidates.length, 1); // only the NeoMetal move recurs (2x); BVLA once is excluded
  assert.equal(rep.categoryCandidates[0]!.vendor, 'NeoMetal');
  assert.equal(rep.categoryCandidates[0]!.count, 2);
  assert.equal(rep.recentNameDeviations.length, 1);
  assert.equal(rep.nameOverridesByVendor[0]!.vendor, 'NeoMetal');
});
