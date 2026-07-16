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
  await db.exec(mig('0003_line_classification.sql'));
  await db.exec(mig('0006_status_queued.sql'));
  await db.exec(mig('0007_status_processing.sql'));
  await db.exec(mig('0008_invoice_queue_cols.sql'));
  await db.exec(mig('0010_invoice_error_detail.sql'));
  await db.exec(mig('0013_line_excluded.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into invoices (id, client_id, vendor, invoice_number, invoice_date, total, status)
    values ('${INV}','RE','BVLA','INV-DEMO-001','2026-07-11',412.50,'in_review')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, description, quantity, wholesale, gems, notes, is_product)
    values ('${INV}',1,'18G Muse Seam Ring',1,147.50,'1.5mm White CZ (1)','Orientation: Conch;',true),
           ('${INV}',2,'Shipping',1,12.00,'','',false)`);
  return db;
}

test('review page keeps parsed data read-only but offers per-line exclude + shows the lines', async () => {
  const db = await seeded();
  const data = await getInvoiceForReview(db as unknown as Queryable, INV);
  const out = renderReviewPage(data!);
  assert.match(out, /18G Muse Seam Ring/);
  assert.match(out, /Shipping/);
  assert.doesNotMatch(out, /<input[^>]*type="(text|number)"/); // parsed data is not editable here
  assert.match(out, /class="excl"/); // per-line exclude checkboxes (the only inputs)
  assert.match(out, /\/approve/);
  assert.match(out, /\/reject/);
});

test('review shows the PDF panel (iframe) when a PDF is stored', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.query(`update invoices set pdf_bytes = decode($1,'base64') where id = $2`, [
    Buffer.from('%PDF-1.4 x').toString('base64'),
    INV,
  ]);
  const out = renderReviewPage((await getInvoiceForReview(q, INV))!);
  assert.match(out, new RegExp(`src="/invoices/${INV}/pdf`)); // iframe points at the served PDF
  assert.doesNotMatch(out, /shows here once uploaded/); // not the placeholder
});

test('flags suspicious product lines and highlights them; clean lines pass', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.query(
    `insert into invoice_lines (invoice_id, line_no, description, quantity, is_product, synthetic_sku, classification)
     values ($1, 5, 'Clean Ring', 2, true, 'SKU-OK', '{"product_type":"RING","item_name":"18G Ring"}'::jsonb)`,
    [INV],
  );
  await db.query(
    `insert into invoice_lines (invoice_id, line_no, description, quantity, is_product, classification)
     values ($1, 6, 'Mystery', 1, true, '{}'::jsonb)`,
    [INV],
  );
  const data = (await getInvoiceForReview(q, INV))!;
  const clean = data.lines.find((l) => l.description === 'Clean Ring')!;
  const mystery = data.lines.find((l) => l.description === 'Mystery')!;
  assert.deepEqual(clean.flags, []); // has SKU + classification -> clean
  assert.ok(mystery.flags.includes('no SKU'));
  assert.ok(mystery.flags.includes('unclassified'));

  const html = renderReviewPage(data);
  assert.match(html, /flagged to double-check/); // summary banner
  assert.match(html, /class="flag"/); // highlighted row
});

test('approve flips status to approved', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await handleReview(q, 'POST', INV, 'approve');
  assert.equal(r.status, 303);
  assert.equal((await getInvoiceForReview(q, INV))!.invoice.status, 'approved');
});

test('approve invokes the onApprove hook (auto-import trigger)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  let calledWith = '';
  const r = await handleReview(q, 'POST', INV, 'approve', async (id) => {
    calledWith = id;
  });
  assert.equal(r.status, 303);
  assert.equal(calledWith, INV);
  assert.equal((await getInvoiceForReview(q, INV))!.invoice.status, 'approved');
});

test('approve still succeeds even if the import hook throws', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await handleReview(q, 'POST', INV, 'approve', async () => {
    throw new Error('square down');
  });
  assert.equal(r.status, 303); // the import failure does not break the approve
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
