// The learning-loop report: render recurring corrections as import-rule fix candidates. This is
// what keeps manual editing from becoming a treadmill — recurring fixes here mean the source rule
// (category_map / classification / naming convention) should change, not the individual items.

import type { EditPatternsReport } from './catalog-edit.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPatternsPage(r: EditPatternsReport): string {
  const byField = Object.entries(r.byField)
    .map(([f, n]) => `${n} ${esc(f)}`)
    .join(' · ');

  const catRows = r.categoryCandidates
    .map(
      (p) => `<tr>
        <td>${esc(p.vendor) || '<span class="dim">any</span>'}</td>
        <td>${esc(p.from) || '<span class="dim">(none)</span>'}</td>
        <td class="arrow">→</td>
        <td><strong>${esc(p.to)}</strong></td>
        <td class="count">${p.count}×</td>
      </tr>`,
    )
    .join('');

  const nameVendorRows = r.nameOverridesByVendor
    .map((v) => `<li><strong>${esc(v.vendor)}</strong> — ${v.count} name override${v.count > 1 ? 's' : ''}</li>`)
    .join('');

  const nameDevRows = r.recentNameDeviations
    .map((p) => `<tr><td>${esc(p.vendor) || '<span class="dim">?</span>'}</td><td>${esc(p.from)}</td><td class="arrow">→</td><td>${esc(p.to)}</td></tr>`)
    .join('');

  const catSection = r.categoryCandidates.length
    ? `<table>
        <thead><tr><th>Vendor</th><th>From category</th><th></th><th>To category</th><th>Times</th></tr></thead>
        <tbody>${catRows}</tbody>
      </table>
      <p class="hint">Each recurring move suggests the <code>category_map</code> (or the classifier's category rule) is sending these items to the wrong place. Fixing it at the source means the next invoice lands them correctly with no manual edit.</p>`
    : `<p class="empty">No repeated category moves yet. When the same vendor + category correction happens twice, it shows up here as a rule to fix.</p>`;

  const nameSection = r.nameOverridesByVendor.length
    ? `<ul class="vendorlist">${nameVendorRows}</ul>
       <p class="hint">High counts mean that vendor's items are frequently renamed by hand — a sign the naming convention (the tagger) should be adjusted so the importer produces the right name itself.</p>
       ${r.recentNameDeviations.length ? `<table class="devtable"><thead><tr><th>Vendor</th><th>Was</th><th></th><th>Changed to</th></tr></thead><tbody>${nameDevRows}</tbody></table>` : ''}`
    : `<p class="empty">No off-convention name edits recorded.</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corrections & patterns</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:900px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} h3{margin:1.6rem 0 .5rem;font-size:16px}
  .sub{color:#555;margin:0 0 1rem;font-size:14px}
  a{color:#2563eb}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:.5rem}
  th,td{border-bottom:1px solid #eee;padding:.45rem .6rem;text-align:left;vertical-align:top}
  th{color:#666;font-weight:600}
  .arrow{color:#9ca3af;text-align:center;width:24px} .count{font-weight:600;color:#166534;white-space:nowrap}
  .dim{color:#9ca3af} .hint{color:#4b5563;font-size:13px;margin:.5rem 0 0;background:#f8fafc;border-left:3px solid #2563eb;padding:.5rem .75rem;border-radius:0 6px 6px 0}
  .empty{color:#6b7280;font-size:14px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:6px;padding:.75rem}
  .vendorlist{margin:.25rem 0;color:#374151;font-size:14px} .devtable{margin-top:.75rem}
  code{background:#f3f4f6;padding:.05rem .3rem;border-radius:4px;font-size:12px}
  .back{font-size:13px}
  #clearlog{font:inherit;font-size:12px;padding:.3rem .7rem;border:1px solid #b45309;color:#b45309;background:#fff;border-radius:6px;cursor:pointer}
  #clearlog:disabled{opacity:.5;cursor:default}
</style></head>
<body>
  <a class="back" href="/catalog">← Back to catalog</a>
  <h2>Corrections &amp; patterns</h2>
  <p class="sub">${r.totalEdits} edit${r.totalEdits === 1 ? '' : 's'} logged${byField ? ' — ' + esc(byField) : ''}. This turns hand-edits into import-rule improvements, so the same fix isn't needed on every invoice. It's advisory — nothing here changes the importer automatically.</p>
  <p><button id="clearlog">Clear log</button> <span id="clearstatus" class="dim"></span></p>
  <script>
  document.getElementById('clearlog').addEventListener('click', async function(){
    if(!confirm('Clear the correction log? Use this to discard test edits. It does not change anything in Square.')) return;
    var b=this, s=document.getElementById('clearstatus'); b.disabled=true; s.textContent='Clearing…';
    try{
      var res=await fetch('/catalog/edits/clear?client=RE',{method:'POST'});
      var j=await res.json();
      if(res.ok){ s.textContent='Cleared '+j.cleared+' — reloading…'; setTimeout(function(){ location.reload(); }, 500); }
      else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
    }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
  });
  </script>

  <h3>Category fix candidates</h3>
  ${catSection}

  <h3>Naming deviations</h3>
  ${nameSection}
</body></html>`;
}
