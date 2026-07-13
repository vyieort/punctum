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
