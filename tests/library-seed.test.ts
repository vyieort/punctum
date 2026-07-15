// seedLibrary: token-keyed upsert into catalog_mapping, blank-SKU generation, PUSHED status. PGlite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { seedLibrary } from '../src/jobs/library-seed.js';
import type { LibraryRow } from '../src/lib/library-import.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

const lrow = (o: Partial<LibraryRow>): LibraryRow => ({
  token: '', itemName: '', variationName: '', sku: '', description: '', reportingCategory: '',
  retailCents: 0, wholesaleCents: null, quantity: null, ...o,
});

test('seedLibrary inserts token-keyed rows, generates blank SKUs, marks PUSHED', async () => {
  const db = await seeded();
  const r = await seedLibrary(db, 'RE', [
    lrow({ token: 'T1', itemName: '20G Seam Ring [BVLA 20g SMR RG]', variationName: 'RG14K', sku: 'BVLA-1', retailCents: 13000, wholesaleCents: 6500 }),
    lrow({ token: 'T2', itemName: '10G Threadless Captive Bead [TD TI END 10g ANA]', variationName: '1/4″', sku: '', retailCents: 1359 }),
    lrow({ token: '', itemName: 'no token', sku: 'X' }), // no catalog id -> skipped
  ]);
  assert.equal(r.seeded, 2);
  assert.equal(r.inserted, 2);
  assert.equal(r.generatedSkus, 1);
  assert.equal(r.noSku, 0);

  const rows = (await db.query<{ vendor: string; vendor_sku: string; status: string; rp: string; wp: string | null; tags: string }>(
    `select vendor, vendor_sku, status::text as status, retail_price::text as rp, wholesale_price::text as wp, tags
       from catalog_mapping where client_id = 'RE' order by square_variation_id`,
  )).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.vendor, 'BVLA');
  assert.equal(rows[0]!.vendor_sku, 'BVLA-1');
  assert.equal(rows[0]!.status, 'PUSHED');
  assert.equal(rows[0]!.rp, '130.00');
  assert.equal(rows[0]!.wp, '65.00');
  assert.equal(rows[0]!.tags, 'BVLA 20g SMR RG');
  assert.equal(rows[1]!.vendor, 'Anatometal');
  assert.ok(rows[1]!.vendor_sku.startsWith('ANA-')); // synthetic
});

test('seedLibrary upserts by token (re-seed updates in place, no duplicate)', async () => {
  const db = await seeded();
  await seedLibrary(db, 'RE', [lrow({ token: 'T1', itemName: 'A', sku: 'S1', retailCents: 1000 })]);
  const r2 = await seedLibrary(db, 'RE', [lrow({ token: 'T1', itemName: 'A', sku: 'S1', retailCents: 2000 })]);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 1);

  const row = (await db.query<{ n: number; rp: string }>(
    `select count(*)::int as n, max(retail_price)::text as rp from catalog_mapping where client_id = 'RE'`,
  )).rows[0]!;
  assert.equal(row.n, 1); // no duplicate
  assert.equal(row.rp, '20.00'); // price updated
});
