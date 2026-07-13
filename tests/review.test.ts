// Read-only review page tests against real Postgres via PGlite: render, approve, reject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getInvoiceForReview } from '../src/review/store.js';
import { renderReviewPage } from '../src/review/render.js';
import { handleReview } from '../src/review/handler.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-000000000001';

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into invoices (id, client_id, vendor, invoice_number, invoice_date, total, status)
    values ('${INV}','RE','BVLA','INV-DEMO-001','2026-07-11',412.50,'in_review')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, description, quantity, wholesale, gems, notes, is_product)
    values ('${INV}',1,'18G Muse Seam Ring',1,147.50,'1.5mm White CZ (1)','Orientation: Conch;',true),
           ('${INV}',2,'Shipping',1,12.00,'','',false)`);
  return db;
}

test('review page is fully read-only (no inputs) and shows the parsed lines', async () => {
  const db = await seeded();
  const data = await getInvoiceForReview(db as unknown as Queryable, INV);
  const out = renderReviewPage(data!);
  assert.match(out, /18G Muse Seam Ring/);
  assert.match(out, /Shipping/);
  assert.doesNotMatch(out, /<input/); // read-only — no editable fields
  assert.match(out, /\/approve/);
  assert.match(out, /\/reject/);
});

test('approve flips status to approved', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await handleReview(q, 'POST', INV, 'approve');
  assert.equal(r.status, 303);
  assert.equal((await getInvoiceForReview(q, INV))!.invoice.status, 'approved');
});

test('reject sends the invoice back to needs_review', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await handleReview(q, 'POST', INV, 'reject');
  assert.equal(r.status, 303);
  assert.equal((await getInvoiceForReview(q, INV))!.invoice.status, 'needs_review');
});

test('backorder column shows only when a line is actually backordered', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // demo lines have no backorder -> no column
  let out = renderReviewPage((await getInvoiceForReview(q, INV))!);
  assert.doesNotMatch(out, /Back order/);
  // add a backordered line -> column appears
  await db.exec(`insert into invoice_lines (invoice_id, line_no, description, quantity, wholesale, is_product, backorder)
    values ('${INV}', 3, 'Backordered Ring', 1, 99.00, true, true)`);
  out = renderReviewPage((await getInvoiceForReview(q, INV))!);
  assert.match(out, /Back order/);
  assert.match(out, />Yes</);
});

test('unknown invoice returns 404', async () => {
  const db = await seeded();
  const r = await handleReview(db as unknown as Queryable, 'GET', '11111111-1111-1111-1111-111111111111', 'review');
  assert.equal(r.status, 404);
});
