// Migration 0016: rename the legacy 'RE' tenant key to 'danforth-butchery'. The key thing to prove
// is that children are REPOINTED (not deleted by the ON DELETE CASCADE) when the old row is removed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function base(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql')); // clients, client_config, category_map, invoices, catalog_mapping, square_accounts
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(mig('0011_client_members.sql'));
  return db;
}

test('0016 repoints every child table from RE to danforth-butchery and drops the old row', async () => {
  const db = await base();
  await db.exec(`insert into clients (id,name) values ('RE','Danforth Butchery')`);
  await db.exec(`insert into client_config (client_id) values ('RE')`);
  await db.exec(`insert into category_map (client_id, path, square_category_id) values ('RE','Navels','CAT1')`);
  await db.exec(`insert into client_members (user_id, client_id) values ('11111111-1111-1111-1111-111111111111','RE')`);

  await db.exec(mig('0016_rename_client_key_danforth.sql'));

  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from clients where id='RE'`)).rows[0]!.n, 0);
  const c = await db.query<{ name: string }>(`select name from clients where id='danforth-butchery'`);
  assert.equal(c.rows[0]!.name, 'Danforth Butchery');
  // children survived the cascade and now point at the new id
  assert.equal((await db.query<{ client_id: string }>(`select client_id from category_map`)).rows[0]!.client_id, 'danforth-butchery');
  assert.equal((await db.query<{ client_id: string }>(`select client_id from client_members`)).rows[0]!.client_id, 'danforth-butchery');
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from client_config where client_id='danforth-butchery'`)).rows[0]!.n, 1);
});

test('0016 is a safe no-op when there is no legacy RE tenant', async () => {
  const db = await base();
  await db.exec(mig('0016_rename_client_key_danforth.sql')); // must not throw
  assert.equal((await db.query<{ n: number }>(`select count(*)::int n from clients`)).rows[0]!.n, 0);
});
