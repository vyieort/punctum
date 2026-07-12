// Review route handler (read-only). Transport-agnostic so it unit-tests without HTTP.
// Routes: GET /invoices/:id/review, POST /invoices/:id/approve, POST /invoices/:id/reject.

import type { Queryable } from '../jobs/pg-rows.js';
import { getInvoiceForReview, approveInvoice, rejectInvoice } from './store.js';
import { renderReviewPage } from './render.js';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const html = (status: number, body: string): HttpResult => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
});
const redirect = (location: string): HttpResult => ({ status: 303, headers: { location }, body: '' });

export async function handleReview(
  db: Queryable,
  method: string,
  invoiceId: string,
  action: string,
): Promise<HttpResult> {
  const data = await getInvoiceForReview(db, invoiceId);
  if (!data) return html(404, '<h1>Invoice not found</h1>');

  if (method === 'GET' && action === 'review') {
    return html(200, renderReviewPage(data));
  }
  if (method === 'POST' && action === 'approve') {
    await approveInvoice(db, invoiceId);
    return redirect(`/invoices/${invoiceId}/review`);
  }
  if (method === 'POST' && action === 'reject') {
    await rejectInvoice(db, invoiceId);
    return redirect(`/invoices/${invoiceId}/review`);
  }
  return html(405, '<h1>Method not allowed</h1>');
}
