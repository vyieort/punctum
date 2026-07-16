// Own-photo upload attach + the item detail view. PGlite + fake image ops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { uploadVariationImage, uploadItemImage, clearItemImageForItem, type ImageEditOps } from '../src/review/catalog.js';
import { getItemDetail, renderItemPage, getVariationDetail, renderVariationPage } from '../src/review/item-detail.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0004_image_reject.sql'));
  await db.exec(mig('0005_image_candidates.sql'));
  await db.exec(mig('0009_catalog_edits.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, retail_price, category_path, status) values
    ('RE','BVLA','SKU-1','ITEM1','V1','8mm Pleades [BVLA]','Yellow Gold',130.00,'Ends','NO_IMAGE'),
    ('RE','BVLA','SKU-2','ITEM1','V2','8mm Pleades [BVLA]','Rose Gold',130.00,'Ends','ENRICHED')`);
  await db.exec(`update catalog_mapping set image_url='https://x/rose.jpg', square_image_id='IMG_OLD' where vendor_sku='SKU-2'`);
  return db;
}

function fakeOps(existingItemImages: string[] = []) {
  const calls: { deleted: string[]; attached: Array<{ variationId: string; bytes: number; ct?: string }>; itemSet: Array<[string, string]>; itemCleared: string[] } = { deleted: [], attached: [], itemSet: [], itemCleared: [] };
  const ops: ImageEditOps = {
    deleteImage: async (id) => { calls.deleted.push(id); },
    download: async () => ({ bytes: Buffer.from(''), contentType: 'image/jpeg' }),
    attach: async (o) => { calls.attached.push({ variationId: o.variationId, bytes: o.bytes.length, ct: o.contentType }); return { imageId: 'IMG_NEW', url: 'https://sq/new.jpg' }; },
    setItemImage: async (itemId, imageId) => { calls.itemSet.push([itemId, imageId]); },
    itemImageIds: async () => existingItemImages.slice(),
    clearItemImage: async (itemId) => { calls.itemCleared.push(itemId); },
  };
  return { ops, calls };
}

const seqFor = async (db: PGlite, sku: string): Promise<string> =>
  (await db.query<{ seq: string }>(`select seq::text as seq from catalog_mapping where vendor_sku=$1`, [sku])).rows[0]!.seq;

test('uploadVariationImage attaches uploaded bytes and records the Square image', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, calls } = fakeOps();
  const seq = await seqFor(db, 'SKU-1');
  const r = await uploadVariationImage(q, 'RE', seq, { bytes: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' }, { ops });
  assert.equal(r.ok, true);
  assert.equal(calls.attached.length, 1);
  assert.equal(calls.attached[0]!.variationId, 'V1');
  const row = (await db.query<{ status: string; url: string; img: string }>(`select status::text as status, image_url as url, square_image_id as img from catalog_mapping where vendor_sku='SKU-1'`)).rows[0]!;
  assert.equal(row.status, 'ENRICHED');
  assert.equal(row.url, 'https://sq/new.jpg');
  assert.equal(row.img, 'IMG_NEW');
});

test('uploadVariationImage replaces an existing image (delete then attach) and can set item image', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, calls } = fakeOps();
  const seq = await seqFor(db, 'SKU-2');
  const r = await uploadVariationImage(q, 'RE', seq, { bytes: Buffer.from('PNGDATA'), contentType: 'image/png' }, { ops, setItem: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.deleted, ['IMG_OLD']); // replaced the prior image
  assert.deepEqual(calls.itemSet, [['ITEM1', 'IMG_NEW']]); // promoted to item image
});

test('uploadVariationImage rejects a non-image type', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeOps();
  const seq = await seqFor(db, 'SKU-1');
  const r = await uploadVariationImage(q, 'RE', seq, { bytes: Buffer.from('%PDF'), contentType: 'application/pdf' }, { ops });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /unsupported/);
});

test('getItemDetail groups variations under one item; renderItemPage shows uploads', async () => {
  const db = await seeded();
  const item = await getItemDetail(db as unknown as Queryable, 'RE', 'ITEM1');
  assert.ok(item);
  assert.equal(item!.itemName, '8mm Pleades'); // tag suffix stripped
  assert.equal(item!.variations.length, 2);
  const html = renderItemPage(item!);
  assert.match(html, /8mm Pleades/);
  assert.match(html, /type="file"/); // per-variation upload control
  assert.match(html, /\/variations\//); // links down to variation detail
  assert.match(html, /← Catalog/); // breadcrumb up
});

test('renderItemPage shows item-photo controls and uses the item image as hero when provided', async () => {
  const db = await seeded();
  const item = await getItemDetail(db as unknown as Queryable, 'RE', 'ITEM1');
  const html = renderItemPage(item!, 'https://sq/itemhero.jpg');
  assert.match(html, /id="itemfile"/); // item-level upload control
  assert.match(html, /upload-item-image/); // wired to the item photo route
  assert.match(html, /https:\/\/sq\/itemhero\.jpg/); // item image wins over variation-derived hero
});

test('uploadItemImage attaches to the item object, sets it primary, and deletes the old item image', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, calls } = fakeOps(['IMG_ITEM_OLD']);
  const r = await uploadItemImage(q, 'RE', 'ITEM1', { bytes: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' }, { ops });
  assert.equal(r.ok, true);
  assert.equal(calls.attached.length, 1);
  assert.equal(calls.attached[0]!.variationId, 'ITEM1'); // object_id is the item, not a variation
  assert.deepEqual(calls.itemSet, [['ITEM1', 'IMG_NEW']]); // new image made primary
  assert.deepEqual(calls.deleted, ['IMG_ITEM_OLD']); // prior item image removed, no orphan
});

test('uploadItemImage rejects a non-image type', async () => {
  const db = await seeded();
  const { ops } = fakeOps();
  const r = await uploadItemImage(db as unknown as Queryable, 'RE', 'ITEM1', { bytes: Buffer.from('%PDF'), contentType: 'application/pdf' }, { ops });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /unsupported/);
});

test('clearItemImageForItem clears the primary and deletes the underlying image objects', async () => {
  const db = await seeded();
  const { ops, calls } = fakeOps(['IMG_A', 'IMG_B']);
  const r = await clearItemImageForItem(db as unknown as Queryable, 'RE', 'ITEM1', { ops });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.itemCleared, ['ITEM1']);
  assert.deepEqual(calls.deleted, ['IMG_A', 'IMG_B']);
});

test('getVariationDetail + renderVariationPage show one SKU with editable fields', async () => {
  const db = await seeded();
  const seq = await seqFor(db, 'SKU-2');
  const v = await getVariationDetail(db as unknown as Queryable, 'RE', seq);
  assert.ok(v);
  assert.equal(v!.variationName, 'Rose Gold');
  assert.equal(v!.itemName, '8mm Pleades');
  assert.equal(v!.squareItemId, 'ITEM1');
  const html = renderVariationPage(v!);
  assert.match(html, /Rose Gold/);
  assert.match(html, /id="vname"/); // editable variation name
  assert.match(html, /id="price"/); // editable price
  assert.match(html, /id="file"/); // photo upload
  assert.match(html, /\/items\/ITEM1/); // breadcrumb up to the item
});
