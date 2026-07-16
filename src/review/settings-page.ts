// Per-client settings page. First control: auto-enrich images on/off (studios that shoot their
// own product photography turn it off and use manual upload / the bulk filmstrip instead).

import type { ClientSettings } from '../lib/client-settings.js';

export function renderSettingsPage(settings: ClientSettings): string {
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
</style></head>
<body>
  <p><a href="/">← Home</a></p>
  <h2>Settings</h2>
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
