// Catalog review page rendering + image reject (delete from Square, re-queue excluding it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getCatalogRows, renderCatalogPage, rejectImage, type RejectOps } from '../src/review/catalog.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0004_image_reject.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

async function addRow(
  db: PGlite,
  o: { sku: string; vid: string; status: string; imageUrl?: string; imageId?: string },
): Promise<void> {
  await db.query(
    `insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, tags, status, image_url, square_image_id)
     values ('RE','BVLA',$1,'ITEM1',$2,'18G Muse Seam Ring [BVLA 18g SMR]','R14K','BVLA 18g SMR',$3,$4,$5)`,
    [o.sku, o.vid, o.status, o.imageUrl ?? null, o.imageId ?? null],
  );
}

test('getCatalogRows strips the tag suffix and returns the image url', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1' });
  const rows = await getCatalogRows(db as unknown as Queryable, 'RE');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.itemName, '18G Muse Seam Ring'); // suffix stripped
  assert.equal(rows[0]!.tags, 'BVLA 18g SMR');
  assert.equal(rows[0]!.imageUrl, 'https://p/1.jpg');
});

test('renderCatalogPage gives imaged rows a Show + Reject; no-image rows get neither', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1' });
  await addRow(db, { sku: 'S2', vid: 'V2', status: 'NO_IMAGE' });
  const html = renderCatalogPage(await getCatalogRows(db as unknown as Queryable, 'RE'));
  assert.match(html, /id="preview"/); // sticky 500x500 preview pane
  assert.match(html, /class="thumb" src="https:\/\/p\/1\.jpg" data-url="https:\/\/p\/1\.jpg"/); // clickable row thumbnail
  assert.match(html, /class="rej" data-seq="/); // reject button
  assert.match(html, /1 ENRICHED/);
  assert.match(html, /1 NO_IMAGE/);
  // only the one imaged row gets a thumbnail
  assert.equal((html.match(/class="thumb"/g) ?? []).length, 1);
});

test('rejectImage deletes the Square image, re-queues PENDING, records the rejected url', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/bad.jpg', imageId: 'IMG1' });
  const seq = (await db.query<{ seq: string }>(`select seq from catalog_mapping where vendor_sku='S1'`)).rows[0]!.seq;

  const deleted: string[] = [];
  const ops: RejectOps = { deleteImage: async (id) => void deleted.push(id) };
  const r = await rejectImage(db as unknown as Queryable, 'RE', String(seq), { ops });
  assert.equal(r.rejected, true);
  assert.deepEqual(deleted, ['IMG1']); // wrong image removed from Square

  const row = (
    await db.query<{ status: string; image_url: string | null; rejected_image_urls: string | null; square_image_id: string | null }>(
      `select status, image_url, rejected_image_urls, square_image_id from catalog_mapping where vendor_sku='S1'`,
    )
  ).rows[0]!;
  assert.equal(row.status, 'PENDING'); // re-queued
  assert.equal(row.image_url, null);
  assert.equal(row.square_image_id, null);
  assert.match(row.rejected_image_urls ?? '', /https:\/\/p\/bad\.jpg/); // remembered so re-enrich skips it
});

test('rejectImage on an unknown row is a no-op', async () => {
  const db = await seeded();
  const ops: RejectOps = { deleteImage: async () => {} };
  const r = await rejectImage(db as unknown as Queryable, 'RE', '999999', { ops });
  assert.equal(r.rejected, false);
});
