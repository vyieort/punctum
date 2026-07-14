// PDF downsampling: threshold guard + graceful fallback (never throws, never enlarges).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeCompressPdf, COMPRESS_THRESHOLD_BYTES } from '../src/lib/pdf-compress.js';

test('small PDFs pass through untouched (below the threshold, no gs invoked)', async () => {
  const b64 = Buffer.from('%PDF-1.4 a tiny invoice').toString('base64');
  const r = await maybeCompressPdf(b64);
  assert.equal(r.compressed, false);
  assert.equal(r.base64, b64);
});

test('oversized non-PDF input falls back to the original without throwing', async () => {
  const junk = Buffer.alloc(COMPRESS_THRESHOLD_BYTES + 1024, 0x41).toString('base64');
  const r = await maybeCompressPdf(junk);
  assert.equal(r.compressed, false); // gs rejects the non-PDF (or is absent) -> original returned
  assert.equal(r.base64, junk);
  assert.ok(r.beforeBytes > COMPRESS_THRESHOLD_BYTES);
});
