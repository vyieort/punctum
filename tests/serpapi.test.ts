// SerpAPI candidate selection: junk-domain filtering, ordering, and push-URL fallback.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidates } from '../src/lib/serpapi.js';

test('drops blocked domains and keeps good results in relevance order', () => {
  const cands = selectCandidates([
    { original: 'https://ebay.com/x.jpg', thumbnail: 'https://t/ebay.jpg' }, // blocked
    { original: 'https://apmbodyjewelry.com/ring.jpg', thumbnail: 'https://t/apm.jpg' },
    { original: 'https://shop.example.com/a.jpg', thumbnail: 'https://t/a.jpg' },
  ]);
  assert.equal(cands.length, 2);
  assert.equal(cands[0]!.pushUrl, 'https://apmbodyjewelry.com/ring.jpg');
  assert.equal(cands[0]!.thumb, 'https://t/apm.jpg');
});

test('push URL falls back to the thumbnail for .webp and hotlink-blocked domains', () => {
  const cands = selectCandidates([
    { original: 'https://example.com/a.webp', thumbnail: 'https://t/a.jpg' }, // webp -> thumb
    { original: 'https://bvla.com/b.jpg', thumbnail: 'https://t/b.jpg' }, // hotlink-blocked -> thumb
    { original: 'http://example.com/c.jpg', thumbnail: 'https://t/c.jpg' }, // http -> forced https
  ]);
  assert.equal(cands[0]!.pushUrl, 'https://t/a.jpg');
  assert.equal(cands[1]!.pushUrl, 'https://t/b.jpg');
  assert.equal(cands[2]!.pushUrl, 'https://example.com/c.jpg');
});

test('caps at 6 good + 1 last-resort; uses last-resort only when nothing else', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    original: `https://good${i}.com/${i}.jpg`,
    thumbnail: `https://t/${i}.jpg`,
  }));
  many.push({ original: 'https://diablobodyjewelry.com/z.jpg', thumbnail: 'https://t/z.jpg' });
  const cands = selectCandidates(many);
  assert.equal(cands.length, 7); // 6 good + 1 diablo
  assert.equal(cands[6]!.pushUrl, 'https://diablobodyjewelry.com/z.jpg');

  const onlyLast = selectCandidates([{ original: 'https://diablobodyjewelry.com/z.jpg', thumbnail: 'https://t/z.jpg' }]);
  assert.equal(onlyLast.length, 1);
});
