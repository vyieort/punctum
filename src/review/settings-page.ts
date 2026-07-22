// Per-client settings page. First control: auto-enrich images on/off (studios that shoot their
// own product photography turn it off and use manual upload / the bulk filmstrip instead).

import type { ClientSettings } from '../lib/client-settings.js';
import type { SquareConnection } from '../lib/square-account.js';
import type { PricingRules } from '../lib/pricing.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Metal is free-form text on invoices and rules match it as a substring, so there's no clean list to
// derive from data — this is the curated set worth pricing on. Picked from, never typed.
const METAL_OPTIONS = ['14k', '18k', 'Gold', 'Rose Gold', 'White Gold', 'Yellow Gold', 'Platinum', 'Titanium', 'Niobium', 'Steel', 'Silver', 'Glass'];

interface EditableRule { metals: string[]; vendors: string[]; multiplier: number; }

const eqi = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** Offered options plus anything already saved that isn't among them, so switching to pick-lists
 *  can never silently drop a value that's currently driving pricing. */
const withSaved = (options: string[], saved: string[]): string[] =>
  [...options, ...saved.filter((s) => !options.some((o) => eqi(o, s)))];

/** Present the stored pricing as editable rule rows. A legacy gold_when config is shown as rules,
 *  splitting metal vs vendor into separate rows so its OR semantics survive the round-trip. */
function editableRules(p: PricingRules): { rules: EditableRule[]; defaultMult: number; roundTo: number; exempt: string[] } {
  const roundTo = p.rounding?.to_cents ?? 50;
  const defaultMult = p.default_multiplier ?? p.multipliers?.default ?? 3.0;
  let rules: EditableRule[];
  if (p.rules && p.rules.length) {
    rules = p.rules.map((r) => ({ metals: r.metals ?? [], vendors: r.vendors ?? [], multiplier: r.multiplier }));
  } else {
    rules = [];
    const gm = p.multipliers?.gold ?? 2.5;
    const metals = p.gold_when?.metal_contains ?? [];
    const vendors = p.gold_when?.vendor_in ?? [];
    if (metals.length) rules.push({ metals, vendors: [], multiplier: gm });
    if (vendors.length) rules.push({ metals: [], vendors, multiplier: gm });
    if (!rules.length) rules.push({ metals: [], vendors: [], multiplier: gm });
  }
  const exempt = p.exempt_categories ?? ['Piercing Fee', 'Service & Tool Fees', 'Diagnostic'];
  return { rules, defaultMult, roundTo, exempt };
}

const chip = (cls: string, value: string, checked: boolean): string =>
  `<label class="chip"><input type="checkbox" class="${cls}" value="${esc(value)}"${checked ? ' checked' : ''}>${esc(value)}</label>`;

function ruleRowHtml(r: EditableRule, vendorList: string[]): string {
  const on = (list: string[], v: string): boolean => list.some((x) => eqi(x, v));
  const vendorOpts = withSaved(vendorList, r.vendors);
  return `<div class="rulerow">
        <div class="flab">Metals <span class="hint">— any of</span></div>
        <div class="chips">${withSaved(METAL_OPTIONS, r.metals).map((m) => chip('rm', m, on(r.metals, m))).join('')}</div>
        <div class="flab">Vendors <span class="hint">— any of</span></div>
        <div class="chips">${vendorOpts.length ? vendorOpts.map((v) => chip('rv', v, on(r.vendors, v))).join('') : '<span class="hint">No vendors in your catalog yet.</span>'}</div>
        <div class="rulefoot">
          <span class="flab" style="margin:0">Multiplier</span>
          <input class="rmult" type="number" step="0.1" min="0" value="${esc(String(r.multiplier))}">
          <span class="hint">× wholesale</span>
          <button type="button" class="rmv" onclick="this.closest('.rulerow').remove()">Remove rule</button>
        </div>
      </div>`;
}

