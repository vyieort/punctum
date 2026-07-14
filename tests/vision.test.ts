// Vision message construction, score parsing, and the confidence gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVisionMessage, parseVisionScore, scoreImages } from '../src/lib/vision.js';
import type { ImageCandidate } from '../src/lib/serpapi.js';

const cand = (n: number): ImageCandidate => ({ thumb: `https://t/${n}.jpg`, pushUrl: `https://p/${n}.jpg`, domain: 'x' });

test('buildVisionMessage lists the thumbnails, then the scoring prompt', () => {
  const content = buildVisionMessage('Vendor: BVLA', [cand(1), cand(2)]) as Array<Record<string, any>>;
  assert.equal(content.length, 3); // 2 images + 1 text block
  assert.equal(content[0]!.type, 'image');
  assert.equal(content[0]!.source.url, 'https://t/1.jpg');
  assert.equal(content[2]!.type, 'text');
  assert.match(content[2]!.text, /numbered 1-2/);
  assert.match(content[2]!.text, /Return ONLY valid JSON/);
});

test('adds the L-bar / nostril nail hint only when relevant', () => {
  const withHint = buildVisionMessage('Item: 18g nostril nail', [cand(1)]) as Array<Record<string, any>>;
  assert.match(withHint[1]!.text, /nose jewelry, not a finger ring/);
  const without = buildVisionMessage('Item: seam ring', [cand(1)]) as Array<Record<string, any>>;
  assert.doesNotMatch(without[1]!.text, /nose jewelry/);
});

test('parseVisionScore tolerates prose around the JSON', () => {
  const s = parseVisionScore('Here you go: {"match": 3, "confidence": 7, "reason": "good"} done');
  assert.deepEqual(s, { match: 3, confidence: 7, reason: 'good' });
});

function fakeFetch(text: string): typeof globalThis.fetch {
  return (async () =>
    ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) }) as unknown as Response) as typeof globalThis.fetch;
}

test('scoreImages returns ENRICHED with the chosen pushUrl when confident', async () => {
  const r = await scoreImages('Vendor: X', [cand(1), cand(2)], {
    apiKey: 'k',
    fetchImpl: fakeFetch('{"match":2,"confidence":8,"reason":"ok"}'),
  });
  assert.equal(r.action, 'ENRICHED');
  assert.equal(r.imageUrl, 'https://p/2.jpg');
  assert.equal(r.thumbUrl, 'https://t/2.jpg'); // thumbnail of the chosen candidate (fallback source)
});

test('scoreImages returns NO_IMAGE below the confidence threshold', async () => {
  const r = await scoreImages('Vendor: X', [cand(1)], {
    apiKey: 'k',
    fetchImpl: fakeFetch('{"match":1,"confidence":3,"reason":"weak"}'),
  });
  assert.equal(r.action, 'NO_IMAGE');
  assert.equal(r.imageUrl, '');
});

test('scoreImages short-circuits to NO_IMAGE when there are no candidates', async () => {
  const r = await scoreImages('Vendor: X', [], { apiKey: 'k', fetchImpl: fakeFetch('{}') });
  assert.equal(r.action, 'NO_IMAGE');
});
