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
  error_detail: string | null; // JSON [{item, error}] when a Square push failed
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
  flags: string[]; // deterministic "double-check this" signals; empty = looks fine
}

const asObj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
};

/** Concrete signals that a parsed product line is likely wrong — surfaced on the review page. */
export function computeLineFlags(row: Record<string, unknown>): string[] {
  if (!row.is_product) return []; // shipping/fees aren't catalog errors
  const c = asObj(row.classification);
  const flags: string[] = [];
  if (!String(row.synthetic_sku ?? '').trim()) flags.push('no SKU');
  if (!String(c.item_name ?? '').trim()) flags.push('no item name');
  const pt = String(c.product_type ?? '').toUpperCase();
  if (pt === '' || pt === 'FALLBACK') flags.push('unclassified');
  const fr = String(c.flag_reason ?? '').trim();
  if (fr) flags.push(fr);
  const qty = parseFloat(String(row.quantity ?? ''));
  if (!Number.isFinite(qty) || qty <= 0) flags.push('bad qty');
  return flags;
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
            total::text as total, status, pdf_storage_path, error_detail, pdf_bytes is not null as has_pdf
       from invoices where id = $1`,
    [invoiceId],
  );
  if (inv.rows.length === 0) return null;
  const lines = await db.query(
    `select id, line_no, description, quantity::text as quantity, wholesale::text as wholesale,
            gems, notes, backorder, synthetic_sku, is_product, review_status, classification
       from invoice_lines where invoice_id = $1 order by line_no nulls last, created_at`,
    [invoiceId],
  );
  return {
    invoice: inv.rows[0] as unknown as InvoiceRow,
    lines: (lines.rows as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      line_no: (row.line_no as number | null) ?? null,
      description: (row.description as string | null) ?? null,
      quantity: trimZeros(row.quantity),
      wholesale: (row.wholesale as string | null) ?? null,
      gems: (row.gems as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      backorder: Boolean(row.backorder),
      synthetic_sku: (row.synthetic_sku as string | null) ?? null,
      is_product: Boolean(row.is_product),
      review_status: (row.review_status as string | null) ?? null,
      flags: computeLineFlags(row),
    })),
  };
}

export async function approveInvoice(db: Queryable, invoiceId: string): Promise<boolean> {
  const r = await db.query(`update invoices set status = 'approved' where id = $1 returning id`, [invoiceId]);
  return r.rows.length > 0;
}

/** Set exactly the given line ids as excluded (the rest included) for this invoice — reflects the
 *  reviewer's current selection, so unchecking on a re-approve un-excludes. Excluded lines are
 *  skipped by the import. */
export async function markLinesExcluded(db: Queryable, invoiceId: string, lineIds: string[]): Promise<void> {
  await db.query(`update invoice_lines set excluded = false where invoice_id = $1`, [invoiceId]);
  if (lineIds.length > 0) {
    await db.query(`update invoice_lines set excluded = true where invoice_id = $1 and id = any($2::uuid[])`, [invoiceId, lineIds]);
  }
}

/** Reject = send the invoice back for re-parse (fix at the source, not by hand-editing). */
export async function rejectInvoice(db: Queryable, invoiceId: string): Promise<boolean> {
  const r = await db.query(`update invoices set status = 'needs_review' where id = $1 returning id`, [invoiceId]);
  return r.rows.length > 0;
}
