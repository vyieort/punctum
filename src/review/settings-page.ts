// Per-client settings page. First control: auto-enrich images on/off (studios that shoot their
// own product photography turn it off and use manual upload / the bulk filmstrip instead).

import type { ClientSettings } from '../lib/client-settings.js';
import type { SquareConnection } from '../lib/square-account.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderSettingsPage(settings: ClientSettings, connection?: SquareConnection, squareStatus?: string | null): string {
  const conn = connection ?? { connected: false, merchantId: null, environment: null, locationId: null };
  const banner =
    squareStatus === 'connected'
      ? '<div class="ok">✓ Square connected.</div>'
      : squareStatus === 'error'
        ? '<div class="err">Square connection failed — please try again.</div>'
        : '';
  const squareCard = conn.connected
    ? `<div class="card">
         <div class="t">Square — <span style="color:#166534">connected</span></div>
         <div class="d">Merchant <code>${esc(conn.merchantId ?? '—')}</code> · ${esc(conn.environment ?? '')} · location <code>${esc(conn.locationId ?? '—')}</code></div>
         <a class="btn2" href="/oauth/square/start">Reconnect</a>
       </div>`
    : `<div class="card">
         <div class="t">Square — <span style="color:#b45309">not connected</span></div>
         <div class="d">Connect your Square account so Punctum can create items and receive inventory into your own catalog.</div>
         <a class="btn" href="/oauth/square/start">Connect Square</a>
       </div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings · Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:640px;color:#1a1a1a;padding:0 1rem}
  a{color:#2563eb;text-decoration:none} a:hover{text-decoration:underline}
  h2{margin:.25rem 0 1rem}
  .card{border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.1rem;margin-bottom:1rem}
  .toggle{display:flex;align-items:flex-start;gap:.7rem}
  .toggle input{margin-top:.2rem;width:18px;height:18px}
  .toggle .t{font-weight:600} .toggle .d{color:#6b7280;font-size:13px;margin-top:.2rem}
  button{padding:.55rem 1.1rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5}
  #status{margin-left:.8rem;color:#333;font-size:13px}
  .card .t{font-weight:600} .card .d{color:#6b7280;font-size:13px;margin:.25rem 0 .6rem}
  .btn{display:inline-block;padding:.5rem 1rem;border:1px solid #166534;background:#166534;color:#fff!important;border-radius:6px;text-decoration:none}
  .btn2{display:inline-block;padding:.4rem .9rem;border:1px solid #6b7280;color:#374151!important;border-radius:6px;text-decoration:none;font-size:13px}
  .ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;padding:.5rem .75rem;border-radius:6px;margin-bottom:1rem;font-size:14px}
  .err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:.5rem .75rem;border-radius:6px;margin-bottom:1rem;font-size:14px}
  code{background:#f3f4f6;padding:.05rem .3rem;border-radius:4px;font-size:12px}
</style></head>
<body>
  <p><a href="/">← Home</a></p>
  <h2>Settings</h2>
  ${banner}
  ${squareCard}
  <div class="card">
    <label class="toggle">
      <input type="checkbox" id="autoenrich" ${settings.autoEnrichImages ? 'checked' : ''}>
      <span>
        <span class="t">Auto-enrich product images</span>
        <div class="d">Automatically find and attach a product photo to each newly imported item (SerpAPI + Claude Vision). Turn this <strong>off</strong> if your studio supplies its own photography — you'll add images by manual upload or the bulk photo tool instead.</div>
      </span>
    </label>
  </div>
  <button id="save" onclick="save()">Save</button><span id="status"></span>
<script>
async function save(){
  var b=document.getElementById('save'), s=document.getElementById('status');
  b.disabled=true; s.textContent='Saving…';
  try{
    var res=await fetch('/settings',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({autoEnrichImages:document.getElementById('autoenrich').checked})});
    var j=await res.json();
    s.textContent = res.ok ? 'Saved ✓' : ('Error: '+(j.error||res.status));
  }catch(e){ s.textContent='Error: '+e.message; }
  b.disabled=false;
}
</script>
</body></html>`;
}
