// Orchestrator: create + reorder into Square (fake client) with mapping writeback. PGlite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { runImport, runImportSafely, recoverStuckImports, type SquareOps } from '../src/jobs/import.js';
import { loadClassifiedProducts } from '../src/jobs/import-preview.js';
import { markLinesExcluded } from '../src/review/store.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-0000000000bb';

const cls = (over: Record<string, unknown>): string =>
  JSON.stringify({ vendor: 'NeoMetal', metal: 'Titanium', product_type: 'THREADLESS_END', setting: 'bezel', ...over });

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(mig('0003_line_classification.sql'));
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(mig('0010_invoice_error_detail.sql'));
  await db.exec(mig('0013_line_excluded.sql'));
  await db.exec(mig('0019_notifications.sql'));
  await db.exec(mig('0020_invoice_push_occurred_at.sql'));
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
  const createdNames: string[] = [];
  let n = 0;
  const ops: SquareOps = {
    // '*' acts as a catch-all so a test can match any (suffixed) name.
    search: async (name) => (searchResults[name] as never[]) ?? (searchResults['*'] as never[]) ?? [],
    upsert: async (body) => {
      const b = body as {
        object: { type: string; item_data?: { name?: string; variations: Array<{ item_variation_data: { sku: string } }> } };
      };
      if (b.object.type === 'ITEM') {
        createdNames.push(b.object.item_data!.name ?? '');
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
  return { ops, inventory, createdNames };
}

test('new invoice: creates the item with all variations, receives inventory, writes mapping', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, inventory, createdNames } = fakeOps({}); // nothing exists -> create
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 1);
  assert.equal(r.variationsAdded, 2);
  assert.equal(r.variationsRestocked, 0);
  assert.equal(r.inventoryAdjusted, 2);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(inventory.map((i) => i.catalog_object_id).sort(), ['V1', 'V2']);
  assert.match(createdNames[0]!, /^18G 4MM Threadless Bezel-Set \[NEO /); // POS tags folded into the name

  const map = await db.query<{ vendor_sku: string; square_item_id: string; square_variation_id: string; retail_price: string; wholesale_price: string; status: string }>(
    `select vendor_sku, square_item_id, square_variation_id, retail_price::text as retail_price,
            wholesale_price::text as wholesale_price, status
       from catalog_mapping where client_id='RE' order by vendor_sku`,
  );
  assert.equal(map.rows.length, 2);
  assert.equal(map.rows[0]!.square_item_id, 'ITEM1');
  assert.equal(map.rows[0]!.retail_price, '60.00'); // 20 * 3.0
  assert.equal(map.rows[0]!.wholesale_price, '20.00'); // invoice cost carried into the mapping
  assert.equal(map.rows[0]!.status, 'PENDING');

  const inv = await db.query<{ status: string }>(`select status from invoices where id = $1`, [INV]);
  assert.equal(inv.rows[0]!.status, 'done');
});

