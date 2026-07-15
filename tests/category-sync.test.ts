// syncCategoryPaths: backfill catalog_mapping.category_path from the live Square catalog. PGlite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { syncCategoryPaths, type CategorySyncOps } from '../src/jobs/category-sync.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into category_map (client_id, path, square_category_id) values
    ('RE','Threadless > Ends','CAT_TL'), ('RE','Curved > Barbells','CAT_CB')`);
  // Two variations of ITEM1 (blank category), one of ITEM2 (already set), one whose category is unknown.
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, status) values
    ('RE','ANA','S1','ITEM1','V1','A','PUSHED'),
    ('RE','ANA','S2','ITEM1','V2','A','PUSHED'),
    ('RE','ANA','S3','ITEM2','V3','B','PUSHED'),
    ('RE','ANA','S4','ITEM3','V4','C','PUSHED')`);
  await db.exec(`update catalog_mapping set category_path='Threadless > Ends' where square_item_id='ITEM2'`);
  return db;
}

const catalog: CategorySyncOps = {
  listItems: async () => [
    { id: 'ITEM1', item_data: { reporting_category: { id: 'CAT_TL' } } },
    { id: 'ITEM2', item_data: { reporting_category: { id: 'CAT_TL' } } }, // already that path -> no write
    { id: 'ITEM3', item_data: { reporting_category: { id: 'CAT_UNKNOWN' } } }, // not in map -> skipped
  ],
};

test('syncCategoryPaths writes the resolved path onto every variation of an item', async () => {
  const db = await seeded();
  const r = await syncCategoryPaths(db as unknown as any, 'RE', { ops: catalog });
  assert.equal(r.items, 3);
  assert.equal(r.matched, 2); // ITEM1 + ITEM2 resolve; ITEM3's category is unknown
  assert.equal(r.updated, 2); // both ITEM1 variations written; ITEM2 unchanged; ITEM3 skipped

  const rows = (await db.query<{ sku: string; cp: string | null }>(
    `select vendor_sku as sku, category_path as cp from catalog_mapping where client_id='RE' order by vendor_sku`,
  )).rows;
  assert.equal(rows.find((x) => x.sku === 'S1')!.cp, 'Threadless > Ends');
  assert.equal(rows.find((x) => x.sku === 'S2')!.cp, 'Threadless > Ends');
  assert.equal(rows.find((x) => x.sku === 'S4')!.cp, null); // unknown category untouched
});

test('syncCategoryPaths falls back to categories[0] and is a no-op on rerun', async () => {
  const db = await seeded();
  const ops: CategorySyncOps = { listItems: async () => [{ id: 'ITEM1', item_data: { categories: [{ id: 'CAT_CB' }] } }] };
  const r1 = await syncCategoryPaths(db as unknown as any, 'RE', { ops });
  assert.equal(r1.updated, 2); // both ITEM1 rows -> Curved > Barbells
  const r2 = await syncCategoryPaths(db as unknown as any, 'RE', { ops });
  assert.equal(r2.updated, 0); // already set
});
