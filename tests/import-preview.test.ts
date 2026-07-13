// Import preview — DB loaders + the full offline chain, against PGlite with a fake classifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { loadPricingRules, loadCategoryMap, previewInvoiceImport } from '../src/jobs/import-preview.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-0000000000aa';

const ci = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: '', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', ...over,
});

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(
    `insert into client_config (client_id, pricing_rules) values ('RE',
      '{"multipliers":{"gold":2.5,"default":3.0},"gold_when":{"metal_contains":["14k","18k","gold"],"vendor_in":["bvla"]},"rounding":{"op":"ceil","to_cents":50}}')`,
  );
  await db.exec(`insert into category_map (client_id, path, square_category_id) values
    ('RE','Threadless > Threadless Ends > Bezel-Set','CAT_TL_BEZEL'),
    ('RE','Vendors > NeoMetal','CAT_V_NEO')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values ('${INV}','RE','NeoMetal','approved')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, synthetic_sku, description, quantity, wholesale, is_product) values
    ('${INV}',1,'NEO-1','Titanium Bezel 4mm White Opal',1,20,true),
    ('${INV}',2,'NEO-2','Titanium Bezel 4mm Champagne',1,20,true),
    ('${INV}',3,'','Shipping',1,12,false)`);
  return db;
}

test('loadPricingRules + loadCategoryMap read client config', async () => {
  const db = (await seeded()) as unknown as Queryable;
  const rules = await loadPricingRules(db, 'RE');
  assert.equal(rules.multipliers.gold, 2.5);
  const map = await loadCategoryMap(db, 'RE');
  assert.equal(map.get('Threadless > Threadless Ends > Bezel-Set'), 'CAT_TL_BEZEL');
});

test('previewInvoiceImport runs the full chain, groups, prices, and writes nothing', async () => {
  const db = (await seeded()) as unknown as Queryable;
  // Fake classifier: both product lines are the same item (bezel end), different colors.
  const fakeClassify = async (): Promise<ClassifiedItem[]> => [
    ci({ vendor: 'NeoMetal', product_type: 'THREADLESS_END', setting: 'bezel', metal: 'Titanium', price: '20', item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM White Opal', sku: 'NEO-1' }),
    ci({ vendor: 'NeoMetal', product_type: 'THREADLESS_END', setting: 'bezel', metal: 'Titanium', price: '20', item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM Champagne', sku: 'NEO-2' }),
  ];
  const p = await previewInvoiceImport(db, 'RE', INV, { classify: fakeClassify });

  assert.equal(p.productLines, 2); // shipping (is_product=false) excluded
  assert.equal(p.itemCount, 1); // both grouped under one item
  assert.equal(p.items[0]!.variations.length, 2);
  assert.equal(p.items[0]!.variations[0]!.price, '$60.00'); // 20 * 3.0
  assert.deepEqual(p.items[0]!.category_ids, ['CAT_TL_BEZEL', 'CAT_V_NEO']);
  // sample payload is a real Square create-item body
  const body = p.samplePayload as { object: { type: string; item_data: { variations: unknown[] } } };
  assert.equal(body.object.type, 'ITEM');
  assert.equal(body.object.item_data.variations.length, 2);
});