test('reorder via mapping: mapped SKU is restocked, new SKU is added (suffix-safe)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // NEO-1 was pushed on a prior import; the mapping resolves the item by SKU (no name search).
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, status)
    values ('RE','NeoMetal','NEO-1','ITEM1','VX','18G 4MM Threadless Bezel-Set [NEO 18g BZL TL OPL]','4MM White Opal','PENDING')`);
  const { ops } = fakeOps({}); // deliberately no search results — mapping must resolve it
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 0);
  assert.equal(r.variationsRestocked, 1); // NEO-1 already mapped
  assert.equal(r.variationsAdded, 1); // NEO-2 is new
  assert.equal(r.inventoryAdjusted, 2);

  const opal = await db.query<{ square_variation_id: string }>(
    `select square_variation_id from catalog_mapping where client_id='RE' and vendor_sku='NEO-1'`,
  );
  assert.equal(opal.rows[0]!.square_variation_id, 'VX'); // restocked the existing variation
});

test('reorder via name-search fallback when the SKU is not yet mapped', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeOps({
    '*': [{ id: 'ITEM1', item_data: { variations: [{ id: 'VX', item_variation_data: { name: '4MM White Opal', sku: 'NEO-1' } }] } }],
  });
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 0);
  assert.equal(r.variationsRestocked, 1); // matched by variation name from the search result
  assert.equal(r.variationsAdded, 1);
});

test('reorder matches a library-seeded item by NAME when the SKU differs (no duplicate)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // Library-seeded row: same item+variation as invoice line 1, but a generated SKU that does NOT
  // match the invoice's NEO-1, and a real square_item_id (post Square-link sync).
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, status)
    values ('RE','NeoMetal','NEO-GEN-XYZ','LIBITEM','LIBVAR1','18G 4MM Threadless Bezel-Set [NEO 18g TL]','4MM White Opal','PUSHED')`);
  const { ops, inventory, createdNames } = fakeOps({}); // no live search results — mapping name-match must resolve it
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.equal(r.itemsCreated, 0); // matched the existing library item by name — no duplicate ITEM
  assert.equal(createdNames.length, 0);
  assert.equal(r.variationsRestocked, 1); // white opal restocked onto the library variation
  assert.equal(r.variationsAdded, 1); // champagne added as a new variation to that item
  assert.ok(inventory.some((i) => i.catalog_object_id === 'LIBVAR1'));
});

test('inventory occurred_at is derived from the invoice (deterministic, retry-safe)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const occ: string[] = [];
  const base = fakeOps({});
  const ops = { ...base.ops, inventory: async (body: unknown) => { occ.push((body as { changes: Array<{ adjustment: { occurred_at: string } }> }).changes[0]!.adjustment.occurred_at); return {}; } };
  await runImport(q, INV, { ops, locationId: 'LOC' }); // no occurredAt -> must derive from created_at
  assert.ok(occ.length >= 2);
  assert.equal(new Set(occ).size, 1); // every adjustment shares one timestamp -> a retry sends identical data
  const created = (await db.query<{ c: string }>(`select created_at::text as c from invoices where id=$1`, [INV])).rows[0]!.c;
  assert.equal(new Date(occ[0]!).toISOString(), new Date(created).toISOString());
});

test('an aged invoice clamps occurred_at into Square 24h window and persists it (retry-stable)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // Age the invoice well past Square's 24h inventory-history limit.
  await db.query(`update invoices set created_at = now() - interval '8 days' where id = $1`, [INV]);
  const occ: string[] = [];
  const base = fakeOps({});
  const ops = { ...base.ops, inventory: async (body: unknown) => { occ.push((body as { changes: Array<{ adjustment: { occurred_at: string } }> }).changes[0]!.adjustment.occurred_at); return {}; } };

  await runImport(q, INV, { ops, locationId: 'LOC' });
  const ageHours = (Date.now() - new Date(occ[0]!).getTime()) / 3_600_000;
  assert.ok(ageHours < 24, `occurred_at must be within 24h, was ${ageHours.toFixed(1)}h`);

  // It's persisted, and a later retry reuses the exact value (idempotency-safe).
  const stored = (await db.query<{ p: string }>(`select push_occurred_at::text as p from invoices where id=$1`, [INV])).rows[0]!.p;
  assert.ok(stored);
  occ.length = 0;
  await runImport(q, INV, { ops, locationId: 'LOC' });
  assert.equal(new Date(occ[0]!).toISOString(), new Date(stored).toISOString());
});

