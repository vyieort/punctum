// Invoice intake (W1), single-pass. One Claude call extracts AND classifies the PDF; we fill
// blank SKUs and write one invoice_lines row per line, storing each line's classification so
// the import needs no further AI.
//
// Two entry points share the line-writing:
//   - ingestInvoice        : synchronous single upload (extract now, land 'in_review').
//   - queueInvoice / processQueuedInvoice : batch path — queue the (compressed) PDF fast, then
//     a background worker extracts it later.
//
// The extractor is injected (defaults to the live merged call) so these flows are unit-testable
// with a canned invoice and no API key.

import type { Queryable } from './pg-rows.js';
import { fillSkus } from '../lib/sku.js';
import { extractAndClassify, type MergedInvoice } from '../lib/merged.js';
import { maybeCompressPdf } from '../lib/pdf-compress.js';
import { normalizeClassification } from '../lib/normalize.js';
import type { ClassifiedItem } from '../lib/classify.js';
import type { AnthropicOptions } from '../lib/anthropic.js';

export type Extractor = (pdfBase64: string, opts?: AnthropicOptions) => Promise<MergedInvoice>;

export interface IngestInput {
  pdfBase64: string;
  filename?: string;
  /** Storage location of the source PDF, once uploaded (null until Storage lands). */
  pdfStoragePath?: string | null;
}

export interface IngestResult {
  invoiceId: string;
  vendorName: string;
  invoiceNumber: string;
  lineCount: number;
  productCount: number;
}

const num = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
};

/** Fill SKUs, normalize, and write one invoice_lines row per extracted line. */
async function insertClassifiedLines(
  db: Queryable,
  invoiceId: string,
  merged: MergedInvoice,
): Promise<{ lineCount: number; productCount: number }> {
  const lines = (fillSkus(merged.vendor_name, merged.items) as unknown as ClassifiedItem[]).map(normalizeClassification);
  let lineNo = 0;
  for (const p of lines) {
    lineNo++;
    const backorder = Boolean(p.back_order && String(p.back_order).trim() !== '');
    await db.query(
      `insert into invoice_lines
         (invoice_id, line_no, description, quantity, wholesale, gems, notes, backorder,
          synthetic_sku, is_product, classification)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        invoiceId,
        lineNo,
        p.description ?? null,
        num(p.qty),
        num(p.price),
        p.gems ?? null,
        p.notes ?? null,
        backorder,
        p.sku ?? null,
        p.is_product !== false,
        JSON.stringify(p),
      ],
    );
  }
  return { lineCount: lines.length, productCount: lines.filter((p) => p.is_product !== false).length };
}

export async function ingestInvoice(
  db: Queryable,
  clientId: string,
  input: IngestInput,
  extract: Extractor = extractAndClassify,
): Promise<IngestResult> {
  // Oversized scanned PDFs (e.g. a 20MB NeoMetal scan) are downsampled first so the AI call
  // stays well under the gateway timeout. No-op for normal-sized invoices.
  const { base64: pdfForAi } = await maybeCompressPdf(input.pdfBase64);
  const merged = await extract(pdfForAi);

  const inv = await db.query(
    `insert into invoices (client_id, vendor, invoice_number, invoice_date, total, status, pdf_storage_path)
     values ($1, $2, $3, $4, $5, 'in_review', $6)
     returning id`,
    [
      clientId,
      merged.vendor_name || null,
      merged.invoice_number || null,
      merged.invoice_date || null,
      merged.invoice_total ?? null,
      input.pdfStoragePath ?? null,
    ],
  );
  const invoiceId = (inv.rows[0] as { id: string }).id;
  const { lineCount, productCount } = await insertClassifiedLines(db, invoiceId, merged);

  return { invoiceId, vendorName: merged.vendor_name, invoiceNumber: merged.invoice_number, lineCount, productCount };
}

// ---------------------------------------------------------------- batch queue

/** Store a (compressed) PDF as a 'queued' invoice for background processing. Fast; no AI call. */
export async function queueInvoice(
  db: Queryable,
  clientId: string,
  input: { pdfBase64: string; filename?: string },
): Promise<{ invoiceId: string }> {
  const { base64: compressed } = await maybeCompressPdf(input.pdfBase64);
  const inv = await db.query(
    `insert into invoices (client_id, status, filename, pdf_bytes)
     values ($1, 'queued', $2, decode($3, 'base64'))
     returning id`,
    [clientId, input.filename ?? null, compressed],
  );
  return { invoiceId: (inv.rows[0] as { id: string }).id };
}

/** Re-queue errored invoices that still have their PDF, so the worker retries them. */
export async function requeueErrored(db: Queryable, clientId: string): Promise<{ requeued: number }> {
  const r = await db.query(
    `update invoices set status = 'queued', updated_at = now()
       where client_id = $1 and status = 'error' and pdf_bytes is not null
       returning id`,
    [clientId],
  );
  return { requeued: r.rows.length };
}

export interface ProcessResult {
  ok: boolean;
  vendorName?: string;
  lineCount?: number;
  error?: string;
}

/** Extract + classify a queued invoice's stored PDF and populate its lines (status -> in_review). */
export async function processQueuedInvoice(
  db: Queryable,
  invoiceId: string,
  extract: Extractor = extractAndClassify,
): Promise<ProcessResult> {
  const q = await db.query(`select encode(pdf_bytes, 'base64') as pdf_b64 from invoices where id = $1`, [invoiceId]);
  if (q.rows.length === 0) return { ok: false, error: 'invoice not found' };
  const pdfB64 = (q.rows[0] as { pdf_b64: string | null }).pdf_b64;
  if (!pdfB64) return { ok: false, error: 'no pdf bytes' };
  // Postgres encode(...,'base64') wraps output at 76 cols; the AI needs it unwrapped.
  const cleanB64 = pdfB64.replace(/\s+/g, '');

  try {
    const merged = await extract(cleanB64); // the stored PDF is already compressed
    await db.query(
      `update invoices set vendor = $2, invoice_number = $3, invoice_date = $4, total = $5,
              status = 'in_review', pdf_bytes = null, updated_at = now()
         where id = $1`,
      [invoiceId, merged.vendor_name || null, merged.invoice_number || null, merged.invoice_date || null, merged.invoice_total ?? null],
    );
    const { lineCount } = await insertClassifiedLines(db, invoiceId, merged);
    return { ok: true, vendorName: merged.vendor_name, lineCount };
  } catch (e) {
    // Keep pdf_bytes so the invoice can be retried.
    await db.query(`update invoices set status = 'error', updated_at = now() where id = $1`, [invoiceId]).catch(() => {});
    return { ok: false, error: (e as Error).message };
  }
}
