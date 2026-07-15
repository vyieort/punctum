// Square library export mapping: header-name based, tolerant of per-account column layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLibraryRows, deriveVendor, extractTags, skuForRow, type LibraryRow } from '../src/lib/library-import.js';

const lrow = (o: Partial<LibraryRow>): LibraryRow => ({
  token: '', itemName: '', variationName: '', sku: '', description: '', reportingCategory: '',
  retailCents: 0, wholesaleCents: null, quantity: null, ...o,
});

test('deriveVendor + extractTags read the [TAGS] suffix', () => {
  assert.equal(deriveVendor('10G Captive Bead [TD TI END 10g ANA]'), 'Anatometal');
  assert.equal(deriveVendor('20G Seam Ring [BVLA 20g SMR RG]'), 'BVLA');
  assert.equal(deriveVendor('Mystery Item'), ''); // no suffix / no vendor code
  assert.equal(extractTags('20G Seam Ring [BVLA 20g SMR RG]'), 'BVLA 20g SMR RG');
});

test('skuForRow keeps a vendor SKU, else generates one from vendor + name', () => {
  assert.equal(skuForRow(lrow({ sku: 'ED-CB-TI-10g' })), 'ED-CB-TI-10g');
  const gen = skuForRow(lrow({ itemName: '10G Threadless Captive Bead [TD TI END 10g ANA]', variationName: '1/4″' }));
  assert.ok(gen.startsWith('ANA-')); // Anatometal prefix recovered from the suffix
  assert.ok(gen.length > 4);
});

test('maps columns by header name, tolerant of layout (real Square export shape)', () => {
  const header = [
    'Token', 'Item Name', 'Variation Name', 'SKU', 'Description', 'Reporting Category', 'Price', 'Current Quantity RE AI POS',
  ];
  const rows = [
    ['TOK1', '10G Curved Barbell [TI BBL 10G ANA]', '5/8″ Shaft Only', 'BB-CRVSH-TI-10g-L5l8', 'CURVED|10G|SHAFT', 'Threaded', '34.29', '2'],
    ['', '', '', '', '', '', '', ''], // blank spacer -> skipped
  ];
  const out = mapLibraryRows(header, rows);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.token, 'TOK1'); // -> square_variation_id
  assert.equal(out[0]!.sku, 'BB-CRVSH-TI-10g-L5l8');
  assert.equal(out[0]!.variationName, '5/8″ Shaft Only');
  assert.equal(out[0]!.reportingCategory, 'Threaded');
  assert.equal(out[0]!.retailCents, 3429);
  assert.equal(out[0]!.wholesaleCents, null); // no Cost column here
  assert.equal(out[0]!.quantity, 2); // matched the location-named quantity column
});

test('reads a Cost column when present + strips $ and commas', () => {
  const out = mapLibraryRows(['SKU', 'Price', 'Cost'], [['S1', '$1,234.50', '$10.00']]);
  assert.equal(out[0]!.retailCents, 123450);
  assert.equal(out[0]!.wholesaleCents, 1000);
});

test('skips rows with neither a token nor a SKU', () => {
  const out = mapLibraryRows(['Token', 'SKU', 'Item Name'], [['', '', 'stray'], ['T', 'S', 'Item']]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sku, 'S');
});
