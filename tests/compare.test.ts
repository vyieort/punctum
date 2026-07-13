// Pipeline A/B diff logic (pure) + the runComparison plumbing (injected fakes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareClassifications, runComparison } from '../src/jobs/compare.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const ci = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: '', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', is_product: true, ...over,
});

test('identical classifications agree', () => {
  const a = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', product_type: 'RING' })];
  const b = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', product_type: 'RING' })];
  const r = compareClassifications(a, b);
  assert.equal(r.matched, 1);
  assert.equal(r.agreements, 1);
  assert.equal(r.disagreements, 0);
});

test('a differing field is reported as a disagreement with both values', () => {
  const a = [ci({ sku: 'S1', item_name: '18G Muse Seam Ring' })];
  const b = [ci({ sku: 'S1', item_name: '18G Muse Ring' })];
  const r = compareClassifications(a, b);
  assert.equal(r.agreements, 0);
  assert.equal(r.disagreements, 1);
  assert.equal(r.lines[0]!.diffs[0]!.field, 'item_name');
  assert.equal(r.lines[0]!.diffs[0]!.twoPass, '18G Muse Seam Ring');
  assert.equal(r.lines[0]!.diffs[0]!.onePass, '18G Muse Ring');
});

test('lines only in one pass are reported unmatched; non-products excluded', () => {
  const a = [ci({ sku: 'S1', item_name: 'X' }), ci({ sku: 'ONLYA', item_name: 'Y' }), ci({ sku: 'SHIP', is_product: false })];
  const b = [ci({ sku: 'S1', item_name: 'X' }), ci({ sku: 'ONLYB', item_name: 'Z' })];
  const r = compareClassifications(a, b);
  assert.equal(r.products.twoPass, 2); // SHIP (is_product:false) excluded
  assert.equal(r.matched, 1);
  assert.deepEqual(r.unmatched.twoPassOnly, ['ONLYA']);
  assert.deepEqual(r.unmatched.onePassOnly, ['ONLYB']);
});

test('runComparison wires both pipelines and diffs their output', async () => {
  const two = async (): Promise<ClassifiedItem[]> => [ci({ sku: 'S1', item_name: 'X', variation_name: 'V [NVL]' })];
  const one = async (): Promise<ClassifiedItem[]> => [ci({ sku: 'S1', item_name: 'X', variation_name: 'V [SEP]' })];
  const r = await runComparison('pdf-base64', { twoPass: two, onePass: one });
  assert.equal(r.matched, 1);
  assert.equal(r.disagreements, 1);
  assert.equal(r.lines[0]!.diffs[0]!.field, 'variation_name');
});
