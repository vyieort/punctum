// Per-client Square OAuth: token encryption, authorize URL + code exchange, and account storage.

process.env.TOKEN_ENC_KEY = '0'.repeat(64); // set before square-account decrypts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { encryptSecret, decryptSecret } from '../src/lib/crypto-box.js';
import { squareAuthorizeUrl, exchangeCode, type OAuthConfig } from '../src/auth/square-oauth.js';
import { saveSquareAccount, loadSquareConfig, getSquareConnection } from '../src/lib/square-account.js';

const KEY = Buffer.alloc(32, 7);

test('crypto-box round-trips and rejects a wrong key / tamper', () => {
  const c = encryptSecret('sq-access-token', KEY);
  assert.notEqual(c, 'sq-access-token');
  assert.equal(decryptSecret(c, KEY), 'sq-access-token');
  assert.notEqual(encryptSecret('x', KEY), encryptSecret('x', KEY)); // random iv
  assert.throws(() => decryptSecret(c, Buffer.alloc(32, 9)));
});

const cfg = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  appId: 'app', appSecret: 'sec', env: 'sandbox', redirectUri: 'https://x/oauth/square/callback', ...over,
});

test('squareAuthorizeUrl targets the sandbox host with scopes + state', () => {
  const u = squareAuthorizeUrl(cfg(), 'STATE1');
  assert.match(u, /connect\.squareupsandbox\.com\/oauth2\/authorize/);
  assert.match(u, /client_id=app/);
  assert.match(u, /state=STATE1/);
  assert.match(u, /ITEMS_WRITE/);
});

test('exchangeCode posts the authorization_code grant and returns tokens', async () => {
  let seen: Record<string, unknown> = {};
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_at: '2026-08-01T00:00:00Z', merchant_id: 'M1' }) };
  }) as unknown as typeof globalThis.fetch;
  const t = await exchangeCode(cfg({ fetchImpl }), 'CODE');
  assert.equal(t.accessToken, 'AT');
  assert.equal(t.refreshToken, 'RT');
  assert.equal(t.merchantId, 'M1');
  assert.equal(seen.grant_type, 'authorization_code');
  assert.equal(seen.code, 'CODE');
});

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(readFileSync(new URL('../db/migrations/0001_init.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

test('saveSquareAccount stores tokens encrypted; loadSquareConfig decrypts to a tenant config', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await saveSquareAccount(q, 'RE', 'sandbox', { accessToken: 'AT', refreshToken: 'RT', expiresAt: null, merchantId: 'M1' }, 'LOC1');

  const cfgOut = await loadSquareConfig(q, 'RE');
  assert.equal(cfgOut.token, 'AT');
  assert.equal(cfgOut.env, 'sandbox');
  assert.equal(cfgOut.locationId, 'LOC1');

  const conn = await getSquareConnection(q, 'RE');
  assert.equal(conn.connected, true);
  assert.equal(conn.merchantId, 'M1');
  assert.equal(conn.locationId, 'LOC1');

  const stored = (await db.query<{ t: string }>(`select access_token as t from square_accounts where client_id='RE'`)).rows[0]!.t;
  assert.notEqual(stored, 'AT'); // encrypted at rest
});

test('getSquareConnection reports not-connected before any OAuth', async () => {
  const db = await seeded();
  const conn = await getSquareConnection(db as unknown as Queryable, 'RE');
  assert.equal(conn.connected, false);
});
