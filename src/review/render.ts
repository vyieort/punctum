// Read-only review page (pure function). A "does this match the invoice?" verification
// surface: parsed lines shown read-only beside the source PDF, with Approve / Reject.
// No editing — corrections happen at the source (re-parse).

import type { InvoiceForReview } from './store.js';

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReviewPage(data: InvoiceForReview): string {
  const { invoice, lines } = data;
  const status = invoice.status;
  const statusClass =
    status === 'approved' ? ' approved' : status === 'needs_review' ? ' rejected' : '';

  const rows = lines
    .map(
      (l) => `<tr>
      <td>${esc(l.line_no ?? '')}</td>
      <td>${esc(l.description)}</td>
      <td class="num">${esc(l.quantity)}</td>
      <td class="num">${esc(l.wholesale)}</td>
      <td>${esc(l.gems)}</td>
      <td>${esc(l.notes)}</td>
      <td>${esc(l.synthetic_sku)}</td>
      <td class="ctr">${l.is_product ? '&#10003;' : '&mdash;'}</td>
    </tr>`,
    )
    .join('');

  const pdfPanel = invoice.pdf_storage_path
    ? `<iframe class="pdf" src="/invoices/${esc(invoice.id)}/pdf" title="Source invoice"></iframe>`
    : `<div class="pdf placeholder">Source invoice PDF shows here once uploaded via intake.</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review &mdash; ${esc(invoice.vendor)} ${esc(invoice.invoice_number)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:1320px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} .meta{color:#555;margin-bottom:1rem}
  .status{display:inline-block;padding:.1rem .5rem;border-radius:4px;background:#eee;font-size:13px}
  .status.approved{background:#d6f5d6;color:#166534}
  .status.rejected{background:#fde2e1;color:#9f1d1a}
  .cols{display:flex;gap:1.25rem;align-items:flex-start;flex-wrap:wrap}
  .panel{flex:1 1 460px;min-width:0}
  .pdf{width:100%;height:72vh;border:1px solid #ddd;border-radius:6px}
  .pdf.placeholder{display:flex;align-items:center;justify-content:center;text-align:center;color:#888;background:#fafafa;padding:1rem;min-height:200px}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{border:1px solid #e6e6e6;padding:.4rem .55rem;text-align:left;vertical-align:top}
  th{background:#f6f6f6;font-weight:600}
  td.num{text-align:right;font-variant-numeric:tabular-nums} td.ctr{text-align:center}
  .actions{margin-top:1.1rem;display:flex;gap:.6rem}
  form{display:inline}
  button{padding:.55rem 1.1rem;font:inherit;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
  button.approve{background:#166534;color:#fff;border-color:#166534}
  button.reject{background:#fff;color:#9f1d1a;border-color:#e2b3b1}
  .note{color:#666;font-size:13px;margin-top:.5rem;max-width:640px}
</style></head>
<body>
  <h2>${esc(invoice.vendor)} &mdash; ${esc(invoice.invoice_number)}</h2>
  <div class="meta">${esc(invoice.invoice_date)} &middot; Total $${esc(invoice.total)} &middot;
    <span class="status${statusClass}">${esc(status)}</span></div>
  <div class="cols">
    <div class="panel">${pdfPanel}</div>
    <div class="panel">
      <table>
        <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Wholesale</th><th>Gems</th><th>Notes</th><th>SKU</th><th>Product?</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="actions">
        <form method="post" action="/invoices/${esc(invoice.id)}/approve"><button class="approve" type="submit">Approve invoice</button></form>
        <form method="post" action="/invoices/${esc(invoice.id)}/reject"><button class="reject" type="submit">Reject / send back</button></form>
      </div>
      <div class="note">Read-only: confirm the parsed data matches the invoice, then Approve. If it&rsquo;s wrong, Reject &mdash; corrections are made at the source (re-parse), not here.</div>
      ${status === 'approved' ? '<p>&#10003; Approved &mdash; queued for import.</p>' : ''}
      ${status === 'needs_review' ? '<p>&#8617; Sent back for re-parse.</p>' : ''}
    </div>
  </div>
</body></html>`;
}
