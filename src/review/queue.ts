// Review queue page: every invoice with its status, so a batch upload can be worked through as
// the background worker finishes each one. Auto-refreshes while anything is still queued/processing.

import type { Queryable } from '../jobs/pg-rows.js';

export interface QueueRow {
  id: string;
  vendor: string;
  invoiceNumber: string;
  filename: string;
  status: string;
  total: string;
  created: string;
  lineCount: string;
}

export async function getQueueRows(db: Queryable, clientId: string, limit = 200): Promise<QueueRow[]> {
  const { rows } = await db.query(
    `select i.id, i.vendor, i.invoice_number, i.filename, i.status::text as status,
            i.total::text as total, to_char(i.created_at, 'YYYY-MM-DD HH24:MI') as created,
            (select count(*) from invoice_lines l where l.invoice_id = i.id)::text as line_count
       from invoices i
      where i.client_id = $1
      order by i.created_at desc
      limit $2`,
    [clientId, limit],
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const str = (v: unknown): string => (v == null ? '' : String(v));
    return {
      id: str(row.id),
      vendor: str(row.vendor),
      invoiceNumber: str(row.invoice_number),
      filename: str(row.filename),
      status: str(row.status),
      total: str(row.total),
      created: str(row.created),
      lineCount: str(row.line_count),
    };
  });
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_COLOR: Record<string, string> = {
  queued: '#6b7280',
  processing: '#2563eb',
  in_review: '#b45309',
  approved: '#166534',
  importing: '#2563eb',
  done: '#166534',
  error: '#b91c1c',
  needs_review: '#b91c1c',
  received: '#6b7280',
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  processing: 'Extracting…',
  in_review: 'Ready to review',
  approved: 'Approved',
  importing: 'Pushing…',
  done: 'Done',
  error: 'Error',
  needs_review: 'Sent back',
};

export function renderQueuePage(rows: QueueRow[]): string {
  const working = rows.some((r) => r.status === 'queued' || r.status === 'processing');
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const countLine = Object.entries(counts)
    .map(([s, n]) => `${n} ${STATUS_LABEL[s] ?? s}`)
    .join(' · ');

  const body = rows
    .map((r) => {
      const color = STATUS_COLOR[r.status] ?? '#6b7280';
      const label = STATUS_LABEL[r.status] ?? r.status;
      const action =
        r.status === 'in_review'
          ? `<a class="review" href="/invoices/${esc(r.id)}/review">Review →</a>`
          : r.status === 'error'
            ? `<a href="/invoices/${esc(r.id)}/review">Details</a>`
            : '';
      const total = r.total ? `$${esc(r.total)}` : '';
      return `<tr>
        <td>${esc(r.created)}<div class="fn">${esc(r.filename)}</div></td>
        <td>${esc(r.vendor)}</td>
        <td>${esc(r.invoiceNumber)}</td>
        <td class="ctr">${esc(r.lineCount)}</td>
        <td>${total}</td>
        <td><span class="badge" style="background:${color}">${esc(label)}</span></td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue</title>
${working ? '<meta http-equiv="refresh" content="8">' : ''}
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:1000px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} .sub{color:#555;margin:0 0 1rem;font-size:14px}
  a.btn{display:inline-block;margin:0 1rem 1rem 0;color:#166534;font-size:14px}
  button.retry{font:inherit;font-size:13px;padding:.3rem .7rem;border:1px solid #b45309;color:#b45309;background:#fff;border-radius:6px;cursor:pointer;margin-bottom:1rem}
  button.retry:disabled{opacity:.6}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:.5rem .6rem;text-align:left;vertical-align:top}
  th{color:#666;font-weight:600} td.ctr{text-align:center}
  .fn{color:#9ca3af;font-size:11px;margin-top:2px}
  .badge{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600;white-space:nowrap}
  a.review{color:#166534;font-weight:600;text-decoration:none} a{color:#2563eb}
</style></head>
<body>
  <h2>Review queue</h2>
  <p class="sub">${rows.length} invoices${countLine ? ' — ' + esc(countLine) : ''}.${working ? ' Refreshing while items extract…' : ''}</p>
  <a class="btn" href="/invoices/batch">+ Upload more invoices</a>
  ${counts.error ? `<button class="retry" onclick="retryErrored(this)">Retry ${counts.error} errored</button>` : ''}
  <table>
    <thead><tr><th>Uploaded</th><th>Vendor</th><th>Invoice #</th><th>Lines</th><th>Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>
<script>
async function retryErrored(b){
  b.disabled=true; b.textContent='Re-queuing…';
  try{ await fetch('/queue/retry?client=RE',{method:'POST'}); location.reload(); }
  catch(e){ b.disabled=false; alert(e.message); }
}
</script>
</body></html>`;
}
