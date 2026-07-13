// Category provisioning — parent-first creation + category_map re-seed, PGlite + fake creator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import type { SquareConfig } from '../src/lib/square-client.js';
import { provisionCategories } from '../src/jobs/provision-categories.js';
import { categoryTree } from '../src/lib/taxonomy.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const cfg: SquareConfig = { token: 'x', env: 'sandbox', locationId: 'L' };

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

test('provisionCategories creates every node parent-first and re-seeds category_map', async () => {
  const db = await seeded();
  const createdIds = new Set<string>();
  let n = 0;
  const create = async (_c: SquareConfig, o: { name: string; parentId?: string | null }): Promise<string> => {
    if (o.parentId) assert.ok(createdIds.has(o.parentId), 'parent must be created before its child');
    const id = 'CID_' + n++;
    createdIds.add(id);
    return id;
  };

  const r = await provisionCategories(cfg, db as unknown as Queryable, 'RE', { create });

  assert.equal(r.created, categoryTree().length);
  const cnt = await db.query<{ n: number }>(`select count(*)::int as n from category_map where client_id='RE'`);
  assert.equal(cnt.rows[0]!.n, r.created);
  const leaf = await db.query<{ id: string }>(
    `select square_category_id as id from category_map where client_id='RE' and path='Threadless > Threadless Ends > Bezel-Set'`,
  );
  assert.match(leaf.rows[0]!.id, /^CID_/);
});

test('provisionCategories upserts category_map (updates existing paths, no duplicates)', async () => {
  const db = await seeded();
  await db.exec(`insert into category_map (client_id, path, square_category_id) values ('RE','Vendors > BVLA','OLD_ID')`);
  let i = 0;
  const create = async (): Promise<string> => 'NEW_' + i++;

  await provisionCategories(cfg, db as unknown as Queryable, 'RE', { create });

  const row = await db.query<{ id: string }>(
    `select square_category_id as id from category_map where client_id='RE' and path='Vendors > BVLA'`,
  );
  assert.match(row.rows[0]!.id, /^NEW_/); // updated in place
  const dupes = await db.query<{ n: number }>(
    `select count(*)::int as n from category_map where client_id='RE' and path='Vendors > BVLA'`,
  );
  assert.equal(dupes.rows[0]!.n, 1);
});
