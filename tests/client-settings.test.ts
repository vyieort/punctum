// Per-client settings: auto-enrich toggle default, persistence, and that it gates enrichImages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getClientSettings, setAutoEnrichImages } from '../src/lib/client-settings.js';
import { enrichImages, type EnrichOps } from '../src/jobs/enrich-images.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0012_client_settings.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

test('getClientSettings defaults to auto-enrich enabled', async () => {
  const db = await seeded();
  assert.equal((await getClientSettings(db as unknown as Queryable, 'RE')).autoEnrichImages, true);
});

test('setAutoEnrichImages persists and merges (round-trips both ways)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await setAutoEnrichImages(q, 'RE', false);
  assert.equal((await getClientSettings(q, 'RE')).autoEnrichImages, false);
  await setAutoEnrichImages(q, 'RE', true);
  assert.equal((await getClientSettings(q, 'RE')).autoEnrichImages, true);
});

test('enrichImages short-circuits (disabled) when auto-enrich is off', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await setAutoEnrichImages(q, 'RE', false);
  // ops is a stub; it must never be called when disabled (early return before Square config).
  const stub = {} as unknown as EnrichOps;
  const r = await enrichImages(q, 'RE', { ops: stub, limit: 10 });
  assert.equal(r.disabled, true);
  assert.equal(r.processed, 0);
});
