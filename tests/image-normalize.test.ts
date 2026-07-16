// HEIC detection + conversion for uploaded phone photos. Injected converter (no real HEIC needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHeic, normalizeUploadedImage } from '../src/lib/image-normalize.js';

// A minimal ISO-BMFF header: box size, 'ftyp', then a 4-char brand.
const ftyp = (brand: string): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp', 'latin1'), Buffer.from(brand, 'latin1'), Buffer.alloc(8)]);

test('isHeic detects by content-type', () => {
  assert.equal(isHeic(Buffer.alloc(0), 'image/heic'), true);
  assert.equal(isHeic(Buffer.alloc(0), 'image/heif'), true);
  assert.equal(isHeic(Buffer.alloc(0), 'image/jpeg'), false);
});

test('isHeic sniffs the ftyp brand even with an empty content-type', () => {
  assert.equal(isHeic(ftyp('heic'), ''), true); // browsers sometimes send no type for HEIC
  assert.equal(isHeic(ftyp('mif1'), ''), true);
  assert.equal(isHeic(ftyp('avif'), ''), false); // AVIF is not HEIC
  assert.equal(isHeic(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ''), false); // JPEG magic
});

test('normalizeUploadedImage converts HEIC to JPEG', async () => {
  let sawBytes = 0;
  const out = await normalizeUploadedImage(ftyp('heic'), 'image/heic', {
    convertHeic: async (b) => { sawBytes = b.length; return Buffer.from('CONVERTED-JPEG'); },
  });
  assert.equal(out.converted, true);
  assert.equal(out.contentType, 'image/jpeg');
  assert.equal(out.bytes.toString(), 'CONVERTED-JPEG');
  assert.ok(sawBytes > 0);
});

test('normalizeUploadedImage passes non-HEIC through untouched', async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const out = await normalizeUploadedImage(jpg, 'image/jpeg');
  assert.equal(out.converted, false);
  assert.equal(out.contentType, 'image/jpeg');
  assert.equal(out.bytes, jpg);
});
