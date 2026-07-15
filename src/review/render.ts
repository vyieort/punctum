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

// Render the persisted push failure (JSON [{item, error}]) as a readable list.
function formatPushError(detail: string | null): string {
  if (!detail) return '';
  let items: Array<{ item?: string; error?: string }>;
  try {
    items = JSON.parse(detail) as Array<{ item?: string; error?: string }>;
  } catch {
    return `<pre style="white-space:pre-wrap;background:#fef2f2;border:1px solid #f3b4b4;border-radius:6px;padding:.5rem .7rem;color:#991b1b;font-size:12px;overflow:auto">${esc(detail)}</pre>`;
  }
  if (!Array.isArray(items) || items.length === 0) return '';
  const rows = items.map((e) => `<li><strong>${esc(e.item ?? 'item')}</strong>: ${esc(e.error ?? '')}</li>`).join('');
  return `<ul style="margin:.4rem 0 0;padding-left:1.1rem;color:#991b1b;font-size:13px;line-height:1.4">${rows}</ul>`;
}

export function renderReviewPage(data: InvoiceForReview): string {
  const { invoice, lines } = data;
  const status = invoice.status;
  const ok = status === 'approved' || status === 'done';
  const bad = status === 'needs_review' || status === 'error';
  const statusClass = ok ? ' approved' : bad ? ' rejected' : '';

  // Backorder is empty on most invoices; only surface the column when one line has it.
  const showBackorder = lines.some((l) => l.backorder);
  const flaggedCount = lines.filter((l) => l.flags.length > 0).length;
  const productCount = lines.filter((l) => l.is_product).length;
  const rows = lines
    .map((l) => {
      const flagged = l.flags.length > 0;
      const note = flagged ? `<div class="flagnote">&#9888; ${esc(l.flags.join(', '))}</div>` : '';
      return `<tr class="${flagged ? 'flag' : ''}">
      <td>${esc(l.line_no ?? '')}</td>
      <td>${esc(l.description)}${note}</td>
      <td class="num">${esc(l.quantity)}</td>
      <td class="num">${esc(l.wholesale)}</td>
      <td>${esc(l.gems)}</td>
      <td>${esc(l.notes)}</td>
      <td>${esc(l.synthetic_sku)}</td>
      ${showBackorder ? `<td class="ctr">${l.backorder ? 'Yes' : '&mdash;'}</td>` : ''}
      <td class="ctr">${l.is_product ? '&#10003;' : '&mdash;'}</td>
    </tr>`;
    })
    .join('');

  const pdfPanel = invoice.has_pdf
    ? `<iframe class="pdf" src="/invoices/${esc(invoice.id)}/pdf#view=FitH" title="Source invoice"></iframe>`
    : `<div class="pdf placeholder">Source invoice PDF shows here once uploaded via intake.</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${status === 'importing' ? '<meta http-equiv="refresh" content="4">' : ''}
<title>Review &mdash; ${esc(invoice.vendor)} ${esc(invoice.invoice_number)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:1320px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} .meta{color:#555;margin-bottom:1rem}
  .status{display:inline-block;padding:.1rem .5rem;border-radius:4px;background:#eee;font-size:13px}
  .status.approved{background:#d6f5d6;color:#166534}
  .status.rejected{background:#fde2e1;color:#9f1d1a}
  .pdfwrap{position:sticky;top:0;background:#fff;z-index:5;padding:.3rem 0 .7rem;border-bottom:2px solid #eee}
  .pdf{width:100%;height:50vh;border:1px solid #ddd;border-radius:6px;display:block}
  .pdf.placeholder{display:flex;align-items:center;justify-content:center;text-align:center;color:#888;background:#fafafa;padding:1rem;height:180px}
  .data{padding-top:1rem}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{border:1px solid #e6e6e6;padding:.4rem .55rem;text-align:left;vertical-align:top}
  th{background:#f6f6f6;font-weight:600}
  td.num{text-align:right;font-variant-numeric:tabular-nums} td.ctr{text-align:center}
  tbody tr:nth-child(even){background:#e0f7fa}
  tbody tr.flag{background:#fffbeb;box-shadow:inset 3px 0 0 #d97706}
  .flagnote{color:#b45309;font-size:12px;margin-top:2px}
  .flagsummary{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;padding:.4rem .7rem;border-radius:6px;font-size:13px;margin:0 0 .7rem}
  .actions{margin-top:1.1rem;display:flex;gap:.6rem}
  form{display:inline}
  button{padding:.55rem 1.1rem;font:inherit;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}
  button.approve{background:#166534;color:#fff;border-color:#166534}
  button.reject{background:#fff;color:#9f1d1a;border-color:#e2b3b1}
  .note{color:#666;font-size:13px;margin-top:.5rem;max-width:640px}
</style></head>
<body>
  <p style="margin:0 0 .5rem"><a href="/queue" style="color:#2563eb;font-size:13px;text-decoration:none">&larr; Back to queue</a></p>
  <h2>${esc(invoice.vendor)} &mdash; ${esc(invoice.invoice_number)}</h2>
  <div class="meta">${esc(invoice.invoice_date)} &middot; Total $${esc(invoice.total)} &middot;
    <span class="status${statusClass}">${esc(status)}</span></div>
  <div class="pdfwrap">${pdfPanel}</div>
  <div class="data">
      ${flaggedCount ? `<div class="flagsummary">&#9888; ${flaggedCount} of ${productCount} product line${productCount === 1 ? '' : 's'} flagged to double-check &mdash; highlighted below.</div>` : ''}
      <table>
        <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Wholesale</th><th>Gems</th><th>Notes</th><th>SKU</th>${showBackorder ? '<th>Back order</th>' : ''}<th>Product?</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        status === 'in_review'
          ? `<div class="actions">
        <form method="post" action="/invoices/${esc(invoice.id)}/approve" onsubmit="return lock(this)"><button class="approve" type="submit">Approve invoice</button></form>
        <form method="post" action="/invoices/${esc(invoice.id)}/reject" onsubmit="return lock(this)"><button class="reject" type="submit">Reject / send back</button></form>
      </div>
      <div class="note">Read-only: confirm the parsed data matches the invoice, then Approve. If it&rsquo;s wrong, Reject &mdash; corrections are made at the source (re-parse), not here.</div>`
          : ''
      }
      ${status === 'done' ? '<p>&#10003; Approved &amp; pushed to Square.</p>' : ''}
      ${status === 'importing' ? '<p>&#8987; Approving &amp; pushing to Square&hellip; you can leave this page &mdash; it finishes on its own.</p>' : ''}
      ${status === 'approved' ? '<p>&#10003; Approved.</p>' : ''}
      ${
        status === 'error'
          ? lines.length === 0
            ? '<p>&#9888; Couldn&rsquo;t extract this invoice &mdash; retry it from the queue.</p>'
            : `<p>&#9888; Approved, but the Square push failed. Fix at the source, then retry from the import page.</p>${formatPushError(invoice.error_detail)}`
          : ''
      }
      ${status === 'needs_review' ? '<p>&#8617; Sent back for re-parse.</p>' : ''}
  </div>
<script>
  // Guard against a double-click firing two approves (the push takes a few seconds to return).
  var submitted=false;
  function lock(f){
    if(submitted) return false;
    submitted=true;
    var btn=f.querySelector('button'); if(btn) btn.textContent = btn.classList.contains('approve') ? 'Approving…' : 'Rejecting…';
    setTimeout(function(){ var bs=document.querySelectorAll('.actions button'); for(var i=0;i<bs.length;i++) bs[i].disabled=true; }, 0);
    return true;
  }
</script>
</body></html>`;
}
