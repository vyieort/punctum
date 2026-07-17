// Per-client settings page. First control: auto-enrich images on/off (studios that shoot their
// own product photography turn it off and use manual upload / the bulk filmstrip instead).

import type { ClientSettings } from '../lib/client-settings.js';
import type { SquareConnection } from '../lib/square-account.js';
import type { PricingRules } from '../lib/pricing.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface EditableRule { metals: string; vendors: string; multiplier: number; }

/** Present the stored pricing as editable rule rows. A legacy gold_when config is shown as rules,
 *  splitting metal vs vendor into separate rows so its OR semantics survive the round-trip. */
function editableRules(p: PricingRules): { rules: EditableRule[]; defaultMult: number; roundTo: number; exempt: string[] } {
  const roundTo = p.rounding?.to_cents ?? 50;
  const defaultMult = p.default_multiplier ?? p.multipliers?.default ?? 3.0;
  let rules: EditableRule[];
  if (p.rules && p.rules.length) {
    rules = p.rules.map((r) => ({ metals: (r.metals ?? []).join(', '), vendors: (r.vendors ?? []).join(', '), multiplier: r.multiplier }));
  } else {
    rules = [];
    const gm = p.multipliers?.gold ?? 2.5;
    const metals = p.gold_when?.metal_contains ?? [];
    const vendors = p.gold_when?.vendor_in ?? [];
    if (metals.length) rules.push({ metals: metals.join(', '), vendors: '', multiplier: gm });
    if (vendors.length) rules.push({ metals: '', vendors: vendors.join(', '), multiplier: gm });
    if (!rules.length) rules.push({ metals: '', vendors: '', multiplier: gm });
  }
  const exempt = p.exempt_categories ?? ['Piercing Fee', 'Service & Tool Fees', 'Diagnostic'];
  return { rules, defaultMult, roundTo, exempt };
}

function ruleRowHtml(r: EditableRule): string {
  return `<div class="rulerow">
        <input class="rmetals" placeholder="metals — e.g. 14k, gold" value="${esc(r.metals)}">
        <input class="rvendors" placeholder="vendors — e.g. bvla" value="${esc(r.vendors)}">
        <input class="rmult" type="number" step="0.1" min="0" value="${esc(String(r.multiplier))}" title="multiplier">
        <button type="button" class="rmv" title="Remove rule" onclick="this.closest('.rulerow').remove()">&times;</button>
      </div>`;
}

