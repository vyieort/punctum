// syncLibraryItemIds: backfill square_item_id from the live Square catalog. PGlite + fake catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { syncLibraryItemIds, type LibrarySyncOps } from '../src/jobs/library-sync.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  // Two rows need an item id (VAR1 known, VARX not in the catalog); one already has an id.
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_variation_id, item_name, status) values
    ('RE','A','S1','VAR1','Item One','PUSHED'),
    ('RE','B','S2','VAR3','Item Two','PUSHED'),
    ('RE','C','S3','VARX','Orphan','PUSHED')`);
  await db.exec(`update catalog_mapping set square_item_id='ALREADY' where square_variation_id='VAR3'`);
  return db;
}

const catalog: LibrarySyncOps = {
  listItems: async () => [
    { id: 'ITEM_A', item_data: { variations: [{ id: 'VAR1' }, { id: 'VAR2' }] } },
    { id: 'ITEM_B', item_data: { variations: [{ id: 'VAR3' }] } },
  ],
};

test('syncLibraryItemIds fills square_item_id for rows missing it, matched by variation id', async () => {
  const db = await seeded();
  const r = await syncLibraryItemIds(db, 'RE', { ops: catalog });
  assert.equal(r.needing, 2); // VAR1 + VARX (VAR3 already had an id)
  assert.equal(r.matched, 1); // only VAR1 is in the catalog
  assert.equal(r.updated, 1);

  const rows = (await db.query<{ sku: string; iid: string | null }>(
    `select vendor_sku as sku, square_item_id as iid from catalog_mapping where client_id='RE' order by vendor_sku`,
  )).rows;
  assert.equal(rows.find((x) => x.sku === 'S1')!.iid, 'ITEM_A'); // backfilled
  assert.equal(rows.find((x) => x.sku === 'S2')!.iid, 'ALREADY'); // untouched
  assert.equal(rows.find((x) => x.sku === 'S3')!.iid, null); // orphan stays null
});

test('syncLibraryItemIds is a no-op on a second run', async () => {
  const db = await seeded();
  await syncLibraryItemIds(db, 'RE', { ops: catalog });
  const r2 = await syncLibraryItemIds(db, 'RE', { ops: catalog });
  assert.equal(r2.needing, 1); // only the orphan remains
  assert.equal(r2.updated, 0);
});
