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

/**
 * Flip the given invoices from in_review -> importing (atomic + tenant-scoped; only in_review rows
 * change). Returns which ids were actually approved so the caller can fire their (serialized)
 * imports. Ids that aren't this tenant's in_review invoices are skipped.
 */
export async function bulkApproveInvoices(
  db: Queryable,
  clientId: string,
  ids: string[],
): Promise<{ approvedIds: string[]; skipped: number }> {
  const approvedIds: string[] = [];
  let skipped = 0;
  for (const id of ids) {
    let ok = false;
    try {
      const upd = await db.query(
        `update invoices set status = 'importing', updated_at = now()
           where id = $1 and client_id = $2 and status = 'in_review' returning id`,
        [id, clientId],
      );
      ok = upd.rows.length > 0;
    } catch {
      ok = false; // e.g. a malformed id
    }
    if (ok) approvedIds.push(id);
    else skipped++;
  }
  return { approvedIds, skipped };
}

/**
 * Remove a queued invoice (and its lines, via cascade) before it reaches Square. Tenant-scoped, and
 * refuses invoices that are mid-push ('importing') or already pushed ('done') — the status guard in
 * the DELETE also closes the race where it flips to importing between the check and the delete.
 * Nothing in Square is touched; this only clears Punctum's queue.
 */
export async function deleteQueuedInvoice(
  db: Queryable,
  clientId: string,
  id: string,
): Promise<{ deleted: boolean; reason?: string }> {
  const { rows } = await db.query(`select status::text as status from invoices where id = $1 and client_id = $2`, [id, clientId]);
  if (rows.length === 0) return { deleted: false, reason: 'not found' };
  const status = String((rows[0] as { status: string }).status);
  if (status === 'importing') return { deleted: false, reason: 'currently pushing to Square' };
  if (status === 'done') return { deleted: false, reason: 'already pushed to Square — kept for history' };
  const del = await db.query(
    `delete from invoices where id = $1 and client_id = $2 and status not in ('importing','done') returning id`,
    [id, clientId],
  );
  return { deleted: del.rows.length > 0 };
}

/**
 * Delete several queued invoices at once (the "Delete selected" toolbar action). Tenant-scoped;
 * each id runs through deleteQueuedInvoice, so mid-push/done rows are skipped rather than deleted.
 * Returns which ids were actually removed.
 */
