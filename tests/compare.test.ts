// Pipeline A/B diff logic — critical (catalog-output) vs supporting fields — + plumbing.

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

test('identical classifications critically agree, no diff lines', () => {
  const a = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', product_type: 'RING' })];
  const b = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', product_type: 'RING' })];
  const r = compareClassifications(a, b);
  assert.equal(r.matched, 1);
  assert.equal(r.criticalAgree, 1);
  assert.equal(r.criticalDiffer, 0);
  assert.equal(r.lines.length, 0);
});

test('a critical-field diff (item_name) counts as a catalog disagreement', () => {
  const a = [ci({ sku: 'S1', item_name: '18G Muse Seam Ring' })];
  const b = [ci({ sku: 'S1', item_name: '18G Muse Ring' })];
  const r = compareClassifications(a, b);
  assert.equal(r.criticalAgree, 0);
  assert.equal(r.criticalDiffer, 1);
  assert.equal(r.lines[0]!.critical[0]!.field, 'item_name');
});

test('a supporting-only diff (gauge) is still a critical AGREEMENT (the key fix)', () => {
  const a = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', gauge: '16G' })];
  const b = [ci({ sku: 'S1', item_name: 'X', variation_name: 'V', gauge: '' })];
  const r = compareClassifications(a, b);
  assert.equal(r.criticalAgree, 1); // catalog output matches
  assert.equal(r.criticalDiffer, 0);
  assert.equal(r.lines.length, 1); // the diff is still surfaced...
  assert.equal(r.lines[0]!.critical.length, 0); // ...but as supporting, not critical
  assert.equal(r.lines[0]!.supporting[0]!.field, 'gauge');
});

test('unmatched SKUs reported; non-products excluded', () => {
  const a = [ci({ sku: 'S1' }), ci({ sku: 'ONLYA' }), ci({ sku: 'SHIP', is_product: false })];
  const b = [ci({ sku: 'S1' }), ci({ sku: 'ONLYB' })];
  const r = compareClassifications(a, b);
  assert.equal(r.products.twoPass, 2);
  assert.deepEqual(r.unmatched.twoPassOnly, ['ONLYA']);
  assert.deepEqual(r.unmatched.onePassOnly, ['ONLYB']);
});

test('runComparison wires both pipelines and diffs the output', async () => {
  const two = async (): Promise<ClassifiedItem[]> => [ci({ sku: 'S1', variation_name: 'V [NVL]' })];
  const one = async (): Promise<ClassifiedItem[]> => [ci({ sku: 'S1', variation_name: 'V [SEP]' })];
  const r = await runComparison('pdf-base64', { twoPass: two, onePass: one });
  assert.equal(r.criticalDiffer, 1);
  assert.equal(r.lines[0]!.critical[0]!.field, 'variation_name');
});
