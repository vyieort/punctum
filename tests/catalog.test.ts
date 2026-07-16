// Catalog review page rendering + review-alternatives (read candidates, replace image, clear).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import {
  getCatalogRows,
  renderCatalogPage,
  getCandidates,
  setVariationImage,
  clearVariationImage,
  setItemImageFromRow,
  type ImageEditOps,
} from '../src/review/catalog.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0004_image_reject.sql'));
  await db.exec(mig('0005_image_candidates.sql'));
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

async function addRow(
  db: PGlite,
  o: { sku: string; vid: string; status: string; imageUrl?: string; imageId?: string; candidates?: string },
): Promise<string> {
  await db.query(
    `insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, tags, status, image_url, square_image_id, image_candidates)
     values ('RE','BVLA',$1,'ITEM1',$2,'18G Muse Seam Ring [BVLA 18g SMR]','R14K','BVLA 18g SMR',$3,$4,$5,$6)`,
    [o.sku, o.vid, o.status, o.imageUrl ?? null, o.imageId ?? null, o.candidates ?? null],
  );
  return (await db.query<{ seq: string }>(`select seq from catalog_mapping where vendor_sku=$1`, [o.sku])).rows[0]!.seq;
}

function fakeEditOps() {
  const calls = { deleted: [] as string[], downloaded: [] as string[], attached: 0, itemImageSet: [] as string[] };
  const ops: ImageEditOps = {
    deleteImage: async (id) => void calls.deleted.push(id),
    download: async (url) => {
      calls.downloaded.push(url);
      return { bytes: Buffer.from('img'), contentType: 'image/jpeg' };
    },
    attach: async () => {
      calls.attached++;
      return { imageId: 'IMG_NEW', url: 'https://sq/new.jpg' };
    },
    setItemImage: async (itemId, imageId) => void calls.itemImageSet.push(itemId + ':' + imageId),
  };
  return { ops, calls };
}

const CANDS = '[{"thumb":"https://t/1.jpg","pushUrl":"https://p/1.jpg"},{"thumb":"https://t/2.jpg","pushUrl":"https://p/2.jpg"}]';

test('getCatalogRows flags rows that kept a candidate pool', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1', candidates: CANDS });
  await addRow(db, { sku: 'S2', vid: 'V2', status: 'ENRICHED', imageUrl: 'https://p/x.jpg', imageId: 'IMGX' }); // no candidates (pre-feature)
  const rows = await getCatalogRows(db as unknown as Queryable, 'RE');
  const s1 = rows.find((r) => r.vendorSku === 'S1')!;
  const s2 = rows.find((r) => r.vendorSku === 'S2')!;
  assert.equal(s1.itemName, '18G Muse Seam Ring'); // suffix stripped
  assert.equal(s1.hasCandidates, true);
  assert.equal(s2.hasCandidates, false);
});

test('renderCatalogPage gives a thumbnail + Review-alternatives to rows with candidates', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1', candidates: CANDS });
  const html = renderCatalogPage(await getCatalogRows(db as unknown as Queryable, 'RE'));
  assert.match(html, /id="preview"/);
  assert.match(html, /class="thumb" src="https:\/\/p\/1\.jpg"/);
  assert.match(html, /class="alts" data-seq="/); // review-alternatives button
  assert.match(html, /id="gallery"/); // gallery container in the preview area
});

test('renderCatalogPage renders the edit grid: editable cells, category options, bulk bar', async () => {
  const db = await seeded();
  await db.exec(`insert into category_map (client_id, path, square_category_id) values ('RE','Threadless > Ends','CAT_X')`);
  await addRow(db, { sku: 'S1', vid: 'V1', status: 'PUSHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1' });
  const html = renderCatalogPage(await getCatalogRows(db as unknown as Queryable, 'RE'), ['Threadless > Ends', 'Curved > Barbells']);
  assert.match(html, /class="ename edit"[^>]*data-field="itemName"/); // editable name
  assert.match(html, /class="eprice edit"[^>]*data-field="retailPrice"/); // editable price
  assert.match(html, /class="ecat edit"[^>]*data-field="categoryPath"/); // category select
  assert.match(html, /<option value="Curved &gt; Barbells">/); // dropdown populated from paths
  assert.match(html, /id="pushbtn"/); // push-to-Square button
  assert.match(html, /id="bulkapply"/); // bulk-category control
  assert.match(html, /href="\/catalog\/edits"/); // link to the patterns report
  assert.match(html, /id="bulkphotos"/); // bulk-photo filmstrip trigger
  assert.match(html, /id="phototray"/); // filmstrip tray container
  assert.match(html, /data-sku="S1"/); // row carries data for filename matching
  assert.match(html, /class="sortable" data-key="retail"/); // sortable column headers
  assert.match(html, /data-wholesale=/); // rows carry sort values
});

