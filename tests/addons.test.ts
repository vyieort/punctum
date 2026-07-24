// #32 add-on folding: item add-ons raise their parent's wholesale (by link, else adjacency);
// order-level fees are dropped; per-unit math; excluded lines ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAddOns, isFoldableAddOn, type OrderedLine } from '../src/lib/addons.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const mk = (o: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: 'ANATO', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', is_product: true, back_order: '', ...o,
});
const L = (item: ClassifiedItem, isProduct = true, excluded = false): OrderedLine => ({ item, isProduct, excluded });

test('linked add-on folds into its parent by SKU, regardless of order', async () => {
  const end = mk({ sku: 'TE-4MM', description: 'Threadless End 4mm', price: '20' });
  const gem = mk({ description: '2.0mm White CZ', price: '8', is_product: false, folds_into: 'TE-4MM' });
  // gem listed in a separate section AFTER the product
  const after = foldAddOns([L(end), L(gem, false)]);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.price, '28'); // 20 + 8

  // and the same when the gem is listed BEFORE the product (forward link)
  const before = foldAddOns([L(mk({ description: '2.0mm White CZ', price: '8', is_product: false, folds_into: 'TE-4MM' }), false), L(mk({ sku: 'TE-4MM', description: 'End', price: '20' }))]);
  assert.equal(before[0]!.price, '28');
});

test('unlinked add-on folds into the nearest preceding product (adjacency fallback)', async () => {
  const end = mk({ sku: 'X', description: 'Threadless End' });
  const upcharge = mk({ description: 'Gold Threaded 18ga Add-on', price: '15', is_product: false }); // no folds_into
  const out = foldAddOns([L(mk({ ...end, price: '20' })), L(upcharge, false)]);
  assert.equal(out[0]!.price, '35'); // 20 + 15
});

test('order-level fees are dropped, never folded', async () => {
  const end = mk({ sku: 'X', description: 'End', price: '20' });
  const ship = mk({ description: 'Shipping', price: '9', is_product: false });
  const tax = mk({ description: 'Sales Tax', price: '3', is_product: false });
  const out = foldAddOns([L(end), L(ship, false), L(tax, false)]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.price, '20'); // untouched
});

test('per-unit math: add-on total is distributed across the parent quantity', async () => {
  const end = mk({ sku: 'X', description: 'End', price: '20', qty: '2' });
  const addon = mk({ description: 'Add-on', price: '15', qty: '2', is_product: false, folds_into: 'X' });
  // add-on total 15*2 = 30; per parent unit 30/2 = 15; new unit 20 + 15 = 35
  const out = foldAddOns([L(end), L(addon, false)]);
  assert.equal(out[0]!.price, '35');
});

test('excluded lines are ignored on both sides', async () => {
  // excluded add-on is not folded
  const kept = foldAddOns([
    L(mk({ sku: 'X', description: 'End', price: '20' })),
    L(mk({ description: 'Add-on', price: '15', is_product: false, folds_into: 'X' }), false, true),
  ]);
  assert.equal(kept[0]!.price, '20');

  // excluded product is not a target and drops out
  const gone = foldAddOns([
    L(mk({ sku: 'X', description: 'End', price: '20' }), true, true),
    L(mk({ description: 'Add-on', price: '15', is_product: false, folds_into: 'X' }), false),
  ]);
  assert.equal(gone.length, 0);
});

test('duplicate SKUs: an ambiguous link falls back to adjacency (Anatometal gem-pairing)', async () => {
  // The same bezel SKU is bought twice, each set with a different gem listed right below it. The
  // extractor links both gems by that shared SKU (ambiguous), so folding must use adjacency, not
  // dump both gems onto one bezel.
  const bezel1 = mk({ sku: 'NC-BEZ', item_name: 'Partial Bezel Navel Curve', description: 'Partial Bezel', price: '43.18' });
  const gemA = mk({ description: 'Faceted CZ Amethyst 4mm', price: '0.84', is_product: false, folds_into: 'NC-BEZ' });
  const bezel2 = mk({ sku: 'NC-BEZ', item_name: 'Partial Bezel Navel Curve', description: 'Partial Bezel', price: '43.18' });
  const gemB = mk({ description: 'Faceted CZ Aurora Borealis 4mm', price: '1.85', is_product: false, folds_into: 'NC-BEZ' });

  const out = foldAddOns([L(bezel1), L(gemA, false), L(bezel2), L(gemB, false)]);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.price, '44.02'); // 43.18 + 0.84 (its OWN gem), not both
  assert.equal(out[1]!.price, '45.03'); // 43.18 + 1.85
});

test('a keyword-less gem with no link still folds via adjacency (fold-unless-fee)', async () => {
  const piece = mk({ sku: 'X', description: 'Gem Ball End, Titanium', price: '12.88' });
  const gem = mk({ description: 'Faceted CZ Brilliant, Champagne, 4mm', price: '1.05', is_product: false }); // no folds_into, no add-on keyword
  const out = foldAddOns([L(piece), L(gem, false)]);
  assert.equal(out[0]!.price, '13.93'); // 12.88 + 1.05 — folded, not dropped
});

test('isFoldableAddOn folds any non-product line except recognized order fees', () => {
  assert.equal(isFoldableAddOn(mk({ description: 'Gold Threaded Add-on' })), true);
  assert.equal(isFoldableAddOn(mk({ description: '2mm CZ Gem' })), true);
  assert.equal(isFoldableAddOn(mk({ description: 'Faceted CZ Brilliant, Amethyst, 4mm' })), true); // keyword-less gem still folds
  assert.equal(isFoldableAddOn(mk({ description: 'Cabochon Synthetic Opal, 5mm' })), true);
  assert.equal(isFoldableAddOn(mk({ description: 'Shipping' })), false);
  assert.equal(isFoldableAddOn(mk({ description: 'Sales Tax' })), false);
  assert.equal(isFoldableAddOn(mk({ description: 'Insurance' })), false);
  assert.equal(isFoldableAddOn(mk({ description: 'anything at all', folds_into: 'X' })), true); // link forces fold
});