export function renderSettingsPage(
  settings: ClientSettings,
  pricing: PricingRules,
  connection?: SquareConnection,
  squareStatus?: string | null,
): string {
  const { rules: editRules, defaultMult, roundTo, exempt } = editableRules(pricing);
  const ruleRows = editRules.map(ruleRowHtml).join('');
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
  .prow{display:flex;align-items:center;gap:.6rem;margin:.5rem 0}
  .prow label{width:132px;font-size:13px;color:#374151}
  .prow input{width:90px;padding:.35rem .5rem;border:1px solid #d1d5db;border-radius:6px;font:inherit}
  .ex{color:#9ca3af;font-size:12px}
  .subh{font-weight:600;font-size:13px;margin:1rem 0 .4rem;color:#374151}
  .rulehdr{display:grid;grid-template-columns:1fr 1fr 64px 28px;gap:.5rem;font-size:11px;color:#9ca3af;margin-bottom:.25rem;padding:0 .1rem}
  .rulerow{display:grid;grid-template-columns:1fr 1fr 64px 28px;gap:.5rem;margin:.35rem 0}
  .rulerow input{padding:.35rem .5rem;border:1px solid #d1d5db;border-radius:6px;font:inherit;min-width:0}
  .rmv{padding:0;border:1px solid #e5e7eb;background:#fff;color:#b91c1c;border-radius:6px;cursor:pointer;font-size:15px;line-height:1}
  .addbtn{margin-top:.5rem;padding:.35rem .7rem;border:1px dashed #9ca3af;background:#fff;color:#374151;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}
  textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:.5rem .6rem;border:1px solid #d1d5db;border-radius:6px;resize:vertical}
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
  <div class="card">
    <div class="t">Pricing</div>
    <div class="d">Retail = wholesale cost × a multiplier. Rules are checked top to bottom and the <strong>first match wins</strong>; anything unmatched uses the default. A rule can match specific metals, specific vendors, or <strong>both</strong> (both filled = the item must match a metal <em>and</em> a vendor).</div>
    <div class="prow"><label for="defMult">Default multiplier</label><input id="defMult" type="number" step="0.1" min="1" value="${esc(String(defaultMult))}"><span class="ex">× wholesale, when no rule matches</span></div>

    <div class="subh">Rules</div>
    <div class="rulehdr"><span>Metals (any of)</span><span>Vendors (any of)</span><span>×</span><span></span></div>
    <div id="rules">${ruleRows}</div>
    <button type="button" class="addbtn" onclick="addRule()">+ Add rule</button>

    <div class="subh">Fee &amp; service exemptions</div>
    <div class="d">Items in these categories are priced at cost — <strong>no markup</strong> (piercing fees, tools, diagnostics). One category path per line.</div>
    <textarea id="exempt" rows="3" spellcheck="false">${esc(exempt.join('\n'))}</textarea>

    <div class="subh">Rounding</div>
    <div class="prow"><label for="roundTo">Round up to</label><input id="roundTo" type="number" step="5" min="1" value="${esc(String(roundTo))}"><span class="ex">cents (50 = nearest $0.50)</span></div>
  </div>
  <button id="save" onclick="save()">Save</button><span id="status"></span>
<script>
function splitCsv(v){ return (v||'').split(',').map(function(x){return x.trim();}).filter(Boolean); }
function collectRules(){
  var out=[];
  document.querySelectorAll('#rules .rulerow').forEach(function(row){
    var metals=splitCsv(row.querySelector('.rmetals').value);
    var vendors=splitCsv(row.querySelector('.rvendors').value);
    var mult=parseFloat(row.querySelector('.rmult').value);
    if((metals.length||vendors.length) && isFinite(mult) && mult>0) out.push({metals:metals,vendors:vendors,multiplier:mult});
  });
  return out;
}
function addRule(){
  var wrap=document.createElement('div'); wrap.className='rulerow';
  function mk(cls,ph,num){ var i=document.createElement('input'); i.className=cls; if(ph)i.placeholder=ph; if(num){i.type='number';i.step='0.1';i.min='0';} return i; }
  wrap.appendChild(mk('rmetals','metals — e.g. 14k, gold'));
  wrap.appendChild(mk('rvendors','vendors — e.g. bvla'));
  wrap.appendChild(mk('rmult','',true));
  var rm=document.createElement('button'); rm.type='button'; rm.className='rmv'; rm.title='Remove rule'; rm.textContent='×';
  rm.addEventListener('click', function(){ wrap.remove(); });
  wrap.appendChild(rm);
  document.getElementById('rules').appendChild(wrap);
}
async function save(){
  var b=document.getElementById('save'), s=document.getElementById('status');
  b.disabled=true; s.textContent='Saving…';
  var exempt=(document.getElementById('exempt').value||'').split('\\n').map(function(x){return x.trim();}).filter(Boolean);
  var pricing={rules:collectRules(),default:parseFloat(document.getElementById('defMult').value),roundTo:parseInt(document.getElementById('roundTo').value,10),exempt:exempt};
  try{
    var res=await fetch('/settings',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({autoEnrichImages:document.getElementById('autoenrich').checked,pricing:pricing})});
    var j=await res.json();
    s.textContent = res.ok ? 'Saved ✓' : ('Error: '+(j.error||res.status));
  }catch(e){ s.textContent='Error: '+e.message; }
  b.disabled=false;
}
</script>
</body></html>`;
}
