// Vendors page (#42): a studio adds/trains a vendor itself — upload a sample invoice, confirm or
// correct the parsed lines, and those corrections become the vendor's shared parsing profile. No
// writes to Square; this only teaches extraction.

import type { VendorProfile } from '../lib/vendor-profile.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface VendorsPageState {
  profiles: VendorProfile[]; // already-learned vendors (shared across studios)
  vendors: string[]; // this studio's catalog vendors, for the picker
}

export function renderVendorsPage(s: VendorsPageState): string {
  const learned = s.profiles.length
    ? s.profiles
        .map(
          (p) =>
            `<li><strong>${esc(p.displayName)}</strong> <span class="muted">— ${p.sampleCount} sample${p.sampleCount === 1 ? '' : 's'}, ${p.examples.length} example${p.examples.length === 1 ? '' : 's'}${p.guidance.trim() ? ', has guidance' : ''}</span></li>`,
        )
        .join('')
    : '<li class="muted">Nothing learned yet — train your first vendor below.</li>';

  const options = s.vendors.map((v) => `<option value="${esc(v)}">`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vendors &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.75rem auto;max-width:1100px;color:#1a1a1a;padding:0 1rem}
  a{color:#2563eb;text-decoration:none} h2{margin:.25rem 0 .4rem} p{color:#444}
  .muted{color:#9ca3af;font-weight:400}
  ul{list-style:none;padding:0;margin:.25rem 0 1.25rem} li{padding:.3rem 0;border-bottom:1px solid #f3f4f6;font-size:14px}
  label{display:block;font-weight:600;font-size:13px;margin:.9rem 0 .3rem}
  input[type=text],textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:.45rem .55rem;border:1px solid #d1d5db;border-radius:6px}
  textarea{min-height:70px;resize:vertical}
  .row{display:flex;gap:1rem;align-items:flex-end;flex-wrap:wrap}
  .row>div{flex:1;min-width:220px}
  button{padding:.5rem 1rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit;font-size:13px}
  button:disabled{opacity:.5} button.sec{background:#fff;color:#374151;border-color:#d1d5db}
  #status{margin-left:.7rem;font-size:13px;color:#333}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:1rem}
  th,td{border-bottom:1px solid #eee;padding:.35rem .4rem;text-align:left;vertical-align:top}
  th{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  td input[type=text]{padding:.25rem .35rem;font-size:12.5px}
  .desc{color:#374151;max-width:270px;font-size:12px}
  .chg input{border-color:#d97706;background:#fffbeb}
  .hint{color:#6b7280;font-size:12.5px;margin:.2rem 0 0}
</style></head>
<body>
  <h2>Vendors</h2>
  <p>Punctum learns each vendor's quirks. Upload a sample invoice, fix anything it read wrong, and those corrections teach it for <strong>every</strong> studio going forward. Nothing here touches Square.</p>

  <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:1.2rem 0 .2rem">Learned vendors</h3>
  <ul>${learned}</ul>

  <div class="row">
    <div>
      <label for="vendor">Vendor</label>
      <input type="text" id="vendor" list="vendorlist" placeholder="e.g. Quetzalli" autocomplete="off">
      <datalist id="vendorlist">${options}</datalist>
    </div>
    <div>
      <label for="pdf">Sample invoice (PDF)</label>
      <input type="file" id="pdf" accept="application/pdf">
    </div>
    <div style="flex:0 0 auto"><button id="go" onclick="parseInvoice()">Parse invoice</button><span id="status"></span></div>
  </div>

  <div id="result"></div>

<script>
var ORIGINAL=[];
function abToB64(buf){ var b=new Uint8Array(buf), s='', c=0x8000; for(var i=0;i<b.length;i+=c){ s+=String.fromCharCode.apply(null, b.subarray(i,i+c)); } return btoa(s); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
var FIELDS=['sku','item_name','variation_name','gems','metal'];

async function parseInvoice(){
  var v=document.getElementById('vendor').value.trim(), f=document.getElementById('pdf').files[0];
  var st=document.getElementById('status'), b=document.getElementById('go'), r=document.getElementById('result');
  if(!v){ st.textContent='Enter a vendor name.'; return; }
  if(!f){ st.textContent='Pick a sample invoice.'; return; }
  b.disabled=true; r.innerHTML=''; st.textContent='Reading the invoice — up to ~60s…';
  try{
    var res=await fetch('/vendors/parse',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({vendorName:v,pdfBase64:abToB64(await f.arrayBuffer())})});
    var j=await res.json();
    if(!res.ok){ st.textContent='Error: '+(j.error||res.status); b.disabled=false; return; }
    ORIGINAL=j.lines||[];
    renderTable(ORIGINAL);
    st.textContent=ORIGINAL.length+' lines — fix anything wrong, then save.';
  }catch(e){ st.textContent='Error: '+e.message; }
  b.disabled=false;
}

function renderTable(lines){
  if(!lines.length){ document.getElementById('result').innerHTML='<p>No line items found in that PDF.</p>'; return; }
  var rows=lines.map(function(l,i){
    var cells=FIELDS.map(function(f){
      return '<td><input type="text" data-i="'+i+'" data-f="'+f+'" value="'+esc(l[f])+'"></td>';
    }).join('');
    return '<tr><td class="desc">'+esc(l.description)+'</td>'+cells+
      '<td style="text-align:center"><input type="checkbox" data-i="'+i+'" data-f="is_product"'+(l.is_product!==false?' checked':'')+'></td></tr>';
  }).join('');
  document.getElementById('result').innerHTML=
    '<table><thead><tr><th>Invoice line</th><th>SKU</th><th>Item name</th><th>Variation</th><th>Gems</th><th>Metal</th><th>Product?</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<label for="guidance">Anything the table can\\'t express (optional)</label>'+
    '<textarea id="guidance" placeholder="e.g. This vendor puts the gem in the description, and the size column is the bar length."></textarea>'+
    '<p class="hint">Saved corrections are shared — they improve this vendor for every studio.</p>'+
    '<div style="margin-top:.7rem"><button id="save" onclick="saveTraining()">Save corrections</button><span id="savestatus" style="margin-left:.7rem;font-size:13px"></span></div>';
  // Highlight fields as they're edited so it's obvious what will be taught.
  document.querySelectorAll('#result input').forEach(function(inp){
    inp.addEventListener('input', function(){ inp.parentNode.classList.add('chg'); });
    inp.addEventListener('change', function(){ inp.parentNode.classList.add('chg'); });
  });
}

function collect(){
  var out=ORIGINAL.map(function(l){ return Object.assign({}, l); });
  document.querySelectorAll('#result input').forEach(function(inp){
    var i=+inp.getAttribute('data-i'), f=inp.getAttribute('data-f');
    if(!out[i]) return;
    out[i][f] = (inp.type==='checkbox') ? inp.checked : inp.value;
  });
  return out;
}

async function saveTraining(){
  var b=document.getElementById('save'), st=document.getElementById('savestatus');
  b.disabled=true; st.textContent='Saving…';
  try{
    var res=await fetch('/vendors/train',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({vendorName:document.getElementById('vendor').value.trim(),before:ORIGINAL,after:collect(),
        guidance:(document.getElementById('guidance')||{}).value||''})});
    var j=await res.json();
    if(res.ok){ st.textContent='Saved — learned '+j.learned+' correction'+(j.learned===1?'':'s')+' ('+j.sampleCount+' sample'+(j.sampleCount===1?'':'s')+' total).'; }
    else { st.textContent='Error: '+(j.error||res.status); }
  }catch(e){ st.textContent='Error: '+e.message; }
  b.disabled=false;
}
</script>
</body></html>`;
}
