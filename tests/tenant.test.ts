// Tenant resolution + cookie parsing for the auth foundation. PGlite for the DB lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { resolveClientForUser, parseCookies } from '../src/auth/tenant.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0011_client_members.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution'),('CX','Client X')`);
  await db.exec(`insert into client_members (user_id, client_id, email) values
    ('${U1}','RE','owner@ritual.co'),
    ('${U2}','CX','owner@clientx.co')`);
  return db;
}

test('resolveClientForUser maps a user to their tenant', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  assert.equal(await resolveClientForUser(q, U1), 'RE');
  assert.equal(await resolveClientForUser(q, U2), 'CX');
  assert.equal(await resolveClientForUser(q, '99999999-9999-9999-9999-999999999999'), null); // unknown user
  assert.equal(await resolveClientForUser(q, ''), null);
});

test('parseCookies reads a Cookie header into a map', () => {
  assert.deepEqual(parseCookies('sb_access=abc; sb_refresh=def%20ghi'), { sb_access: 'abc', sb_refresh: 'def ghi' });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('junk'), {});
});
