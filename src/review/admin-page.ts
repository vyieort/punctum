// Platform admin view: every tenant's health and every open notification in one place. This is
// where admin-audience alerts and escalations land, and where user-submitted reports show up.

import type { Notification } from '../lib/notifications.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SEV: Record<string, string> = { info: '#6b7280', warn: '#b45309', error: '#b91c1c' };

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export interface AdminPageState {
  tenants: Array<{ clientId: string; name: string; open: number }>;
  notifications: Notification[];
  mailerConfigured?: boolean;
}

export function renderAdminPage(s: AdminPageState): string {
  const tenantRows = s.tenants.length
    ? s.tenants
        .map(
          (t) =>
            `<tr><td>${esc(t.name)}</td><td class="mono">${esc(t.clientId)}</td>
             <td>${t.open ? `<span class="pill" style="background:${t.open > 2 ? '#b91c1c' : '#b45309'}">${t.open} open</span>` : '<span class="ok">clear</span>'}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="3" class="muted">No tenants yet.</td></tr>';

  const rows = s.notifications.length
    ? s.notifications
        .map((n) => {
          const ctx = Object.keys(n.context).length ? `<div class="ctx mono">${esc(JSON.stringify(n.context))}</div>` : '';
          const act = n.actionUrl ? ` &middot; <a href="${esc(n.actionUrl)}">open</a>` : '';
          return `<tr id="n-${esc(n.id)}">
            <td><span class="dot" style="background:${SEV[n.severity] ?? '#6b7280'}"></span>${esc(n.severity)}</td>
            <td><strong>${esc(n.title)}</strong>${n.detail ? `<div class="muted">${esc(n.detail)}</div>` : ''}${ctx}</td>
            <td>${esc(n.clientId ?? 'platform')}</td>
            <td class="mono">${esc(n.type)}${n.source === 'user' ? ' <span class="tag">report</span>' : ''}</td>
            <td class="nowrap">${esc(ago(n.createdAt))}${act}</td>
            <td><button onclick="resolveIt('${esc(n.id)}')">Resolve</button></td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="muted">Nothing open. Quiet is good.</td></tr>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.75rem auto;max-width:1100px;color:#1a1a1a;padding:0 1rem}
  h2{margin:.25rem 0 .3rem} h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:1.5rem 0 .4rem}
  p{color:#444} a{color:#2563eb;text-decoration:none}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:.45rem .5rem;text-align:left;vertical-align:top}
  th{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .muted{color:#9ca3af;font-size:12px} .nowrap{white-space:nowrap}
  .dot{display:inline-block;width:8px;height:8px;border-radius:99px;margin-right:.4rem}
  .pill{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600}
  .ok{color:#166534;font-size:12px}
  .tag{background:#ede9fe;color:#5b21b6;border-radius:4px;padding:.02rem .3rem;font-size:10px}
  .ctx{color:#9ca3af;margin-top:.2rem}
  button{padding:.25rem .6rem;border:1px solid #d1d5db;background:#fff;border-radius:6px;cursor:pointer;font:inherit;font-size:12px}
  .mailcheck{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:.55rem .8rem;font-size:13px;margin-top:1rem}
  .mailcheck button{margin-left:.6rem} #mailstatus{margin-left:.6rem;font-size:12px;color:#374151}
</style></head>
<body>
  <h2>Admin</h2>
  <p>Platform health across every studio. Alerts land here when they're the platform's problem, or when a studio's problem has gone unattended.</p>

  <div class="mailcheck">
    <strong>Email delivery:</strong> ${s.mailerConfigured ? '<span class="ok">configured</span>' : '<span style="color:#b45309">not configured</span> — set POSTMARK_SERVER_TOKEN + ALERT_FROM_EMAIL'}
    <button onclick="testEmail()">Send test email</button><span id="mailstatus"></span>
  </div>

  <h3>Tenants</h3>
  <table><thead><tr><th>Studio</th><th>Client id</th><th>Alerts</th></tr></thead><tbody>${tenantRows}</tbody></table>

  <h3>Open notifications</h3>
  <table><thead><tr><th>Sev</th><th>What</th><th>Studio</th><th>Type</th><th>When</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<script>
async function testEmail(){
  var s=document.getElementById('mailstatus'); s.textContent='Sending…';
  try{
    var res=await fetch('/admin/test-email',{method:'POST'});
    var j=await res.json();
    s.textContent = res.ok ? ('Sent to '+(j.to||[]).join(', ')+' — check your inbox.') : ('Error: '+(j.error||res.status));
  }catch(e){ s.textContent='Error: '+e.message; }
}
async function resolveIt(id){
  try{
    var res=await fetch('/notifications/'+encodeURIComponent(id)+'/resolve',{method:'POST'});
    if(res.ok){ var el=document.getElementById('n-'+id); if(el) el.remove(); }
    else { alert('Could not resolve ('+res.status+')'); }
  }catch(e){ alert(e.message); }
}
</script>
</body></html>`;
}
