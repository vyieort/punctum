// Orchestrator: create + reorder into Square (fake client) with mapping writeback. PGlite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { runImport, type SquareOps } from '../src/jobs/import.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-0000000000bb';

const cls = (over: Record<string, unknown>): string =>
  JSON.stringify({ vendor: 'NeoMetal', metal: 'Titanium', product_type: 'THREADLESS_END', setting: 'bezel', ...over });

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(mig('0003_line_classification.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(
    `insert into client_config (client_id, pricing_rules) values ('RE',
      '{"multipliers":{"gold":2.5,"default":3.0},"gold_when":{"metal_contains":["14k"],"vendor_in":["bvla"]},"rounding":{"op":"ceil","to_cents":50}}')`,
  );
  await db.exec(`insert into category_map (client_id, path, square_category_id) values
    ('RE','Threadless > Threadless Ends > Bezel-Set','CAT_TL_BEZEL'),
    ('RE','Vendors > NeoMetal','CAT_V_NEO')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values ('${INV}','RE','NeoMetal','approved')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, synthetic_sku, description, is_product, classification) values
    ('${INV}',1,'NEO-1','Bezel 4mm White Opal',true, '${cls({ item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM White Opal', sku: 'NEO-1', price: '20', qty: '1' })}'::jsonb),
    ('${INV}',2,'NEO-2','Bezel 4mm Champagne',true, '${cls({ item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM Champagne', sku: 'NEO-2', price: '20', qty: '1' })}'::jsonb),
    ('${INV}',3,'','Shipping',false, '{}'::jsonb)`);
  return db;
}

function fakeOps(searchResults: Record<string, unknown[]>) {
  const inventory: Array<{ catalog_object_id: string; quantity: string }> = [];
  let n = 0;
  const ops: SquareOps = {
    search: async (name) => (searchResults[name] as never[]) ?? [],
    upsert: async (body) => {
      const b = body as { object: { type: string; item_data?: { variations: Array<{ item_variation_data: { sku: string } }> } } };
      if (b.object.type === 'ITEM') {
        return {
          catalog_object: {
            id: 'ITEM1',
            item_data: {
              variations: b.object.item_data!.variations.map((v, i) => ({ id: 'V' + (i + 1), item_variation_data: { sku: v.item_variation_data.sku } })),
            },
          },
        };
      }
      return { catalog_object: { id: 'VNEW' + ++n } };
    },
    inventory: async (body) => {
      const chg = (body as { changes: Array<{ adjustment: { catalog_object_id: string; quantity: string } }> }).changes[0]!.adjustment;
      inventory.push({ catalog_object_id: chg.catalog_object_id, quantity: chg.quantity });
      return {};
    },
  };
  return { ops, inventory };
}

test('new invoice: creates the item with all variations, receives inventory, writes mapping', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, inventory } = fakeOps({}); // nothing exists -> create
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 1);
  assert.equal(r.variationsAdded, 2);
  assert.equal(r.variationsRestocked, 0);
  assert.equal(r.inventoryAdjusted, 2);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(inventory.map((i) => i.catalog_object_id).sort(), ['V1', 'V2']);

  const map = await db.query<{ vendor_sku: string; square_item_id: string; square_variation_id: string; retail_price: string; status: string }>(
    `select vendor_sku, square_item_id, square_variation_id, retail_price::text as retail_price, status
       from catalog_mapping where client_id='RE' order by vendor_sku`,
  );
  assert.equal(map.rows.length, 2);
  assert.equal(map.rows[0]!.square_item_id, 'ITEM1');
  assert.equal(map.rows[0]!.retail_price, '60.00'); // 20 * 3.0
  assert.equal(map.rows[0]!.status, 'PENDING');

  const inv = await db.query<{ status: string }>(`select status from invoices where id = $1`, [INV]);
  assert.equal(inv.rows[0]!.status, 'done');
});

test('reorder: existing variation is restocked, missing variation is added', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeOps({
    '18G 4MM Threadless Bezel-Set': [
      { id: 'ITEM1', item_data: { variations: [{ id: 'VX', item_variation_data: { name: '4MM White Opal', sku: 'NEO-1' } }] } },
    ],
  });
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 0);
  assert.equal(r.variationsRestocked, 1); // '4MM White Opal' already exists
  assert.equal(r.variationsAdded, 1); // '4MM Champagne' is new
  assert.equal(r.inventoryAdjusted, 2);

  const opal = await db.query<{ square_variation_id: string }>(
    `select square_variation_id from catalog_mapping where client_id='RE' and vendor_sku='NEO-1'`,
  );
  assert.equal(opal.rows[0]!.square_variation_id, 'VX'); // restocked existing variation
});
