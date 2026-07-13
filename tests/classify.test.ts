// Classification — deterministic input/output tests + the call path with a fake model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClassifierInput, parseClassifierItems, classifyLines } from '../src/lib/classify.js';

function fakeAnthropic(text: string): typeof globalThis.fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => '',
  })) as unknown as typeof globalThis.fetch;
}

test('buildClassifierInput makes pipe rows and converts straight quotes to the inch mark', () => {
  const rows = buildClassifierInput([
    { vendor: 'BVLA', sku: 'X', description: 'Pin 1/8"', qty: 1, price: 147, gems: '2mm "White" CZ', notes: '' },
    { vendor: 'NeoMetal', sku: 'Y', description: 'Bezel', qty: 2, price: 20, gems: '', notes: 'note' },
  ]);
  assert.equal(
    rows,
    'BVLA|X|Pin 1/8″|1|147|2mm ″White″ CZ|\nNeoMetal|Y|Bezel|2|20||note',
  );
});

test('parseClassifierItems extracts items[], tolerating pretty-print + leading text', () => {
  const items = parseClassifierItems('Here you go:\n{"items": [\n  {"item_name":"A"},\n  {"item_name":"B"}\n]}');
  assert.equal(items.length, 2);
  assert.equal(items[0]!.item_name, 'A');
});

test('parseClassifierItems throws on malformed JSON and on missing items[]', () => {
  assert.throws(() => parseClassifierItems('not json at all'), /Classifier parse failed/);
  assert.throws(() => parseClassifierItems('{"foo":1}'), /missing items/);
});

test('classifyLines sends the batch and returns parsed classified items', async () => {
  const payload = JSON.stringify({
    items: [
      { item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM White Opal', product_type: 'THREADLESS_END' },
    ],
  });
  const items = await classifyLines(
    [{ vendor: 'NeoMetal', sku: 'X', description: 'Titanium Bezel - 4mm / White Opal', qty: 1, price: 20, gems: '', notes: '' }],
    { apiKey: 'test', fetchImpl: fakeAnthropic(payload) },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]!.product_type, 'THREADLESS_END');
  assert.equal(items[0]!.item_name, '18G 4MM Threadless Bezel-Set');
});
