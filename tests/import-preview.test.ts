// Import preview — reads the STORED classification (no AI), applies pricing/categories,
// groups, and builds a sample payload. PGlite, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { loadPricingRules, loadCategoryMap, previewInvoiceImport } from '../src/jobs/import-preview.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-0000000000aa';

// A stored classification blob for one product line.
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
      '{"multipliers":{"gold":2.5,"default":3.0},"gold_when":{"metal_contains":["14k","18k","gold"],"vendor_in":["bvla"]},"rounding":{"op":"ceil","to_cents":50}}')`,
  );
  await db.exec(`insert into category_map (client_id, path, square_category_id) values
    ('RE','Threadless > Threadless Ends > Bezel-Set','CAT_TL_BEZEL'),
    ('RE','Vendors > NeoMetal','CAT_V_NEO')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values ('${INV}','RE','NeoMetal','approved')`);
  // two product lines (same item_name -> group into one item) + one non-product
  await db.exec(`insert into invoice_lines (invoice_id, line_no, synthetic_sku, description, is_product, classification) values
    ('${INV}',1,'NEO-1','Titanium Bezel 4mm White Opal',true, '${cls({ item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM White Opal', sku: 'NEO-1', price: '20', qty: '1' })}'::jsonb),
    ('${INV}',2,'NEO-2','Titanium Bezel 4mm Champagne',true, '${cls({ item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM Champagne', sku: 'NEO-2', price: '20', qty: '1' })}'::jsonb),
    ('${INV}',3,'','Shipping',false, '{}'::jsonb)`);
  return db;
}

test('loadPricingRules + loadCategoryMap read client config', async () => {
  const db = (await seeded()) as unknown as Queryable;
  assert.equal((await loadPricingRules(db, 'RE')).multipliers.gold, 2.5);
  assert.equal((await loadCategoryMap(db, 'RE')).get('Threadless > Threadless Ends > Bezel-Set'), 'CAT_TL_BEZEL');
});

test('previewInvoiceImport reads stored classification, groups, prices — no AI, no writes', async () => {
  const db = (await seeded()) as unknown as Queryable;
  const p = await previewInvoiceImport(db, 'RE', INV);

  assert.equal(p.productLines, 2); // shipping excluded
  assert.equal(p.itemCount, 1); // both grouped under one item_name
  assert.equal(p.items[0]!.variations.length, 2);
  assert.equal(p.items[0]!.variations[0]!.price, '$60.00'); // 20 * 3.0
  assert.deepEqual(p.items[0]!.category_ids, ['CAT_TL_BEZEL', 'CAT_V_NEO']);
  const body = p.samplePayload as { object: { type: string; item_data: { variations: unknown[] } } };
  assert.equal(body.object.type, 'ITEM');
  assert.equal(body.object.item_data.variations.length, 2);
});
