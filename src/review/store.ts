// Review store: read an invoice + its lines, persist reviewer edits, and approve.
// Works over any Queryable (pg Pool in prod, PGlite in tests).

import type { Queryable } from '../jobs/pg-rows.js';

export interface InvoiceRow {
  id: string;
  client_id: string;
  vendor: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: string | null;
  status: string;
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

export interface LineEdit {
  id: string;
  description?: string | null;
  quantity?: string | null;
  wholesale?: string | null;
  gems?: string | null;
  notes?: string | null;
  synthetic_sku?: string | null;
  is_product?: boolean;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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
            total::text as total, status
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

export async function saveLineEdits(db: Queryable, invoiceId: string, edits: LineEdit[]): Promise<void> {
  for (const e of edits) {
    await db.query(
      `update invoice_lines
          set description = $1, quantity = $2, wholesale = $3, gems = $4, notes = $5,
              synthetic_sku = $6, is_product = $7, review_status = 'edited'
        where id = $8 and invoice_id = $9`,
      [s(e.description), num(e.quantity), num(e.wholesale), s(e.gems), s(e.notes),
       s(e.synthetic_sku), e.is_product ?? true, e.id, invoiceId],
    );
  }
}

export async function approveInvoice(db: Queryable, invoiceId: string): Promise<boolean> {
  const r = await db.query(`update invoices set status = 'approved' where id = $1 returning id`, [invoiceId]);
  return r.rows.length > 0;
}
