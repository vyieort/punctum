// Self-serve signup: gotrue signUp response handling (injected fetch) + tenant provisioning (PGlite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { signUp } from '../src/auth/gotrue.js';
import { provisionTenant, genClientId } from '../src/auth/provision.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

function fakeFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof globalThis.fetch;
}
const cfg = (status: number, body: unknown) => ({ url: 'https://x.supabase.co', anonKey: 'anon', fetchImpl: fakeFetch(status, body) });

test('signUp returns tokens + userId when the project auto-confirms', async () => {
  const r = await signUp('a@b.co', 'pw', cfg(200, {
    access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { id: 'U1', email: 'a@b.co' },
  }));
  assert.equal(r.userId, 'U1');
  assert.equal(r.email, 'a@b.co');
  assert.ok(r.tokens);
  assert.equal(r.tokens!.accessToken, 'AT');
});

test('signUp returns tokens=null when email confirmation is required (bare user shape)', async () => {
  const r = await signUp('a@b.co', 'pw', cfg(200, { id: 'U2', email: 'a@b.co' }));
  assert.equal(r.userId, 'U2');
  assert.equal(r.tokens, null);
});

test('signUp throws on an error response', async () => {
  await assert.rejects(signUp('a@b.co', 'pw', cfg(400, { msg: 'User already registered' })), /already registered/);
});

test('genClientId slugifies the studio name with a short random suffix', () => {
  assert.match(genClientId('Danforth Butchery'), /^danforth-butchery-[0-9a-f]{6}$/);
  assert.match(genClientId('  Ace/Body Piercing!! '), /^ace-body-piercing-[0-9a-f]{6}$/);
  assert.match(genClientId(''), /^studio-[0-9a-f]{6}$/);
});

const U1 = '11111111-1111-1111-1111-111111111111';

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0011_client_members.sql'));
  await db.exec(mig('0017_inbound_email_token.sql'));
  return db;
}

test('provisionTenant creates a client, default config, and an owner membership', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await provisionTenant(q, { userId: U1, studioName: 'Acme Piercing', email: 'o@acme.co' });
  assert.equal(r.created, true);
  assert.match(r.clientId, /^acme-piercing-[0-9a-f]{6}$/);

  const c = await db.query<{ name: string; contact_email: string }>(`select name, contact_email from clients where id=$1`, [r.clientId]);
  assert.equal(c.rows[0]!.name, 'Acme Piercing');
  assert.equal(c.rows[0]!.contact_email, 'o@acme.co');

  const cfgRow = await db.query<{ pricing_rules: unknown }>(`select pricing_rules from client_config where client_id=$1`, [r.clientId]);
  assert.ok(cfgRow.rows[0]!.pricing_rules, 'default pricing rules seeded');

  const mem = await db.query<{ role: string }>(`select role from client_members where user_id=$1 and client_id=$2`, [U1, r.clientId]);
  assert.equal(mem.rows[0]!.role, 'owner');
});

test('provisionTenant is idempotent per user — no second studio on retry', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const a = await provisionTenant(q, { userId: U1, studioName: 'First' });
  const b = await provisionTenant(q, { userId: U1, studioName: 'Second attempt' });
  assert.equal(b.created, false);
  assert.equal(b.clientId, a.clientId);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int as n from client_members where user_id=$1`, [U1])).rows[0]!.n, 1);
  assert.equal((await db.query<{ n: number }>(`select count(*)::int as n from clients`)).rows[0]!.n, 1);
});