test('runImportSafely marks a throwing import as error instead of stranding it on importing', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const STUCK = '00000000-0000-0000-0000-00000000f001';
  await db.exec(`insert into invoices (id, client_id, vendor, status) values ('${STUCK}','RE','Anatometal','importing')`);
  // Simulate runImport throwing BEFORE it records a per-item result (e.g. a pre-flight plan error).
  await runImportSafely(q, STUCK, async () => { throw new Error('boom before per-item loop'); });
  const inv = await db.query<{ status: string; error_detail: string | null }>(`select status, error_detail from invoices where id = $1`, [STUCK]);
  assert.equal(inv.rows[0]!.status, 'error'); // no longer stuck on 'importing'
  assert.match(inv.rows[0]!.error_detail ?? '', /boom before per-item loop/);
});

test('a failed push persists error_detail on the invoice (so the review page can show it)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeOps({});
  ops.upsert = async () => { throw new Error('INVALID_REQUEST_ERROR: duplicate SKU'); };
  const r = await runImport(q, INV, { ops, locationId: 'LOC', occurredAt: '2026-07-13T00:00:00.000Z' });

  assert.ok(r.errors.length > 0);
  const inv = await db.query<{ status: string; error_detail: string | null }>(`select status, error_detail from invoices where id = $1`, [INV]);
  assert.equal(inv.rows[0]!.status, 'error');
  const detail = JSON.parse(inv.rows[0]!.error_detail ?? '[]') as Array<{ item: string; error: string }>;
  assert.ok(detail.length > 0);
  assert.match(detail[0]!.error, /duplicate SKU/);

  // ...and it raises a client-facing push_failed alert pointing at the invoice.
  const alerts = await db.query<{ type: string; audience: string; action_url: string }>(
    `select type, audience, action_url from notifications where client_id='RE' and type='push_failed'`,
  );
  assert.equal(alerts.rows.length, 1);
  assert.equal(alerts.rows[0]!.audience, 'client');
  assert.match(alerts.rows[0]!.action_url, new RegExp(INV));
});

test('loadClassifiedProducts skips excluded product lines', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  assert.equal((await loadClassifiedProducts(q, INV)).items.length, 2);
  await db.query(`update invoice_lines set excluded = true where invoice_id = $1 and synthetic_sku = 'NEO-1'`, [INV]);
  assert.equal((await loadClassifiedProducts(q, INV)).items.length, 1);
});

test('markLinesExcluded sets exactly the given lines (re-mark resets the rest)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const rows = (await db.query<{ id: string; sku: string }>(`select id, synthetic_sku as sku from invoice_lines where invoice_id = $1 and is_product order by line_no`, [INV])).rows;
  const neo1 = rows.find((r) => r.sku === 'NEO-1')!.id;
  const neo2 = rows.find((r) => r.sku === 'NEO-2')!.id;
  await markLinesExcluded(q, INV, [neo1]);
  assert.equal((await loadClassifiedProducts(q, INV)).items.length, 1);
  await markLinesExcluded(q, INV, [neo2]); // re-mark: neo1 comes back, neo2 out
  assert.equal((await loadClassifiedProducts(q, INV)).items.length, 1);
  await markLinesExcluded(q, INV, []); // clear all
  assert.equal((await loadClassifiedProducts(q, INV)).items.length, 2);
});

test('recoverStuckImports re-runs every invoice left in importing', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000c1','RE','BVLA','importing'),
    ('00000000-0000-0000-0000-0000000000c2','RE','NeoMetal','importing')`);
  const ran: string[] = [];
  const r = await recoverStuckImports(q, async (_db, id) => {
    ran.push(id);
  });
  assert.deepEqual(ran.sort(), ['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2']);
  assert.equal(r.recovered.length, 2);
  assert.equal(r.failed.length, 0);
});

test('recoverStuckImports records a failure and keeps going', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000c1','RE','BVLA','importing'),
    ('00000000-0000-0000-0000-0000000000c2','RE','NeoMetal','importing')`);
  let first = true;
  const r = await recoverStuckImports(q, async () => {
    if (first) {
      first = false;
      throw new Error('boom');
    }
  });
  assert.equal(r.recovered.length, 1);
  assert.equal(r.failed.length, 1);
});
