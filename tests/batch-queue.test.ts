// Batch queue: queueInvoice stores the PDF fast, processQueuedInvoice/worker extract it later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { queueInvoice, processQueuedInvoice } from '../src/jobs/intake.js';
import { processNextQueued } from '../src/jobs/worker.js';
import type { MergedInvoice } from '../src/lib/merged.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(mig('0003_line_classification.sql'));
  await db.exec(mig('0006_status_queued.sql'));
  await db.exec(mig('0007_status_processing.sql'));
  await db.exec(mig('0008_invoice_queue_cols.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

const fakeExtract = () => async (): Promise<MergedInvoice> => ({
  vendor_name: 'BVLA',
  invoice_number: 'INV-1',
  invoice_date: '2026-07-13',
  invoice_total: 100,
  items: [
    {
      vendor: 'BVLA', sku: 'B-1', description: '18g Seam Ring', qty: '1', price: '40', is_product: true,
      product_type: 'RING', ring_format: 'SEAM', metal: 'Yellow 14K', item_name: '18G Seam Ring', variation_name: 'Y14K',
    } as unknown as ClassifiedItem,
  ],
});

const PDF_B64 = Buffer.from('%PDF-1.4 tiny invoice').toString('base64');

test('queueInvoice stores a queued invoice holding the pdf bytes', async () => {
  const db = await seeded();
  const { invoiceId } = await queueInvoice(db as unknown as Queryable, 'RE', { pdfBase64: PDF_B64, filename: 'bvla.pdf' });
  const row = (
    await db.query<{ status: string; filename: string; has_pdf: boolean }>(
      `select status::text as status, filename, pdf_bytes is not null as has_pdf from invoices where id=$1`,
      [invoiceId],
    )
  ).rows[0]!;
  assert.equal(row.status, 'queued');
  assert.equal(row.filename, 'bvla.pdf');
  assert.equal(row.has_pdf, true);
});

test('processQueuedInvoice extracts, writes lines, clears bytes -> in_review', async () => {
  const db = await seeded();
  const { invoiceId } = await queueInvoice(db as unknown as Queryable, 'RE', { pdfBase64: PDF_B64 });
  const r = await processQueuedInvoice(db as unknown as Queryable, invoiceId, fakeExtract());
  assert.equal(r.ok, true);
  assert.equal(r.lineCount, 1);
  const inv = (
    await db.query<{ status: string; vendor: string; has_pdf: boolean }>(
      `select status::text as status, vendor, pdf_bytes is not null as has_pdf from invoices where id=$1`,
      [invoiceId],
    )
  ).rows[0]!;
  assert.equal(inv.status, 'in_review');
  assert.equal(inv.vendor, 'BVLA');
  assert.equal(inv.has_pdf, false); // cleared after success
  const lines = await db.query<{ n: number }>(`select count(*)::int as n from invoice_lines where invoice_id=$1`, [invoiceId]);
  assert.equal(lines.rows[0]!.n, 1);
});

test('processQueuedInvoice keeps bytes + marks error when extraction throws', async () => {
  const db = await seeded();
  const { invoiceId } = await queueInvoice(db as unknown as Queryable, 'RE', { pdfBase64: PDF_B64 });
  const boom = async (): Promise<MergedInvoice> => {
    throw new Error('AI down');
  };
  const r = await processQueuedInvoice(db as unknown as Queryable, invoiceId, boom);
  assert.equal(r.ok, false);
  const inv = (
    await db.query<{ status: string; has_pdf: boolean }>(
      `select status::text as status, pdf_bytes is not null as has_pdf from invoices where id=$1`,
      [invoiceId],
    )
  ).rows[0]!;
  assert.equal(inv.status, 'error');
  assert.equal(inv.has_pdf, true); // kept so it can be retried
});

test('processNextQueued drains the queue oldest-first', async () => {
  const db = await seeded();
  await queueInvoice(db as unknown as Queryable, 'RE', { pdfBase64: PDF_B64, filename: 'a.pdf' });
  await queueInvoice(db as unknown as Queryable, 'RE', { pdfBase64: PDF_B64, filename: 'b.pdf' });
  assert.equal((await processNextQueued(db as unknown as Queryable, fakeExtract())).processed, true);
  assert.equal((await processNextQueued(db as unknown as Queryable, fakeExtract())).processed, true);
  assert.equal((await processNextQueued(db as unknown as Queryable, fakeExtract())).processed, false); // drained
  const done = await db.query<{ n: number }>(`select count(*)::int as n from invoices where status='in_review'`);
  assert.equal(done.rows[0]!.n, 2);
});
