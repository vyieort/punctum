// Square client — unit tests with an injected fake fetch (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  squareRequest,
  listLocations,
  searchItemByName,
  squareConfigFromEnv,
  type SquareConfig,
} from '../src/lib/square-client.js';

function fakeFetch(
  status: number,
  payload: unknown,
  capture?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => void,
): typeof globalThis.fetch {
  return (async (url: unknown, init: unknown) => {
    capture?.(String(url), init as { method: string; headers: Record<string, string>; body?: string });
    return {
      ok: status < 400,
      status,
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
    };
  }) as unknown as typeof globalThis.fetch;
}

const cfg = (over: Partial<SquareConfig> = {}): SquareConfig => ({
  token: 'TESTTOKEN',
  env: 'sandbox',
  locationId: 'L1',
  ...over,
});

function sequenceFetch(statuses: number[], payload: unknown): { fetchImpl: typeof globalThis.fetch; calls: () => number } {
  let i = 0;
  const fetchImpl = (async () => {
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls: () => i };
}

test('squareRequest retries on 429 (catalog locked) then succeeds', async () => {
  const seq = sequenceFetch([429, 429, 200], { ok: true });
  const r = await squareRequest(cfg({ fetchImpl: seq.fetchImpl, retryBaseMs: 1 }), '/v2/catalog/object', { method: 'POST', body: {} });
  assert.deepEqual(r, { ok: true });
  assert.equal(seq.calls(), 3); // two 429s retried, third succeeds
});

test('squareRequest gives up and throws after maxRetries of 429', async () => {
  const seq = sequenceFetch([429], {});
  await assert.rejects(
    () => squareRequest(cfg({ fetchImpl: seq.fetchImpl, retryBaseMs: 1, maxRetries: 2 }), '/v2/catalog/object', { method: 'POST', body: {} }),
    /Square 429/,
  );
  assert.equal(seq.calls(), 3); // initial + 2 retries
});

test('squareRequest hits the sandbox host with auth + version headers', async () => {
  let seenUrl = '';
  let seenInit!: { headers: Record<string, string> };
  const c = cfg({
    fetchImpl: fakeFetch(200, { ok: true }, (u, i) => {
      seenUrl = u;
      seenInit = i;
    }),
  });
  await squareRequest(c, '/v2/locations', { method: 'GET' });
  assert.equal(seenUrl, 'https://connect.squareupsandbox.com/v2/locations');
  assert.equal(seenInit.headers.authorization, 'Bearer TESTTOKEN');
  assert.equal(seenInit.headers['square-version'], '2026-01-22');
});

test('squareRequest uses the production host when env=production', async () => {
  let seenUrl = '';
  const c = cfg({ env: 'production', fetchImpl: fakeFetch(200, {}, (u) => (seenUrl = u)) });
  await squareRequest(c, '/v2/locations', { method: 'GET' });
  assert.match(seenUrl, /^https:\/\/connect\.squareup\.com\//);
});

test('squareRequest throws on non-2xx, surfacing the error payload', async () => {
  const c = cfg({ fetchImpl: fakeFetch(401, { errors: [{ detail: 'Unauthorized' }] }) });
  await assert.rejects(() => squareRequest(c, '/v2/locations', { method: 'GET' }), /Square 401.*Unauthorized/);
});

test('listLocations maps id + name', async () => {
  const c = cfg({ fetchImpl: fakeFetch(200, { locations: [{ id: 'L1', name: 'Punctum Sandbox', extra: 1 }] }) });
  assert.deepEqual(await listLocations(c), [{ id: 'L1', name: 'Punctum Sandbox' }]);
});

test('searchItemByName sends an exact_query on name', async () => {
  let body!: { object_types: string[]; query: { exact_query: { attribute_name: string; attribute_value: string } } };
  const c = cfg({
    fetchImpl: fakeFetch(200, { objects: [{ id: 'ITEM1' }] }, (_u, i) => (body = JSON.parse(i.body ?? '{}'))),
  });
  const objs = await searchItemByName(c, 'Muse Seam Ring');
  assert.equal(objs.length, 1);
  assert.deepEqual(body.object_types, ['ITEM']);
  assert.equal(body.query.exact_query.attribute_name, 'name');
  assert.equal(body.query.exact_query.attribute_value, 'Muse Seam Ring');
});

test('squareConfigFromEnv requires a token and defaults to sandbox', () => {
  assert.throws(() => squareConfigFromEnv({}), /SQUARE_ACCESS_TOKEN/);
  const c = squareConfigFromEnv({ SQUARE_ACCESS_TOKEN: 'X', SQUARE_LOCATION_ID: 'L9' });
  assert.equal(c.env, 'sandbox');
  assert.equal(c.locationId, 'L9');
});
