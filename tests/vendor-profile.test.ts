// Shared vendor-profile engine (#42): key normalization, create/refine, hint rendering, and the
// extraction-instruction injection point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import {
  normalizeVendorKey, getVendorProfile, upsertVendorProfile, renderVendorHints, loadVendorHints,
} from '../src/lib/vendor-profile.js';
import { buildExtractionInstruction } from '../src/lib/merged.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0018_vendor_profiles.sql'));
  return db;
}

test('normalizeVendorKey slugifies vendor names', () => {
  assert.equal(normalizeVendorKey('Anatometal'), 'anatometal');
  assert.equal(normalizeVendorKey("People's Jewelry"), 'people-s-jewelry');
  assert.equal(normalizeVendorKey('  BVLA  '), 'bvla');
});

test('buildExtractionInstruction appends vendor hints only when present', () => {
  assert.equal(buildExtractionInstruction(''), 'Extract and classify all line items from this invoice.');
  assert.match(buildExtractionInstruction('HINT: gems live in the description'), /HINT: gems live in the description$/);
});

test('upsertVendorProfile creates then refines; guidance preserved, sample count increments', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  let p = await upsertVendorProfile(q, { vendorName: 'Anatometal', guidance: 'Accent gems pair with the prior end.', incSample: true });
  assert.equal(p.vendorKey, 'anatometal');
  assert.equal(p.displayName, 'Anatometal');
  assert.equal(p.sampleCount, 1);
  // Refine with examples + another sample; guidance omitted -> preserved, not clobbered.
  p = await upsertVendorProfile(q, { vendorName: 'anatometal', examples: [{ before: '2.0mm CZ', after: 'gem: CZ 2.0mm on prior end' }], incSample: true });
  assert.equal(p.sampleCount, 2);
  assert.match(p.guidance, /Accent gems/);
  assert.equal(p.examples.length, 1);
});

test('getVendorProfile returns null for an unknown vendor', async () => {
  const db = await seeded();
  assert.equal(await getVendorProfile(db as unknown as Queryable, 'Nobody Co'), null);
});

test('renderVendorHints: empty -> "", guidance + examples included, disabled -> ""', () => {
  assert.equal(renderVendorHints(null), '');
  assert.equal(renderVendorHints({ vendorKey: 'x', displayName: 'X', guidance: '', examples: [], sampleCount: 0, status: 'active' }), '');
  const h = renderVendorHints({ vendorKey: 'ana', displayName: 'Anatometal', guidance: 'Pair accent gems.', examples: [{ before: '2.0 CZ', after: 'gem CZ' }], sampleCount: 3, status: 'active' });
  assert.match(h, /Anatometal/);
  assert.match(h, /Pair accent gems/);
  assert.match(h, /2\.0 CZ => gem CZ/);
  assert.equal(renderVendorHints({ vendorKey: 'ana', displayName: 'Anatometal', guidance: 'x', examples: [], sampleCount: 1, status: 'disabled' }), '');
});

test('loadVendorHints loads + renders in one call', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await upsertVendorProfile(q, { vendorName: 'BVLA', guidance: 'Color codes: Y = yellow gold, R = rose.' });
  assert.match(await loadVendorHints(q, 'bvla'), /Color codes/);
  assert.equal(await loadVendorHints(q, 'unknown vendor'), '');
});
