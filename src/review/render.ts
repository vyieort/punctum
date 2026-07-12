// Server-rendered review page (pure function — no I/O, so it's easy to test).
// One editable table of the invoice's parsed lines, plus Save and Approve.

import type { InvoiceForReview } from './store.js';

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cell(name: string, value: unknown): string {
  return `<td><input name="${esc(name)}" value="${esc(value)}"></td>`;
}

export function renderReviewPage(data: InvoiceForReview): string {
  const { invoice, lines } = data;
  const approved = invoice.status === 'approved';
  const rows = lines
    .map(
      (l) => `<tr>
      <td>${esc(l.line_no ?? '')}</td>
      ${cell(`description_${l.id}`, l.description)}
      ${cell(`quantity_${l.id}`, l.quantity)}
      ${cell(`wholesale_${l.id}`, l.wholesale)}
      ${cell(`gems_${l.id}`, l.gems)}
      ${cell(`notes_${l.id}`, l.notes)}
      ${cell(`sku_${l.id}`, l.synthetic_sku)}
      <td style="text-align:center"><input type="checkbox" name="is_product_${esc(l.id)}"${l.is_product ? ' checked' : ''}></td>
    </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review — ${esc(invoice.vendor)} ${esc(invoice.invoice_number)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:1040px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} .meta{color:#555;margin-bottom:1rem}
  .status{display:inline-block;padding:.1rem .5rem;border-radius:4px;background:#eee;font-size:13px}
  .status.approved{background:#d6f5d6;color:#166534}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{border:1px solid #e6e6e6;padding:.3rem .45rem;text-align:left}
  th{background:#f6f6f6;font-weight:600}
  input{width:100%;box-sizing:border-box;border:1px solid transparent;background:transparent;font:inherit;padding:.2rem}
  input:hover{border-color:#ddd} input:focus{border-color:#6b8afd;background:#fff;outline:none}
  .actions{margin-top:1.25rem;display:flex;gap:.6rem}
  button{padding:.55rem 1.1rem;font:inherit;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
  button.approve{background:#166534;color:#fff;border-color:#166534}
</style></head>
<body>
  <h2>${esc(invoice.vendor)} — ${esc(invoice.invoice_number)}</h2>
  <div class="meta">${esc(invoice.invoice_date)} · Total $${esc(invoice.total)} ·
    <span class="status${approved ? ' approved' : ''}">${esc(invoice.status)}</span></div>
  <form method="post" action="/invoices/${esc(invoice.id)}/save">
    <table>
      <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Wholesale</th><th>Gems</th><th>Notes</th><th>SKU</th><th>Product?</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="actions">
      <button type="submit">Save edits</button>
      <button type="submit" class="approve" formaction="/invoices/${esc(invoice.id)}/approve">Approve invoice</button>
    </div>
  </form>
  ${approved ? '<p>&#10003; Approved &mdash; ready for import.</p>' : ''}
</body></html>`;
}
