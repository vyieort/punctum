// Integration test for the Postgres-backed tag job, run against real Postgres via PGlite
// (WASM Postgres, no server). Applies the actual schema migration, seeds PENDING rows,
// runs the real tagger through the pg adapter, and checks the write-back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { runTagGeneration } from '../src/jobs/tags.generate.js';
import { PgRowSource, PgRowSink, type Queryable } from '../src/jobs/pg-rows.js';

const schema = readFileSync(new URL('../db/migrations/0001_init.sql', import.meta.url), 'utf8');

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(`insert into clients (id, name) values ('RE', 'Ritual Evolution')`);
  return db;
}

test('pg adapter: tags a PENDING catalog group and writes TAGGED back', async () => {
  const db = await freshDb();
  await db.exec(`
    insert into catalog_mapping (client_id, vendor, square_item_id, item_name, variation_name, status) values
      ('RE','BVLA','CID1','20g Seam Ring','7/32" RG14K','PENDING'),
      ('RE','BVLA','CID1','20g Seam Ring','5/16" WG14K','PENDING'),
      ('RE','BVLA','CID1','20g Seam Ring','3/8" YG14K','PENDING')
  `);
  const q = db as unknown as Queryable;

  const summary = await runTagGeneration(new PgRowSource(q, 'RE'), new PgRowSink(q, 'RE'));
  assert.equal(summary.groupsProcessed, 1);
  assert.equal(summary.rowsUpdated, 3);

  const { rows } = await db.query<{ status: string; tags: string }>(
    `select status, tags from catalog_mapping where square_item_id = 'CID1' order by seq`,
  );
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.status, 'TAGGED');
    assert.equal(r.tags, 'BVLA 20g SMR RG WG YG');
  }
});

test('pg adapter: only PENDING rows are touched; other clients untouched', async () => {
  const db = await freshDb();
  await db.exec(`insert into clients (id, name) values ('OTHER', 'Other Studio')`);
  await db.exec(`
    insert into catalog_mapping (client_id, vendor, square_item_id, item_name, variation_name, status, tags) values
      ('RE','Anatometal','CID2','14g Straight Barbell','Titanium','PENDING',null),
      ('RE','Anatometal','CID3','Threadless Disk','3MM Yellow 14K','ENRICHED','DK TL'),
      ('OTHER','BVLA','CID4','18g Seam Ring','RG14K','PENDING',null)
  `);
  const q = db as unknown as Queryable;

  const summary = await runTagGeneration(new PgRowSource(q, 'RE'), new PgRowSink(q, 'RE'));
  assert.equal(summary.groupsProcessed, 1); // only RE's CID2 (CID3 already ENRICHED)
  assert.equal(summary.rowsUpdated, 1);

  const enriched = await db.query<{ status: string; tags: string }>(`select status, tags from catalog_mapping where square_item_id='CID3'`);
  assert.equal(enriched.rows[0].status, 'ENRICHED'); // untouched
  assert.equal(enriched.rows[0].tags, 'DK TL');

  const other = await db.query<{ status: string }>(`select status from catalog_mapping where client_id='OTHER'`);
  assert.equal(other.rows[0].status, 'PENDING'); // other tenant untouched

  const tagged = await db.query<{ tags: string }>(`select tags from catalog_mapping where square_item_id='CID2'`);
  assert.equal(tagged.rows[0].tags, 'ANA 14g BBL TI TD');
});
