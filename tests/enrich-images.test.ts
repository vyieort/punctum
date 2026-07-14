// Image-enrichment orchestrator: enrich / no-image / skip-existing / error, against PGlite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { enrichImages, type EnrichOps } from '../src/jobs/enrich-images.js';
import type { ImageCandidate } from '../src/lib/serpapi.js';
import type { VisionResult } from '../src/lib/vision.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0004_image_reject.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

async function addRow(db: PGlite, sku: string, vid: string): Promise<void> {
  await db.query(
    `insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, item_description, status)
     values ('RE','BVLA',$1,'ITEM1',$2,'18G Muse Seam Ring [BVLA 18g SMR]','R14K','18g Muse Seam Ring','PENDING')`,
    [sku, vid],
  );
}

interface FakeCfg {
  existingImages?: string[];
  candidates?: ImageCandidate[];
  vision?: VisionResult;
  throwOnSearch?: boolean;
}

function fakeOps(cfg: FakeCfg = {}) {
  const calls = { search: 0, score: 0, download: 0, attach: 0 };
  const ops: EnrichOps = {
    variationImageIds: async () => cfg.existingImages ?? [],
    search: async () => {
      calls.search++;
      if (cfg.throwOnSearch) throw new Error('serp down');
      return cfg.candidates ?? [{ thumb: 'https://t/1.jpg', pushUrl: 'https://p/1.jpg', domain: 'x' }];
    },
    score: async () => {
      calls.score++;
      return cfg.vision ?? { match: 1, confidence: 8, reason: 'ok', action: 'ENRICHED', imageUrl: 'https://p/1.jpg' };
    },
    download: async () => {
      calls.download++;
      return { bytes: Buffer.from('img'), contentType: 'image/jpeg' };
    },
    attach: async () => {
      calls.attach++;
      return { imageId: 'IMG1', url: 'https://sq/img.jpg' };
    },
  };
  return { ops, calls };
}

const statusOf = async (db: PGlite, sku: string) =>
  (await db.query<{ status: string; image_url: string | null }>(
    `select status, image_url from catalog_mapping where client_id='RE' and vendor_sku=$1`,
    [sku],
  )).rows[0]!;

test('confident match: downloads, attaches, sets ENRICHED + image_url', async () => {
  const db = await seeded();
  await addRow(db, 'S1', 'V1');
  const { ops, calls } = fakeOps();
  const r = await enrichImages(db as unknown as Queryable, 'RE', { ops });
  assert.equal(r.enriched, 1);
  assert.equal(calls.attach, 1);
  const row = await statusOf(db, 'S1');
  assert.equal(row.status, 'ENRICHED');
  assert.equal(row.image_url, 'https://p/1.jpg');
});

test('weak match: sets NO_IMAGE and never attaches', async () => {
  const db = await seeded();
  await addRow(db, 'S1', 'V1');
  const { ops, calls } = fakeOps({ vision: { match: 0, confidence: 2, reason: 'none', action: 'NO_IMAGE', imageUrl: '' } });
  const r = await enrichImages(db as unknown as Queryable, 'RE', { ops });
  assert.equal(r.noImage, 1);
  assert.equal(calls.attach, 0);
  assert.equal((await statusOf(db, 'S1')).status, 'NO_IMAGE');
});

test('variation already has an image: skipped, no search, marked ENRICHED', async () => {
  const db = await seeded();
  await addRow(db, 'S1', 'V1');
  const { ops, calls } = fakeOps({ existingImages: ['IMG_EXISTING'] });
  const r = await enrichImages(db as unknown as Queryable, 'RE', { ops });
  assert.equal(r.skipped, 1);
  assert.equal(calls.search, 0); // no SerpAPI/Vision spend
  assert.equal((await statusOf(db, 'S1')).status, 'ENRICHED');
});

test('one row failing is recorded but does not stop the batch', async () => {
  const db = await seeded();
  await addRow(db, 'S1', 'V1');
  await addRow(db, 'S2', 'V2');
  // First row throws on search; second row succeeds.
  let first = true;
  const { ops } = fakeOps();
  const wrapped: EnrichOps = {
    ...ops,
    search: async (q) => {
      if (first) {
        first = false;
        throw new Error('serp down');
      }
      return ops.search(q);
    },
  };
  const r = await enrichImages(db as unknown as Queryable, 'RE', { ops: wrapped });
  assert.equal(r.processed, 2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.enriched, 1); // the second row still went through
});

test('only PENDING rows with a variation id are processed', async () => {
  const db = await seeded();
  await addRow(db, 'S1', 'V1');
  await db.query(`update catalog_mapping set status='ENRICHED' where vendor_sku='S1'`); // already done
  await addRow(db, 'S2', ''); // no variation id yet
  const { ops } = fakeOps();
  const r = await enrichImages(db as unknown as Queryable, 'RE', { ops });
  assert.equal(r.processed, 0);
});