export async function bulkDeleteInvoices(
  db: Queryable,
  clientId: string,
  ids: string[],
): Promise<{ deletedIds: string[]; skipped: number }> {
  const deletedIds: string[] = [];
  let skipped = 0;
  for (const id of ids) {
    let ok = false;
    try {
      ok = (await deleteQueuedInvoice(db, clientId, id)).deleted;
    } catch {
      ok = false;
    }
    if (ok) deletedIds.push(id);
    else skipped++;
  }
  return { deletedIds, skipped };
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
  const working = rows.some((r) => r.status === 'queued' || r.status === 'processing' || r.status === 'importing');
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const countLine = Object.entries(counts)
    .map(([s, n]) => `${n} ${STATUS_LABEL[s] ?? s}`)
    .join(' · ');
  const inReviewCount = counts.in_review ?? 0;
  // Deletable before it's pushed: anything except mid-push ('importing') or already-in-Square ('done').
  const deletableCount = rows.filter((r) => r.status !== 'importing' && r.status !== 'done').length;

  const body = rows
    .map((r) => {
      const color = STATUS_COLOR[r.status] ?? '#6b7280';
      const label = STATUS_LABEL[r.status] ?? r.status;
      // Every row links to its (read-only) review page — so an already-pushed invoice can be
      // reopened to look at, with no approve/reject at that point.
      const linkLabel = r.status === 'in_review' ? 'Review →' : r.status === 'error' ? 'View error' : 'View';
      // One checkbox per selectable (deletable) row. data-status lets the toolbar tell how many of
      // the checked rows can actually be Approved (only in_review) vs Deleted (any checked).
      const deletable = r.status !== 'importing' && r.status !== 'done';
      const chk = deletable ? `<input type="checkbox" class="qchk" data-id="${esc(r.id)}" data-status="${esc(r.status)}">` : '';
      const total = r.total ? `$${esc(r.total)}` : '';
      return `<tr>
        <td class="chk">${chk}</td>
        <td>${esc(r.created)}<div class="fn">${esc(r.filename)}</div></td>
        <td>${esc(r.vendor)}</td>
        <td>${esc(r.invoiceNumber)}</td>
        <td class="ctr">${esc(r.lineCount)}</td>
        <td>${total}</td>
        <td><span class="badge" style="background:${color}">${esc(label)}</span></td>
        <td><a class="review" href="/invoices/${esc(r.id)}/review">${linkLabel}</a></td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review queue</title>
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
  td.chk,th.chk{width:26px}
  button.approve{font:inherit;font-size:13px;padding:.3rem .8rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;margin-bottom:1rem}
  button.approve:disabled{opacity:.45;cursor:default}
  button.danger{font:inherit;font-size:13px;padding:.3rem .8rem;border:1px solid #b91c1c;background:#fff;color:#b91c1c;border-radius:6px;cursor:pointer;margin:0 0 1rem .5rem}
  button.danger:hover{background:#fef2f2} button.danger:disabled{opacity:.45;cursor:default}
</style></head>
<body>
  <h2>Review queue</h2>
  <p class="sub">${rows.length} invoices${countLine ? ' — ' + esc(countLine) : ''}.${working ? ' Auto-updating while items process…' : ''}</p>
  <a class="btn" href="/invoices/batch">+ Upload more invoices</a>
  ${inReviewCount ? '<button class="approve" id="approvebtn" disabled onclick="approveSelected()">Approve selected</button>' : ''}
  ${deletableCount ? '<button class="danger" id="deletebtn" disabled onclick="deleteSelected()">Delete selected</button>' : ''}
  ${counts.error ? `<button class="retry" onclick="retryErrored(this)">Retry ${counts.error} errored</button>` : ''}
  <table>
    <thead><tr><th class="chk">${deletableCount ? '<input type="checkbox" id="qall">' : ''}</th><th>Uploaded</th><th>Vendor</th><th>Invoice #</th><th>Lines</th><th>Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>
<script>
async function retryErrored(b){
  b.disabled=true; b.textContent='Re-queuing…';
  try{ await fetch('/queue/retry',{method:'POST'}); location.reload(); }
  catch(e){ b.disabled=false; alert(e.message); }
}
function checkedBoxes(){ return Array.prototype.slice.call(document.querySelectorAll('.qchk:checked')); }
function selectedIds(){ return checkedBoxes().map(function(c){ return c.getAttribute('data-id'); }); }
function approvableIds(){ return checkedBoxes().filter(function(c){ return c.getAttribute('data-status')==='in_review'; }).map(function(c){ return c.getAttribute('data-id'); }); }
function updateButtons(){
  var sel=selectedIds().length, appr=approvableIds().length;
  var a=document.getElementById('approvebtn'); if(a){ a.disabled=appr===0; a.textContent=appr?('Approve '+appr+' selected'):'Approve selected'; }
  var d=document.getElementById('deletebtn'); if(d){ d.disabled=sel===0; d.textContent=sel?('Delete '+sel+' selected'):'Delete selected'; }
}
document.querySelectorAll('.qchk').forEach(function(c){ c.addEventListener('change', updateButtons); });
var qall=document.getElementById('qall'); if(qall) qall.addEventListener('change', function(e){ document.querySelectorAll('.qchk').forEach(function(c){ c.checked=e.target.checked; }); updateButtons(); });
async function approveSelected(){
  var ids=approvableIds(); if(!ids.length) return;
  if(!confirm('Approve '+ids.length+' invoice(s) and push to Square?')) return;
  var b=document.getElementById('approvebtn'); b.disabled=true; b.textContent='Approving '+ids.length+'…';
  try{
    var res=await fetch('/queue/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:ids})});
    var j=await res.json();
    if(res.ok){ location.reload(); } else { alert('Error: '+(j.error||res.status)); b.disabled=false; updateButtons(); }
  }catch(e){ alert(e.message); b.disabled=false; updateButtons(); }
}
async function deleteSelected(){
  var ids=selectedIds(); if(!ids.length) return;
  if(!confirm('Delete '+ids.length+' invoice(s) from the queue? This removes them and their extracted lines here. Nothing in Square is touched.')) return;
  var b=document.getElementById('deletebtn'); b.disabled=true; b.textContent='Deleting '+ids.length+'…';
  try{
    var res=await fetch('/queue/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:ids})});
    var j=await res.json();
    if(res.ok){ location.reload(); } else { alert('Error: '+(j.error||res.status)); b.disabled=false; updateButtons(); }
  }catch(e){ alert(e.message); b.disabled=false; updateButtons(); }
}
${working ? `
// Live status: poll a lightweight snapshot and reload ONLY when a status actually changes (a push
// finishing, an extract completing) — so the queue never sits stale, without blindly reloading every
// few seconds. Only emitted while something is processing; stops once everything is terminal.
var KNOWN=${JSON.stringify(Object.fromEntries(rows.map((r) => [r.id, r.status])))};
function qChanged(cur){
  for(var id in cur){ if(KNOWN[id]!==cur[id]) return true; }
  for(var id in KNOWN){ if(!(id in cur)) return true; } // a row was removed (deleted elsewhere)
  return false;
}
async function pollQueue(){
  try{
    var r=await fetch('/queue/status').then(function(x){return x.json();});
    if(qChanged(r.statuses||{})){ location.reload(); return; }
    if(r.working){ setTimeout(pollQueue, 4000); }
  }catch(e){ setTimeout(pollQueue, 8000); }
}
setTimeout(pollQueue, 4000);
` : ''}
</script>
</body></html>`;
}
