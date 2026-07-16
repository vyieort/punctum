// Per-tenant Square config + OAuth token auto-refresh. PGlite + injected refresh fn / clock.
process.env.TOKEN_ENC_KEY = 'a'.repeat(64); // must be set before crypto-box is used

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { saveSquareAccount, loadSquareConfig } from '../src/lib/square-account.js';
import type { SquareTokens } from '../src/auth/square-oauth.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(`insert into clients (id,name) values ('DB','Danforth Butchery')`);
  return db;
}

const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();
const day = 24 * 60 * 60 * 1000;
const tok = (over: Partial<SquareTokens> = {}): SquareTokens =>
  ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: null, merchantId: 'M', ...over });

test('loadSquareConfig returns the stored token when it is not near expiry', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await saveSquareAccount(q, 'DB', 'sandbox', tok({ accessToken: 'FRESH', expiresAt: iso(30 * day) }), 'LOC1');
  let refreshed = 0;
  const cfg = await loadSquareConfig(q, 'DB', { refresh: async () => { refreshed++; return tok(); } });
  assert.equal(cfg.token, 'FRESH');
  assert.equal(cfg.locationId, 'LOC1');
  assert.equal(cfg.env, 'sandbox');
  assert.equal(refreshed, 0); // healthy token -> no refresh
});

test('loadSquareConfig refreshes a near-expiry token and persists the new one', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await saveSquareAccount(q, 'DB', 'sandbox', tok({ accessToken: 'OLD', refreshToken: 'RT', expiresAt: iso(2 * day) }), 'LOC1');
  const cfg = await loadSquareConfig(q, 'DB', {
    refresh: async (rt, env) => {
      assert.equal(rt, 'RT'); // decrypted refresh token passed through
      assert.equal(env, 'sandbox');
      return tok({ accessToken: 'NEW', refreshToken: 'RT2', expiresAt: iso(30 * day) });
    },
  });
  assert.equal(cfg.token, 'NEW');
  // persisted: a second load (now healthy) must NOT refresh again
  const again = await loadSquareConfig(q, 'DB', {
    refresh: async () => { throw new Error('should not refresh a freshly-refreshed token'); },
  });
  assert.equal(again.token, 'NEW');
});

test('loadSquareConfig keeps the stored token if the refresh call fails', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await saveSquareAccount(q, 'DB', 'sandbox', tok({ accessToken: 'STALE', refreshToken: 'RT', expiresAt: iso(-1 * day) }), 'LOC1');
  const cfg = await loadSquareConfig(q, 'DB', { refresh: async () => { throw new Error('refresh_token revoked'); } });
  assert.equal(cfg.token, 'STALE'); // best-effort: never hard-break the pipeline
});

test('loadSquareConfig falls back to the env token when no account is connected', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  process.env.SQUARE_ACCESS_TOKEN = 'ENVTOK';
  process.env.SQUARE_LOCATION_ID = 'ENVLOC';
  process.env.SQUARE_ENV = 'sandbox';
  const cfg = await loadSquareConfig(q, 'DB');
  assert.equal(cfg.token, 'ENVTOK');
  assert.equal(cfg.locationId, 'ENVLOC');
});
