// Review route handler (read-only). Transport-agnostic so it unit-tests without HTTP.
// Routes: GET /invoices/:id/review, POST /invoices/:id/approve, POST /invoices/:id/reject.

import type { Queryable } from '../jobs/pg-rows.js';
import { getInvoiceForReview, approveInvoice, rejectInvoice, markLinesExcluded } from './store.js';
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
  onApprove?: (invoiceId: string) => Promise<void>,
  excludedLineIds?: string[],
): Promise<HttpResult> {
  const data = await getInvoiceForReview(db, invoiceId);
  if (!data) return html(404, '<h1>Invoice not found</h1>');

  if (method === 'GET' && action === 'review') {
    return html(200, renderReviewPage(data));
  }
  if (method === 'POST' && action === 'approve') {
    // Honor per-line excludes (skipped by the import) before flipping to approved.
    if (excludedLineIds) await markLinesExcluded(db, invoiceId, excludedLineIds);
    await approveInvoice(db, invoiceId);
    // Auto-push to Square on approval. An import failure is recorded on the invoice status
    // (runImport sets 'error') and can be retried via /jobs/import/run — it does not break
    // the approve itself.
    if (onApprove) {
      try {
        await onApprove(invoiceId);
      } catch {
        /* status reflects the failure */
      }
    }
    // Back to the queue so the operator can grab the next invoice (the push finishes in the
    // background; the queue shows this one go importing -> done on its own).
    return redirect('/queue');
  }
  if (method === 'POST' && action === 'reject') {
    await rejectInvoice(db, invoiceId);
    return redirect('/queue');
  }
  return html(405, '<h1>Method not allowed</h1>');
}
