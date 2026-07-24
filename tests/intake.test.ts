// Single-pass intake against real Postgres via PGlite, with a canned merged invoice (no API).
// Proves: extract+classify -> fillSkus -> write invoice + all lines + stored classification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { ingestInvoice, type Extractor } from '../src/jobs/intake.js';
import { upsertVendorProfile } from '../src/lib/vendor-profile.js';
import type { MergedInvoice } from '../src/lib/merged.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0002_invoice_needs_review.sql'));
  await db.exec(mig('0003_line_classification.sql'));
  await db.exec(mig('0008_invoice_queue_cols.sql'));
  await db.exec(mig('0018_vendor_profiles.sql'));
  await db.exec(mig('0022_vendor_profiles_shared_schema.sql')); // resolves the 0001/0018 collision
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

const ci = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: 'BVLA', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', is_product: true, back_order: '', ...over,
});

const MERGED: MergedInvoice = {
  vendor_name: 'BVLA',
  invoice_number: 'INV-9',
  invoice_date: '2026-07-11',
  invoice_total: 214.5,
  items: [
    ci({ sku: '16-1468-300-20-R14K', description: 'Muse Seam Ring 18g', qty: '1', price: '147.50', gems: '1.5mm White CZ (1)', notes: 'Orientation: Conch;', item_name: '18G Muse Seam Ring', variation_name: 'RG14K', product_type: 'RING' }),
    ci({ sku: '', description: 'Ball End 4mm Titanium', qty: '2', price: '27.50', back_order: 'YES', item_name: '14G Threadless Ball', variation_name: '4MM Titanium', product_type: 'THREADLESS_END' }),
    ci({ sku: '', description: 'Shipping', qty: '1', price: '12.00', is_product: false }),
  ],
};

test('ingestInvoice writes invoice + all lines, fills SKUs, stores classification', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await ingestInvoice(q, 'RE', { pdfBase64: 'Zm9v' }, async () => MERGED);

  assert.equal(r.lineCount, 3);
  assert.equal(r.productCount, 2);

  const inv = await db.query<{ vendor: string; invoice_number: string; total: string; status: string }>(
    `select vendor, invoice_number, total::text as total, status from invoices where id = $1`,
    [r.invoiceId],
  );
  assert.equal(inv.rows[0]!.vendor, 'BVLA');
  assert.equal(inv.rows[0]!.invoice_number, 'INV-9');
  assert.equal(inv.rows[0]!.total, '214.50');
  assert.equal(inv.rows[0]!.status, 'in_review');

  const lines = await db.query<{ synthetic_sku: string; wholesale: string; backorder: boolean; is_product: boolean; item_name: string }>(
    `select synthetic_sku, wholesale::text as wholesale, backorder, is_product,
            classification->>'item_name' as item_name
       from invoice_lines where invoice_id = $1 order by line_no`,
    [r.invoiceId],
  );
  assert.equal(lines.rows[0]!.synthetic_sku, '16-1468-300-20-R14K'); // real SKU kept
  assert.equal(lines.rows[0]!.wholesale, '147.50'); // from qty/price strings -> numeric
  assert.equal(lines.rows[0]!.item_name, '18G Muse Seam Ring'); // classification stored
  assert.equal(lines.rows[1]!.synthetic_sku, 'BVLA-BAL-END-TI-4MM'); // blank SKU generated
  assert.equal(lines.rows[1]!.backorder, true); // back_order 'YES' -> true
  assert.equal(lines.rows[1]!.item_name, '14G Threadless Ball');
  assert.equal(lines.rows[2]!.is_product, false); // Shipping stored, flagged non-product
});

test('a trained vendor triggers a second, hint-guided pass whose reading is what gets stored', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // BVLA has learned guidance, so the vendor discovered in pass 1 should trigger a hinted pass 2.
  await upsertVendorProfile(q, { vendorName: 'BVLA', guidance: 'Conch seam rings: orientation goes in the variation name.' });

  const FIRST: MergedInvoice = { ...MERGED, invoice_number: 'FIRST' };
  const HINTED: MergedInvoice = { ...MERGED, invoice_number: 'HINTED' };
  let calls = 0;
  const extractor: Extractor = async (_pdf, _opts, hints) => {
    calls++;
    return hints && hints.trim() ? HINTED : FIRST;
  };

  const r = await ingestInvoice(q, 'RE', { pdfBase64: 'Zm9v' }, extractor);
  assert.equal(calls, 2); // pass 1 discovers BVLA, pass 2 re-reads with its hints
  const inv = await db.query<{ invoice_number: string }>(`select invoice_number from invoices where id = $1`, [r.invoiceId]);
  assert.equal(inv.rows[0]!.invoice_number, 'HINTED'); // the hinted reading is the one persisted
});

test('an untrained vendor stays single-pass (no wasted second call)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  let calls = 0;
  const extractor: Extractor = async (_pdf, _opts, hints) => {
    calls++;
    return hints && hints.trim() ? { ...MERGED, invoice_number: 'HINTED' } : MERGED;
  };

  const r = await ingestInvoice(q, 'RE', { pdfBase64: 'Zm9v' }, extractor);
  assert.equal(calls, 1); // no profile for BVLA -> no second pass
  const inv = await db.query<{ invoice_number: string }>(`select invoice_number from invoices where id = $1`, [r.invoiceId]);
  assert.equal(inv.rows[0]!.invoice_number, 'INV-9');
});

test('a failed extraction throws and writes no invoice row', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await assert.rejects(
    () => ingestInvoice(q, 'RE', { pdfBase64: 'x' }, async () => {
      throw new Error('Merged parse failed: boom');
    }),
    /parse failed/,
  );
  const c = await db.query<{ n: number }>(`select count(*)::int as n from invoices`);
  assert.equal(c.rows[0]!.n, 0);
});
