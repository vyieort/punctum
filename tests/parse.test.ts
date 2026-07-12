// Invoice extraction parser — parity with the live Make Sc1 module 13 (scenario 5330149).
// Diff-tested identical to the verbatim oracle across fences/prose/malformed/empty inputs;
// these committed cases lock in the behavior + the module 13 -> module 32 composition.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction, extractJson, parseInvoiceLines } from '../src/lib/parse.js';
import { fillSkus } from '../src/lib/sku.js';

const INV = {
  vendor_name: 'BVLA',
  invoice_number: 'INV-1001',
  invoice_date: '2026-07-10',
  invoice_total: 214.5,
  line_items: [
    { sku: '16-1468-300-20-R14K', description: 'Muse Seam Ring 18g', quantity: 1, unit_price: 147.5, total: 147.5, is_product: true, gems: '1.5mm White CZ', notes: '', back_order: '' },
    { sku: '', description: 'Ball End 4mm Titanium', quantity: 2, unit_price: 27.5, total: 55, is_product: true, gems: '', notes: '', back_order: null },
    { sku: '', description: 'Shipping', quantity: 1, unit_price: 12, total: 12, is_product: false, gems: '', notes: '', back_order: '' },
  ],
};
const J = JSON.stringify(INV);

test('parses fenced JSON, keeps only products, carries invoice metadata', () => {
  const r = parseExtraction('```json\n' + J + '\n```');
  assert.equal(r.vendor_name, 'BVLA');
  assert.equal(r.invoice_number, 'INV-1001');
  assert.equal(r.invoice_total, 214.5);
  assert.equal(r.product_count, 2); // Shipping (is_product:false) dropped
  assert.ok(r.products.every((p) => p.is_product));
  assert.equal(r.products[1]!.back_order, null); // null passes through untouched
});

test('extractJson pulls the JSON body out of a fenced code block', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
});

test('tolerates leading prose with no fence, and generic ``` fences', () => {
  assert.equal(parseExtraction('Sure! Extracted invoice: ' + J).product_count, 2);
  assert.equal(parseExtraction('```\n' + J + '\n```').product_count, 2);
});

test('throws (never a silent empty success) on malformed JSON', () => {
  assert.throws(() => parseExtraction('```json\n{ oops: }\n```'), /Sc1 parse failed/);
});

test('throws when line_items is missing', () => {
  assert.throws(() => parseExtraction('{"vendor_name":"BVLA","invoice_number":"X"}'), /missing line_items/);
});

test('empty or all-non-product invoices yield zero products', () => {
  assert.equal(parseExtraction('{"line_items":[]}').product_count, 0);
  assert.equal(
    parseExtraction('{"line_items":[{"is_product":false},{"is_product":false}]}').product_count,
    0,
  );
});

test('parse -> fillSkus composes (Sc1 module 13 -> module 32)', () => {
  const r = parseExtraction(J);
  const withSkus = fillSkus(r.vendor_name, r.products);
  assert.equal(withSkus[0]!.sku, '16-1468-300-20-R14K'); // real SKU preserved
  assert.equal(withSkus[1]!.sku, 'BVLA-BAL-END-TI-4MM'); // blank SKU generated
});

test('parseInvoiceLines keeps ALL line items (products + non-products) for review', () => {
  const r = parseInvoiceLines('```json\n' + J + '\n```');
  assert.equal(r.line_items.length, 3); // Shipping retained, not dropped
  assert.equal(r.line_items.filter((i) => i.is_product).length, 2);
  assert.equal(r.vendor_name, 'BVLA');
  assert.equal(r.invoice_total, 214.5);
});
