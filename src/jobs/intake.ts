// Invoice intake (W1). Port of the Sc1 pipeline's write side, retargeted from Google
// Sheets to Postgres: extract a PDF with Claude, parse ALL line items, fill blank SKUs,
// and write one `invoices` row + one `invoice_lines` row per line, landing in 'in_review'
// so it appears on the review page.
//
// The extractor is injected (defaults to the live Anthropic call) so this whole flow is
// unit-testable with a canned extraction and no API key.

import type { Queryable } from './pg-rows.js';
import { parseInvoiceLines, type ExtractedLineItem } from '../lib/parse.js';
import { fillSkus } from '../lib/sku.js';
import { extractInvoiceText } from '../lib/anthropic.js';

export type Extractor = (pdfBase64: string) => Promise<string>;

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

export async function ingestInvoice(
  db: Queryable,
  clientId: string,
  input: IngestInput,
  extract: Extractor = extractInvoiceText,
): Promise<IngestResult> {
  const raw = await extract(input.pdfBase64);
  const parsed = parseInvoiceLines(raw);
  // fillSkus preserves the item shape (only adds a SKU where blank); cast back to the
  // typed line-item so field access below is checked.
  const lines = fillSkus(parsed.vendor_name, parsed.line_items) as unknown as ExtractedLineItem[];

  const inv = await db.query(
    `insert into invoices (client_id, vendor, invoice_number, invoice_date, total, status, pdf_storage_path)
     values ($1, $2, $3, $4, $5, 'in_review', $6)
     returning id`,
    [
      clientId,
      parsed.vendor_name || null,
      parsed.invoice_number || null,
      parsed.invoice_date || null,
      parsed.invoice_total ?? null,
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
         (invoice_id, line_no, description, quantity, wholesale, gems, notes, backorder, synthetic_sku, is_product)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        invoiceId,
        lineNo,
        p.description ?? null,
        p.quantity ?? null,
        p.unit_price ?? null,
        p.gems ?? null,
        p.notes ?? null,
        backorder,
        p.sku ?? null,
        p.is_product !== false,
      ],
    );
  }

  return {
    invoiceId,
    vendorName: parsed.vendor_name,
    invoiceNumber: parsed.invoice_number,
    lineCount: lines.length,
    productCount: lines.filter((p) => p.is_product !== false).length,
  };
}
