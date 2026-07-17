// The A/B extraction diff that the vendor-eval harness prints — pure, so it's CI-tested even though
// the real extraction runs the model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffExtractions, formatExtractionDiff } from '../src/lib/extraction-diff.js';
import type { MergedInvoice } from '../src/lib/merged.js';

const inv = (items: Array<Record<string, unknown>>): MergedInvoice =>
  ({ vendor_name: 'Anatometal', invoice_number: '', invoice_date: '', invoice_total: 0, items: items as never });

test('diffExtractions reports per-line field changes on key fields', () => {
  const baseline = inv([
    { sku: 'ED-FBGE-TI-14g-4', gems: '' },
    { sku: 'faceted-4.0AB-fb', gems: '', is_product: true },
  ]);
  // With the Anatometal hint: the parent gets the gem, and the accent line is no longer its own product.
  const hinted = inv([
    { sku: 'ED-FBGE-TI-14g-4', gems: '4mm Aurora Borealis CZ' },
    { sku: 'faceted-4.0AB-fb', gems: '', is_product: false },
  ]);
  const d = diffExtractions(baseline, hinted);
  assert.equal(d.baselineItems, 2);
  assert.equal(d.hintedItems, 2);
  assert.equal(d.changedLines, 1); // only line 1's gems changed among KEY_FIELDS
  assert.deepEqual(d.changes, [{ line: 1, field: 'gems', before: '', after: '4mm Aurora Borealis CZ' }]);
});

test('diffExtractions flags a line-count change', () => {
  const d = diffExtractions(inv([{ sku: 'A' }, { sku: 'B' }]), inv([{ sku: 'A' }]));
  assert.equal(d.baselineItems, 2);
  assert.equal(d.hintedItems, 1);
  assert.match(formatExtractionDiff(d), /line count changed/);
});

test('no differences -> explicit "changed nothing" summary', () => {
  const same = inv([{ sku: 'A', gems: 'x' }]);
  const d = diffExtractions(same, inv([{ sku: 'A', gems: 'x' }]));
  assert.equal(d.changes.length, 0);
  assert.match(formatExtractionDiff(d), /changed nothing/);
});
