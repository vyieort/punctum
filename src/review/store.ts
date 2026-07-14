// Review store: read an invoice + its lines, and record the approve/reject decision.
// Read-only review — no line editing. Works over any Queryable (pg Pool or PGlite).

import type { Queryable } from '../jobs/pg-rows.js';

export interface InvoiceRow {
  id: string;
  client_id: string;
  vendor: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: string | null;
  status: string;
  pdf_storage_path: string | null;
  has_pdf: boolean;
}

export interface InvoiceLineRow {
  id: string;
  line_no: number | null;
  description: string | null;
  quantity: string | null;
  wholesale: string | null;
  gems: string | null;
  notes: string | null;
  backorder: boolean;
  synthetic_sku: string | null;
  is_product: boolean;
  review_status: string | null;
}

export interface InvoiceForReview {
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
}

// Drop trailing zeros from a numeric string for display (e.g. "3.000" -> "3").
const trimZeros = (v: unknown): string | null => {
  if (v == null) return null;
  const str = String(v);
  return str.includes('.') ? str.replace(/0+$/, '').replace(/\.$/, '') : str;
};

export async function getInvoiceForReview(
  db: Queryable,
  invoiceId: string,
): Promise<InvoiceForReview | null> {
  const inv = await db.query(
    `select id, client_id, vendor, invoice_number, invoice_date::text as invoice_date,
            total::text as total, status, pdf_storage_path, pdf_bytes is not null as has_pdf
       from invoices where id = $1`,
    [invoiceId],
  );
  if (inv.rows.length === 0) return null;
  const lines = await db.query(
    `select id, line_no, description, quantity::text as quantity, wholesale::text as wholesale,
            gems, notes, backorder, synthetic_sku, is_product, review_status
       from invoice_lines where invoice_id = $1 order by line_no nulls last, created_at`,
    [invoiceId],
  );
  return {
    invoice: inv.rows[0] as unknown as InvoiceRow,
    lines: (lines.rows as unknown as InvoiceLineRow[]).map((l) => ({ ...l, quantity: trimZeros(l.quantity) })),
  };
}

export async function approveInvoice(db: Queryable, invoiceId: string): Promise<boolean> {
  const r = await db.query(`update invoices set status = 'approved' where id = $1 returning id`, [invoiceId]);
  return r.rows.length > 0;
}

/** Reject = send the invoice back for re-parse (fix at the source, not by hand-editing). */
export async function rejectInvoice(db: Queryable, invoiceId: string): Promise<boolean> {
  const r = await db.query(`update invoices set status = 'needs_review' where id = $1 returning id`, [invoiceId]);
  return r.rows.length > 0;
}
