// Invoice intake (W1), single-pass. One Claude call extracts AND classifies the PDF; we
// fill blank SKUs, write one `invoices` row + one `invoice_lines` row per line (landing in
// 'in_review'), and store each line's classification so the import needs no further AI.
//
// The extractor is injected (defaults to the live merged call) so this flow is unit-testable
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
  const lines = (fillSkus(merged.vendor_name, merged.items) as unknown as ClassifiedItem[]).map(
    normalizeClassification,
  );

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

  return {
    invoiceId,
    vendorName: merged.vendor_name,
    invoiceNumber: merged.invoice_number,
    lineCount: lines.length,
    productCount: lines.filter((p) => p.is_product !== false).length,
  };
}
