// Deterministic normalization guards: inch marks + casing, only on naming fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClassification } from '../src/lib/normalize.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const ci = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: '', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', is_product: true, back_order: '', ...over,
});

test('inch marks: straight " becomes ″; apostrophes are left alone', () => {
  const r = normalizeClassification(ci({ variation_name: '3/8" YG14K 4mm Tiger\'s Eye', diameter: '3/8"' }));
  assert.equal(r.variation_name, '3/8″ YG14K 4mm Tiger\'s Eye');
  assert.equal(r.diameter, '3/8″');
});

test('casing: ALL-CAPS words title-cased; codes/grades/metal preserved', () => {
  const r = normalizeClassification(
    ci({ item_name: 'Pin with SMALL Sunray', variation_name: 'YG14K 2mm White MOONSTONE AAA [SEP] CZ' }),
  );
  assert.equal(r.item_name, 'Pin with Small Sunray'); // SMALL -> Small
  assert.equal(r.variation_name, 'YG14K 2mm White Moonstone AAA [SEP] CZ'); // MOONSTONE -> Moonstone; rest kept
});

test('extraction fields (description/gems/sku) are left faithful to the invoice', () => {
  const r = normalizeClassification(ci({ description: '18GA 3/8" Ring - SMALL', gems: '4mm White OPAL', sku: 'ABC"123', item_name: 'X' }));
  assert.equal(r.description, '18GA 3/8" Ring - SMALL');
  assert.equal(r.gems, '4mm White OPAL');
  assert.equal(r.sku, 'ABC"123');
});
