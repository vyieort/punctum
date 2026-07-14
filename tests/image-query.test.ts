// Per-vendor image-search query construction + productInfo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageQuery } from '../src/lib/image-query.js';

test('strips the [TAGS] suffix from the item name before searching', () => {
  const { query } = buildImageQuery({
    vendor: 'BVLA',
    itemName: '20G Seam Ring [BVLA 20g SMR RG]',
    variationName: 'R14K',
    description: '',
    gems: '',
    sku: '',
  });
  assert.doesNotMatch(query, /\[/); // no bracketed tags leak into the search
  assert.match(query, /bvla/i);
  assert.match(query, /seam ring/i);
});

test('BVLA query uses description base + metal color + gem', () => {
  const { query } = buildImageQuery({
    vendor: 'BVLA',
    itemName: '18G Muse',
    variationName: 'R14K',
    description: '18g Muse Seam Ring - 1.5mm White CZ 14k Rose Gold',
    gems: '',
    sku: 'BVLA-1',
  });
  assert.match(query, /^bvla /i);
  assert.match(query, /muse seam ring/i);
  assert.match(query, /rose gold/i);
});

test('NeoMetal query maps setting + stone + titanium threadless', () => {
  const { query } = buildImageQuery({
    vendor: 'NeoMetal',
    itemName: '18ga Ti Bezel Cabochon',
    variationName: '4mm White Opal',
    description: '',
    gems: '',
    sku: 'XCAB18-4OW',
  });
  assert.match(query, /neometal/i);
  assert.match(query, /bezel cabochon/i);
  assert.match(query, /white opal/i);
  assert.match(query, /titanium threadless/i);
});

test('productInfo carries the item facts fed to Vision', () => {
  const { productInfo } = buildImageQuery({
    vendor: 'BVLA',
    itemName: '18G Muse',
    variationName: 'R14K',
    description: 'desc',
    gems: 'White CZ',
    sku: 'BVLA-1',
  });
  assert.match(productInfo, /Vendor: BVLA/);
  assert.match(productInfo, /Variation: R14K/);
  assert.match(productInfo, /Gems: White CZ/);
  assert.match(productInfo, /SKU: BVLA-1/);
});
