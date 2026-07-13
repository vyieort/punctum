// Square import planner + payload builders — pure unit tests (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planItems,
  createItemBody,
  addVariationBody,
  inventoryAdjustBody,
  type ImportLine,
} from '../src/lib/square.js';

const line = (over: Partial<ImportLine>): ImportLine => ({
  item_name: 'Muse Seam Ring',
  variation_name: 'Y14K',
  sku: 'SKU-Y',
  retail_cents: 27500,
  qty: 1,
  category_id: 'CAT_SEAM',
  vendor_category_id: 'CAT_BVLA',
  ...over,
});

test('planItems groups by item_name into one item with N variations', () => {
  const items = planItems([
    line({ variation_name: 'Y14K', sku: 'SKU-Y' }),
    line({ variation_name: 'R14K', sku: 'SKU-R' }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.variations.length, 2);
  assert.deepEqual(
    items[0]!.variations.map((v) => v.variation_name),
    ['Y14K', 'R14K'],
  );
  assert.deepEqual(items[0]!.category_ids, ['CAT_SEAM', 'CAT_BVLA']);
  assert.equal(items[0]!.reporting_category_id, 'CAT_SEAM');
});

test('planItems merges duplicate variations (same variation_name) and sums qty', () => {
  const items = planItems([
    line({ variation_name: 'Y14K', qty: 1 }),
    line({ variation_name: 'Y14K', qty: 2 }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.variations.length, 1);
  assert.equal(items[0]!.variations[0]!.qty, 3);
});

test('planItems keeps distinct item_names as separate items, in order', () => {
  const items = planItems([
    line({ item_name: 'Muse Seam Ring' }),
    line({ item_name: 'Threadless Disk' }),
  ]);
  assert.deepEqual(
    items.map((i) => i.item_name),
    ['Muse Seam Ring', 'Threadless Disk'],
  );
});

test('createItemBody builds an ITEM with all variations, categories, and fixed pricing', () => {
  const [item] = planItems([
    line({ variation_name: 'Y14K', sku: 'SKU-Y', retail_cents: 27500 }),
    line({ variation_name: 'R14K', sku: 'SKU-R', retail_cents: 40000 }),
  ]);
  const body = createItemBody(item!, { idempotencyKey: 'idem-1' });
  assert.equal(body.idempotency_key, 'idem-1');
  assert.equal(body.object.type, 'ITEM');
  assert.equal(body.object.item_data.name, 'Muse Seam Ring');
  assert.deepEqual(body.object.item_data.categories, [{ id: 'CAT_SEAM' }, { id: 'CAT_BVLA' }]);
  assert.equal(body.object.item_data.reporting_category.id, 'CAT_SEAM');
  assert.equal(body.object.item_data.variations.length, 2);
  const v0 = body.object.item_data.variations[0]!;
  assert.equal(v0.id, '#new-variation-0'); // unique temp id per variation
  assert.equal(v0.item_variation_data.sku, 'SKU-Y');
  assert.equal(v0.item_variation_data.pricing_type, 'FIXED_PRICING');
  assert.deepEqual(v0.item_variation_data.price_money, { amount: 27500, currency: 'USD' });
  assert.equal(v0.item_variation_data.track_inventory, true);
  assert.equal(body.object.item_data.variations[1]!.id, '#new-variation-1');
});

test('addVariationBody targets an existing item by item_id', () => {
  const body = addVariationBody(
    'EXISTING_ITEM_ID',
    { variation_name: 'R14K', sku: 'SKU-R', retail_cents: 40000, qty: 1 },
    { idempotencyKey: 'idem-2' },
  );
  assert.equal(body.object.type, 'ITEM_VARIATION');
  assert.equal(body.object.item_variation_data.item_id, 'EXISTING_ITEM_ID');
  assert.equal(body.object.item_variation_data.sku, 'SKU-R');
  assert.deepEqual(body.object.item_variation_data.price_money, { amount: 40000, currency: 'USD' });
});

test('inventoryAdjustBody receives qty into stock (NONE -> IN_STOCK), qty as string', () => {
  const body = inventoryAdjustBody('VAR_ID', 3, {
    locationId: 'LOC1',
    occurredAt: '2026-07-12T00:00:00.000Z',
    idempotencyKey: 'idem-3',
  });
  const chg = body.changes[0]!;
  assert.equal(chg.type, 'ADJUSTMENT');
  assert.equal(chg.adjustment.catalog_object_id, 'VAR_ID');
  assert.equal(chg.adjustment.from_state, 'NONE');
  assert.equal(chg.adjustment.to_state, 'IN_STOCK');
  assert.equal(chg.adjustment.location_id, 'LOC1');
  assert.equal(chg.adjustment.quantity, '3');
});