test('renderCatalogPage flags + counts uncategorized rows', async () => {
  const db = await seeded();
  await addRow(db, { sku: 'CATTED', vid: 'V1', status: 'PUSHED' });
  await db.query(`update catalog_mapping set category_path='Threadless > Ends' where vendor_sku='CATTED'`);
  await addRow(db, { sku: 'BLANKCAT', vid: 'V2', status: 'PUSHED' }); // no category_path -> uncategorized
  const html = renderCatalogPage(await getCatalogRows(db as unknown as Queryable, 'RE'), ['Threadless > Ends']);
  assert.match(html, /1 need a category/); // only the blank one
  assert.match(html, /class="catwarn"/); // per-row warning marker
  assert.match(html, /class="needsattn"/); // row highlight
});

test('getCandidates returns the parsed pool + the base item name', async () => {
  const db = await seeded();
  const seq = await addRow(db, { sku: 'S1', vid: 'V1', status: 'NO_IMAGE', candidates: CANDS });
  const r = await getCandidates(db as unknown as Queryable, 'RE', seq);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[1]!.pushUrl, 'https://p/2.jpg');
  assert.equal(r.itemName, '18G Muse Seam Ring');
});

test('setVariationImage swaps the Square image and marks ENRICHED', async () => {
  const db = await seeded();
  const seq = await addRow(db, { sku: 'S1', vid: 'V1', status: 'NO_IMAGE', imageId: 'IMG_OLD', candidates: CANDS });
  const { ops, calls } = fakeEditOps();
  const r = await setVariationImage(db as unknown as Queryable, 'RE', seq, 'https://p/2.jpg', 'https://t/2.jpg', { ops });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.deleted, ['IMG_OLD']); // old image removed first
  assert.deepEqual(calls.downloaded, ['https://p/2.jpg']);
  assert.equal(calls.attached, 1);
  const row = (
    await db.query<{ status: string; image_url: string; square_image_id: string }>(
      `select status, image_url, square_image_id from catalog_mapping where vendor_sku='S1'`,
    )
  ).rows[0]!;
  assert.equal(row.status, 'ENRICHED');
  assert.equal(row.image_url, 'https://p/2.jpg');
  assert.equal(row.square_image_id, 'IMG_NEW');
});

test('clearVariationImage removes the image and marks NO_IMAGE', async () => {
  const db = await seeded();
  const seq = await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1', candidates: CANDS });
  const { ops, calls } = fakeEditOps();
  const r = await clearVariationImage(db as unknown as Queryable, 'RE', seq, { ops });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.deleted, ['IMG1']);
  const row = (
    await db.query<{ status: string; image_url: string | null; square_image_id: string | null }>(
      `select status, image_url, square_image_id from catalog_mapping where vendor_sku='S1'`,
    )
  ).rows[0]!;
  assert.equal(row.status, 'NO_IMAGE');
  assert.equal(row.image_url, null);
  assert.equal(row.square_image_id, null);
});

test('setItemImageFromRow promotes the variation image to the item primary', async () => {
  const db = await seeded();
  const seq = await addRow(db, { sku: 'S1', vid: 'V1', status: 'ENRICHED', imageUrl: 'https://p/1.jpg', imageId: 'IMG1', candidates: CANDS });
  const { ops, calls } = fakeEditOps();
  const r = await setItemImageFromRow(db as unknown as Queryable, 'RE', seq, { ops });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.itemImageSet, ['ITEM1:IMG1']); // item ITEM1 gets the variation's image
});

test('setItemImageFromRow is a no-op when the row has no stored image', async () => {
  const db = await seeded();
  const seq = await addRow(db, { sku: 'S2', vid: 'V2', status: 'NO_IMAGE' }); // no square_image_id
  const { ops, calls } = fakeEditOps();
  const r = await setItemImageFromRow(db as unknown as Queryable, 'RE', seq, { ops });
  assert.equal(r.ok, false);
  assert.equal(calls.itemImageSet.length, 0);
});

test('setVariationImage on an unknown row is a no-op', async () => {
  const db = await seeded();
  const { ops } = fakeEditOps();
  const r = await setVariationImage(db as unknown as Queryable, 'RE', '999999', 'https://p/2.jpg', 'https://t/2.jpg', { ops });
  assert.equal(r.ok, false);
});