export function renderSettingsPage(
  settings: ClientSettings,
  pricing: PricingRules,
  inbound: { common: string; direct: string; account: string | null },
  lists: { vendors: string[]; categories: string[] },
  connection?: SquareConnection,
  squareStatus?: string | null,
): string {
  const { rules: editRules, defaultMult, roundTo, exempt } = editableRules(pricing);
  const ruleRows = editRules.map((r) => ruleRowHtml(r, lists.vendors)).join('');
  const blankRule = ruleRowHtml({ metals: [], vendors: [], multiplier: 2.5 }, lists.vendors);
  const exemptOpts = withSaved(lists.categories, exempt);
  const exemptChips = exemptOpts.length
    ? exemptOpts.map((c) => chip('ex', c, exempt.some((e) => eqi(e, c)))).join('')
    : '<span class="hint">No categories yet — import your catalog first.</span>';
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
  .addr{margin-top:.4rem}
  .addr code{font-size:14px;background:#f3f4f6;padding:.3rem .55rem;border-radius:6px;user-select:all}
  .subh{font-weight:600;font-size:13px;margin:1rem 0 .4rem;color:#374151}
  /* Pick-lists: click a chip to toggle it on/off — nothing is typed. */
  .chips{display:flex;flex-wrap:wrap;gap:.35rem;margin:.15rem 0 .5rem}
  .chips.scroll{max-height:190px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px;padding:.5rem;background:#fff}
  .chip{display:inline-flex;align-items:center;padding:.22rem .6rem;border:1px solid #d1d5db;border-radius:999px;
    font-size:12px;cursor:pointer;user-select:none;background:#fff;color:#374151}
  .chip input{display:none}
  .chip:hover{border-color:#166534}
  .chip:has(input:checked){background:#166534;border-color:#166534;color:#fff}
  .flab{font-size:12px;font-weight:600;color:#374151;margin-top:.45rem}
  .hint{font-weight:400;color:#9ca3af;font-size:11px}
  .rulerow{border:1px solid #e5e7eb;border-radius:8px;padding:.6rem .7rem;margin:.5rem 0;background:#fafafa}
  .rulefoot{display:flex;align-items:center;gap:.5rem;margin-top:.5rem}
  .rulefoot input{width:82px;padding:.3rem .45rem;border:1px solid #d1d5db;border-radius:6px;font:inherit}
  .rmv{margin-left:auto;padding:.28rem .6rem;border:1px solid #e5e7eb;background:#fff;color:#b91c1c;border-radius:6px;cursor:pointer;font:inherit;font-size:12px}
  .addbtn{margin-top:.5rem;padding:.35rem .7rem;border:1px dashed #9ca3af;background:#fff;color:#374151;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}
  .tokdet{margin:-.4rem 0 1rem;font-size:13px}
  .tokdet summary{cursor:pointer;color:#2563eb;margin-bottom:.3rem}
  .tokdet input{width:100%;box-sizing:border-box;margin:.4rem 0;padding:.4rem .5rem;border:1px solid #d1d5db;border-radius:6px;font:inherit;font-size:13px}
  .tokrow{display:flex;align-items:center;gap:.6rem}
  .tokdet button{padding:.35rem .8rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}
  .tokdet button:disabled{opacity:.5}
</style></head>
<body>
  <p><a href="/">← Home</a></p>
  <h2>Settings</h2>
  ${banner}
  ${squareCard}
  <details class="tokdet">
    <summary>Connect with an access token instead</summary>
    <div class="d">For sandbox testing. Square's sandbox consent page currently renders blank, so the browser flow can't finish there. In the Square Developer Console, authorize a test account, copy its access token, and paste it here — it's stored encrypted exactly like an OAuth token.</div>
    <input id="sqtok" type="password" placeholder="Square access token" autocomplete="off" spellcheck="false">
    <div class="tokrow"><button type="button" id="sqtokgo" onclick="saveToken()">Save token</button><span id="sqtokstatus"></span></div>
  </details>
  <div class="card">
    <div class="t">Email invoices in</div>
    <div class="d">Forward a vendor invoice PDF from your account email${inbound.account ? ` (<strong>${esc(inbound.account)}</strong>)` : ''} to the address below and it lands in your review queue automatically — no manual upload.</div>
    <div class="addr"><code>${esc(inbound.common)}</code></div>
    ${inbound.direct
      ? `<div class="d" style="margin-top:.7rem">Or point a vendor straight at your studio's private address (no forwarding needed):</div>
    <div class="addr"><code>${esc(inbound.direct)}</code></div>`
      : ''}
  </div>
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
    <div id="rules">${ruleRows}</div>
    <template id="ruletpl">${blankRule}</template>
    <button type="button" class="addbtn" onclick="addRule()">+ Add rule</button>

    <div class="subh">Fee &amp; service exemptions</div>
    <div class="d">Click a category to price it at cost — <strong>no markup</strong> (piercing fees, tools, diagnostics). Click again to remove it.</div>
    <div class="chips scroll">${exemptChips}</div>

    <div class="subh">Rounding</div>
    <div class="prow"><label for="roundTo">Round up to</label><input id="roundTo" type="number" step="5" min="1" value="${esc(String(roundTo))}"><span class="ex">cents (50 = nearest $0.50)</span></div>
  </div>
  <button id="save" onclick="save()">Save</button><span id="status"></span>
<script>
async function saveToken(){
  var el=document.getElementById('sqtok'), s=document.getElementById('sqtokstatus'), b=document.getElementById('sqtokgo');
  var t=(el.value||'').trim();
  if(!t){ s.textContent='Paste a token first.'; return; }
  b.disabled=true; s.textContent='Checking the token…';
  try{
    var res=await fetch('/settings/square-token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t})});
    var j=await res.json();
    if(res.ok){ el.value=''; s.textContent='Connected ✓ '+(j.locationName||j.locationId)+' — reloading…'; setTimeout(function(){ location.reload(); }, 900); }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
function checkedIn(root, sel){ return [].slice.call(root.querySelectorAll(sel)).map(function(i){ return i.value; }); }
function collectRules(){
  var out=[];
  document.querySelectorAll('#rules .rulerow').forEach(function(row){
    var metals=checkedIn(row,'.rm:checked');
    var vendors=checkedIn(row,'.rv:checked');
    var mult=parseFloat(row.querySelector('.rmult').value);
    if((metals.length||vendors.length) && isFinite(mult) && mult>0) out.push({metals:metals,vendors:vendors,multiplier:mult});
  });
  return out;
}
function addRule(){
  var tpl=document.getElementById('ruletpl');
  document.getElementById('rules').appendChild(tpl.content.cloneNode(true));
}
async function save(){
  var b=document.getElementById('save'), s=document.getElementById('status');
  b.disabled=true; s.textContent='Saving…';
  var exempt=checkedIn(document,'.ex:checked');
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
