// Review route handler. Kept transport-agnostic (takes method/id/action/body, returns a
// status+headers+body) so it can be unit-tested without a live HTTP server.

import type { Queryable } from '../jobs/pg-rows.js';
import { getInvoiceForReview, saveLineEdits, approveInvoice, type LineEdit } from './store.js';
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

/** Build edits only for lines actually present in the submitted form. */
function editsFromForm(lineIds: string[], form: URLSearchParams): LineEdit[] {
  return lineIds
    .filter((id) => form.has(`description_${id}`))
    .map((id) => ({
      id,
      description: form.get(`description_${id}`),
      quantity: form.get(`quantity_${id}`),
      wholesale: form.get(`wholesale_${id}`),
      gems: form.get(`gems_${id}`),
      notes: form.get(`notes_${id}`),
      synthetic_sku: form.get(`sku_${id}`),
      is_product: form.has(`is_product_${id}`),
    }));
}

/** Routes: GET /invoices/:id/review, POST /invoices/:id/save, POST /invoices/:id/approve. */
export async function handleReview(
  db: Queryable,
  method: string,
  invoiceId: string,
  action: string,
  formBody: string,
): Promise<HttpResult> {
  const data = await getInvoiceForReview(db, invoiceId);
  if (!data) return html(404, '<h1>Invoice not found</h1>');

  if (method === 'GET' && action === 'review') {
    return html(200, renderReviewPage(data));
  }

  if (method === 'POST' && (action === 'save' || action === 'approve')) {
    const form = new URLSearchParams(formBody);
    await saveLineEdits(db, invoiceId, editsFromForm(data.lines.map((l) => l.id), form));
    if (action === 'approve') await approveInvoice(db, invoiceId);
    return redirect(`/invoices/${invoiceId}/review`);
  }

  return html(405, '<h1>Method not allowed</h1>');
}
