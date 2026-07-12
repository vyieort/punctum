// Invoice intake writer — exercised end-to-end against real Postgres via PGlite with a
// canned extractor (no live API). Proves extract -> parse -> fillSkus -> DB rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { ingestInvoice } from '../src/jobs/intake.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

const EXTRACTION = {
  vendor_name: 'BVLA',
  invoice_number: 'INV-9',
  invoice_date: '2026-07-11',
  invoice_total: 214.5,
  line_items: [
    { sku: '16-1468-300-20-R14K', description: 'Muse Seam Ring 18g', quantity: 1, unit_price: 147.5, total: 147.5, is_product: true, gems: '1.5mm White CZ (1)', notes: 'Orientation: Conch;', back_order: '' },
    { sku: '', description: 'Ball End 4mm Titanium', quantity: 2, unit_price: 27.5, total: 55, is_product: true, gems: '', notes: '', back_order: 'YES' },
    { sku: '', description: 'Shipping', quantity: 1, unit_price: 12, total: 12, is_product: false, gems: '', notes: '', back_order: '' },
  ],
};
const fakeExtract = async (): Promise<string> => '```json\n' + JSON.stringify(EXTRACTION) + '\n```';

test('ingestInvoice writes the invoice + every line, fills blank SKUs, lands in_review', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await ingestInvoice(q, 'RE', { pdfBase64: 'Zm9v' }, fakeExtract);

  assert.equal(r.lineCount, 3); // all lines, including Shipping
  assert.equal(r.productCount, 2);

  const inv = await db.query<{ vendor: string; invoice_number: string; invoice_date: string; total: string; status: string }>(
    `select vendor, invoice_number, invoice_date::text as invoice_date, total::text as total, status from invoices where id = $1`,
    [r.invoiceId],
  );
  assert.equal(inv.rows[0]!.vendor, 'BVLA');
  assert.equal(inv.rows[0]!.invoice_number, 'INV-9');
  assert.equal(inv.rows[0]!.invoice_date, '2026-07-11');
  assert.equal(inv.rows[0]!.total, '214.50');
  assert.equal(inv.rows[0]!.status, 'in_review');

  const lines = await db.query<{ line_no: number; synthetic_sku: string; gems: string; backorder: boolean; is_product: boolean; wholesale: string }>(
    `select line_no, synthetic_sku, gems, backorder, is_product, wholesale::text as wholesale
       from invoice_lines where invoice_id = $1 order by line_no`,
    [r.invoiceId],
  );
  assert.equal(lines.rows.length, 3);
  assert.equal(lines.rows[0]!.synthetic_sku, '16-1468-300-20-R14K'); // real SKU kept
  assert.equal(lines.rows[0]!.gems, '1.5mm White CZ (1)');
  assert.equal(lines.rows[0]!.wholesale, '147.50');
  assert.equal(lines.rows[1]!.synthetic_sku, 'BVLA-BAL-END-TI-4MM'); // blank SKU generated
  assert.equal(lines.rows[1]!.backorder, true); // back_order 'YES' -> boolean true
  assert.equal(lines.rows[2]!.is_product, false); // Shipping stored, flagged non-product
});

test('a failed extraction throws and writes no invoice row', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await assert.rejects(
    () => ingestInvoice(q, 'RE', { pdfBase64: 'x' }, async () => 'this is not json'),
    /parse failed/,
  );
  const c = await db.query<{ n: number }>(`select count(*)::int as n from invoices`);
  assert.equal(c.rows[0]!.n, 0);
});
