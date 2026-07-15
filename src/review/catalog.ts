// Catalog review page: a sticky ~500px preview pinned on top, and a scrolling list of every
// catalog_mapping variation beneath it. Each imaged row shows a 50x50 thumbnail (click to
// enlarge in the preview). Rows that kept a candidate pool from enrichment get a "Review
// alternatives" button: it shows the 5-10 candidates as a gallery up top, and you either pick
// a different one (replaces the Square image) or clear it — no re-search, no re-running Vision.

import type { Queryable } from '../jobs/pg-rows.js';
import {
  squareConfigFromEnv,
  deleteCatalogObject,
  downloadImage,
  attachVariationImage,
  setItemImage,
  isAllowedImageType,
  type SquareConfig,
} from '../lib/square-client.js';

export interface CatalogRow {
  seq: string;
  vendor: string;
  vendorSku: string;
  itemName: string; // base name (tag suffix stripped)
  tags: string;
  variationName: string;
  status: string;
  wholesalePrice: string;
  retailPrice: string;
  categoryPath: string;
  description: string;
  imageUrl: string;
  hasCandidates: boolean;
  squareItemId: string;
}

const stripTagSuffix = (name: string): string => name.replace(/\s*\[.*\]\s*$/, '').trim();

export async function getCatalogRows(db: Queryable, clientId: string, limit = 1000): Promise<CatalogRow[]> {
  const { rows } = await db.query(
    `select seq, vendor, vendor_sku, square_item_id, item_name, variation_name, tags,
            status::text as status, wholesale_price::text as wholesale_price, retail_price::text as retail_price,
            coalesce(category_path, '') as category_path, coalesce(item_description, '') as item_description,
            image_url, coalesce(image_candidates, '') <> '' as has_candidates
       from catalog_mapping
      where client_id = $1 and coalesce(square_variation_id, '') <> ''
      order by item_name, variation_name
      limit $2`,
    [clientId, limit],
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const str = (v: unknown): string => (v == null ? '' : String(v));
    return {
      seq: str(row.seq),
      vendor: str(row.vendor),
      vendorSku: str(row.vendor_sku),
      itemName: stripTagSuffix(str(row.item_name)),
      tags: str(row.tags),
      variationName: str(row.variation_name),
      status: str(row.status),
      wholesalePrice: str(row.wholesale_price),
      retailPrice: str(row.retail_price),
      categoryPath: str(row.category_path),
      description: str(row.item_description),
      imageUrl: str(row.image_url),
      hasCandidates: row.has_candidates === true,
      squareItemId: str(row.square_item_id),
    };
  });
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS_COLOR: Record<string, string> = {
  ENRICHED: '#166534',
  NO_IMAGE: '#b45309',
  PENDING: '#6b7280',
  PUSHED: '#166534',
  NEEDS_REVIEW: '#b91c1c',
};

export function renderCatalogPage(rows: CatalogRow[], categoryPaths: string[] = []): string {
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const countLine = Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');

  const catOptions = (sel: string): string => {
    const inList = categoryPaths.includes(sel);
    const opts = [`<option value=""${sel === '' ? ' selected' : ''}>—</option>`];
    if (sel && !inList) opts.push(`<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
    for (const p of categoryPaths) opts.push(`<option value="${esc(p)}"${p === sel ? ' selected' : ''}>${esc(p)}</option>`);
    return opts.join('');
  };
  const bulkCatOptions = ['<option value="">Bulk category…</option>', ...categoryPaths.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)].join('');

  const body = rows
    .map((r) => {
      const color = STATUS_COLOR[r.status] ?? '#6b7280';
      const caption = `${r.itemName}${r.variationName ? ' — ' + r.variationName : ''}`;
      const thumb = r.imageUrl
        ? `<img class="thumb" src="${esc(r.imageUrl)}" data-url="${esc(r.imageUrl)}" data-cap="${esc(caption)}" loading="lazy" alt="" title="Click to enlarge">`
        : '<span class="nothumb">—</span>';
      const useItem = r.imageUrl
        ? `<button class="useitem" data-seq="${esc(r.seq)}" title="Use this image as the item's grid image">&#9733; item</button>`
        : '';
      const urlCell = r.imageUrl
        ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noreferrer" class="url">${esc(r.imageUrl)}</a>`
        : '';
      const wholesale = r.wholesalePrice ? `$${esc(r.wholesalePrice)}` : '';
      const alts = r.hasCandidates
        ? `<button class="alts" data-seq="${esc(r.seq)}" data-cap="${esc(caption)}">Review alternatives</button>`
        : '';
      return `<tr id="row-${esc(r.seq)}">
        <td class="chkcell"><input type="checkbox" class="rowchk" data-seq="${esc(r.seq)}"></td>
        <td class="showcell">${thumb}${useItem}</td>
        <td class="editcell">
          <input class="ename edit" data-seq="${esc(r.seq)}" data-field="itemName" data-orig="${esc(r.itemName)}" data-canon="${esc(r.itemName)}" value="${esc(r.itemName)}">
          ${r.squareItemId ? `<a class="itemlink" href="/items/${esc(r.squareItemId)}" title="Open item detail page">&#8599;</a>` : ''}<span class="warn" title="Off the naming convention — logged for review">&#9888;</span>
          <div class="canon">convention: ${esc(r.itemName) || '—'}</div>
          <input class="edesc edit" data-seq="${esc(r.seq)}" data-field="description" data-orig="${esc(r.description)}" value="${esc(r.description)}" placeholder="description…">
          ${r.tags ? `<div class="tags">${esc(r.tags)}</div>` : ''}
        </td>
        <td>${esc(r.variationName)}</td>
        <td><select class="ecat edit" data-seq="${esc(r.seq)}" data-field="categoryPath" data-orig="${esc(r.categoryPath)}">${catOptions(r.categoryPath)}</select></td>
        <td>${esc(r.vendor)}</td>
        <td class="mono">${esc(r.vendorSku)}</td>
        <td class="wcell">${wholesale}</td>
        <td><input class="eprice edit" data-seq="${esc(r.seq)}" data-field="retailPrice" data-orig="${esc(r.retailPrice)}" value="${esc(r.retailPrice)}" inputmode="decimal"></td>
        <td><span class="badge" style="background:${color}">${esc(r.status)}</span></td>
        <td>${alts}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalog review</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:0 auto;max-width:1280px;color:#1a1a1a;padding:1.25rem 1rem}
  h2{margin:0 0 .25rem} .sub{color:#555;margin:0 0 .75rem;font-size:14px}
  #preview{position:sticky;top:0;background:#fff;border-bottom:2px solid #eee;padding:.5rem 0 .9rem;z-index:5;
    display:flex;flex-direction:column;align-items:center}
  #pv{width:500px;height:500px;max-width:100%;object-fit:contain;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px}
  #pvempty{width:500px;max-width:100%;height:180px;display:flex;align-items:center;justify-content:center;
    color:#9ca3af;border:1px dashed #d1d5db;border-radius:8px;font-size:14px}
  .pvmeta{margin-top:.5rem;font-size:13px;color:#374151;text-align:center}
  .pvmeta a{color:#2563eb;margin-left:.5rem}
  #gallery{display:none;width:100%;max-width:800px}
  .galtitle{font-size:13px;color:#374151;margin:.25rem 0 .6rem;text-align:center}
  .galgrid{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
  .galimg{width:140px;height:140px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;cursor:pointer;background:#f3f4f6}
  .galimg:hover{outline:2px solid #2563eb}
  .galclear{margin:.8rem auto 0;display:block;font:inherit;font-size:13px;padding:.35rem .8rem;border:1px solid #b45309;color:#b45309;background:#fff;border-radius:6px;cursor:pointer}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:.5rem .6rem;text-align:left;vertical-align:top}
  th{color:#666;font-weight:600}
  .showcell{width:66px}
  .thumb{width:50px;height:50px;object-fit:cover;border-radius:5px;border:1px solid #e5e7eb;background:#f3f4f6;cursor:pointer;display:block}
  .nothumb{color:#9ca3af}
  .useitem{margin-top:3px;font:inherit;font-size:10px;padding:.12rem .2rem;border:1px solid #7c3aed;color:#7c3aed;background:#fff;border-radius:4px;cursor:pointer;display:block;width:100%;white-space:nowrap}
  .useitem:disabled{opacity:.6}
  .item{font-weight:600} .tags{color:#6b7280;font-size:11px;margin-top:2px}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#374151}
  .badge{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600;white-space:nowrap}
  .url{color:#2563eb;font-size:11px;word-break:break-all;display:inline-block;max-width:280px} .url-td{max-width:300px}
  .alts{font:inherit;font-size:12px;padding:.25rem .6rem;border:1px solid #2563eb;color:#2563eb;background:#fff;border-radius:6px;cursor:pointer;white-space:nowrap}
  .alts:disabled{opacity:.6;cursor:default}
  tr.active{background:#f0fdf4} tr.active .thumb{outline:2px solid #166534}
  #editbar{position:sticky;top:0;z-index:6;background:#fff;border-bottom:1px solid #e5e7eb;padding:.5rem 0;margin-bottom:.25rem;
    display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;font-size:13px}
  #editbar select{font:inherit;font-size:12px;padding:.25rem;max-width:260px}
  #editbar .sep{flex:1}
  #dirtycount{color:#6b7280}
  #bulkapply,#pushbtn{font:inherit;font-size:12px;padding:.35rem .7rem;border-radius:6px;cursor:pointer;border:1px solid #166534;background:#166534;color:#fff}
  #bulkapply{border-color:#2563eb;background:#2563eb}
  #synccat{border-color:#6b7280;background:#fff;color:#374151}
  #bulkapply:disabled,#pushbtn:disabled,#synccat:disabled{opacity:.45;cursor:default}
  .patlink{color:#2563eb;font-size:12px}
  #pushstatus{color:#374151;font-size:12px}
  .chkcell{width:28px}
  .editcell{min-width:230px}
  input.edit,select.edit{font:inherit;font-size:12px;padding:.2rem .3rem;border:1px solid #d1d5db;border-radius:4px;width:100%;box-sizing:border-box}
  input.ename{font-weight:600}
  .itemlink{color:#2563eb;text-decoration:none;font-size:12px;margin-left:2px}
  input.eprice{width:74px}
  .edesc{margin-top:3px;color:#374151}
  tr.dirty{background:#fffbeb} tr.dirty td{border-bottom-color:#fde68a}
  input.dirty,select.dirty{border-color:#d97706;background:#fffbeb}
  .canon{color:#9ca3af;font-size:10px;margin:2px 0;display:none}
  .warn{color:#b45309;display:none;font-size:12px;margin-left:2px}
  tr.diverged .warn{display:inline} tr.diverged .canon{display:block}
</style></head>
<body>
  <h2>Catalog review</h2>
  <p class="sub">${rows.length} variations${countLine ? ' — ' + esc(countLine) : ''}. Click a <strong>thumbnail</strong> to preview it large up top. <strong>Review alternatives</strong> shows the other candidates — pick a better one or clear the image.</p>
  <div id="preview">
    <img id="pv" alt="" style="display:none">
    <div id="pvempty">Click a thumbnail to preview its image here (500×500).</div>
    <div id="gallery"></div>
    <div class="pvmeta"><span id="pvcap"></span><a id="pvlink" href="#" target="_blank" rel="noreferrer" style="display:none">open full size ↗</a></div>
  </div>
  <div id="editbar">
    <select id="bulkcat">${bulkCatOptions}</select>
    <button id="bulkapply" disabled>Set on selected (0)</button>
    <button id="synccat" title="Fill the category column from the live Square catalog">Sync categories</button>
    <span class="sep"></span>
    <span id="dirtycount">No changes</span>
    <button id="pushbtn" disabled>Push changes to Square</button>
    <a class="patlink" href="/catalog/edits">Corrections &amp; patterns →</a>
    <span id="pushstatus"></span>
  </div>
  <table>
    <thead><tr><th><input type="checkbox" id="chkall"></th><th></th><th>Item &amp; description</th><th>Variation</th><th>Category</th><th>Vendor</th><th>SKU</th><th>Wholesale</th><th>Retail</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>
<script>
var activeSeq=null, activeTr=null, activeCap='';
function setActive(tr){ document.querySelectorAll('tr.active').forEach(function(t){t.classList.remove('active');}); if(tr) tr.classList.add('active'); }
function showSingle(url, cap, tr){
  document.getElementById('gallery').style.display='none';
  var pv=document.getElementById('pv'); pv.src=url; pv.style.display='block';
  document.getElementById('pvempty').style.display='none';
  document.getElementById('pvcap').textContent=cap||'';
  var l=document.getElementById('pvlink'); l.href=url; l.style.display='inline';
  setActive(tr);
}
document.querySelectorAll('.thumb').forEach(function(b){
  b.addEventListener('click', function(){ showSingle(b.getAttribute('data-url'), b.getAttribute('data-cap'), b.closest('tr')); });
});
document.querySelectorAll('.useitem').forEach(function(b){
  b.addEventListener('click', async function(){
    var t=b.textContent; b.disabled=true; b.textContent='…';
    try{
      var r=await fetch('/catalog/set-item-image?client=RE&seq='+encodeURIComponent(b.getAttribute('data-seq')),{method:'POST'});
      if(r.ok){ b.textContent='✓ item'; } else { b.disabled=false; b.textContent=t; alert('Error '+r.status); }
    }catch(e){ b.disabled=false; b.textContent=t; alert(e.message); }
  });
});
document.querySelectorAll('.alts').forEach(function(b){
  b.addEventListener('click', async function(){
    activeSeq=b.getAttribute('data-seq'); activeTr=b.closest('tr'); activeCap=b.getAttribute('data-cap');
    b.disabled=true; b.textContent='…';
    try{
      var res=await fetch('/catalog/candidates?client=RE&seq='+encodeURIComponent(activeSeq));
      var j=await res.json();
      renderGallery(j.candidates||[]); setActive(activeTr);
    }catch(e){ alert(e.message); }
    b.disabled=false; b.textContent='Review alternatives';
  });
});
function renderGallery(cands){
  var g=document.getElementById('gallery'); g.innerHTML='';
  document.getElementById('pv').style.display='none'; document.getElementById('pvempty').style.display='none';
  var t=document.createElement('div'); t.className='galtitle'; t.textContent=(cands.length?'Pick the best match for: ':'No stored candidates for: ')+activeCap; g.appendChild(t);
  var grid=document.createElement('div'); grid.className='galgrid';
  cands.forEach(function(c){
    var im=document.createElement('img'); im.src=c.thumb; im.className='galimg'; im.title='Use this image';
    im.addEventListener('click', function(){ useImage(c.pushUrl, c.thumb, im); });
    grid.appendChild(im);
  });
  g.appendChild(grid);
  var clr=document.createElement('button'); clr.className='galclear'; clr.textContent='✕ None of these — clear image';
  clr.addEventListener('click', clearImg); g.appendChild(clr);
  g.style.display='block';
}
async function useImage(url, thumb, im){
  im.style.outline='3px solid #166534';
  try{
    var res=await fetch('/catalog/set-image?client=RE&seq='+encodeURIComponent(activeSeq)+'&url='+encodeURIComponent(url)+'&thumb='+encodeURIComponent(thumb||''),{method:'POST'});
    if(res.ok){
      var th=activeTr.querySelector('.thumb'); if(th){ th.src=url; th.setAttribute('data-url', url); }
      var badge=activeTr.querySelector('.badge'); if(badge){ badge.textContent='ENRICHED'; badge.style.background='#166534'; }
      var u=activeTr.querySelector('.url'); if(u){ u.href=url; u.textContent=url; }
      showSingle(url, activeCap, activeTr);
    } else { im.style.outline=''; alert('Error '+res.status); }
  }catch(e){ im.style.outline=''; alert(e.message); }
}
async function clearImg(){
  try{
    var res=await fetch('/catalog/clear-image?client=RE&seq='+encodeURIComponent(activeSeq),{method:'POST'});
    if(res.ok){
      var th=activeTr.querySelector('.thumb'); if(th){ var d=document.createElement('span'); d.className='nothumb'; d.textContent='—'; th.replaceWith(d); }
      var badge=activeTr.querySelector('.badge'); if(badge){ badge.textContent='NO_IMAGE'; badge.style.background='#b45309'; }
      var u=activeTr.querySelector('.url'); if(u) u.remove();
      document.getElementById('gallery').style.display='none'; document.getElementById('pvempty').style.display='flex';
    } else alert('Error '+res.status);
  }catch(e){ alert(e.message); }
}

// --- Batch editing: dirty tracking, divergence flag, bulk category, push ---
function alnum(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function fieldDirty(el){ return el.value !== el.getAttribute('data-orig'); }
function refreshRow(tr){
  var dirty=false;
  tr.querySelectorAll('.edit').forEach(function(el){ var d=fieldDirty(el); el.classList.toggle('dirty', d); if(d) dirty=true; });
  tr.classList.toggle('dirty', dirty);
  var nm=tr.querySelector('.ename');
  if(nm){ var div = nm.value.trim()!=='' && alnum(nm.value)!==alnum(nm.getAttribute('data-canon')); tr.classList.toggle('diverged', div); }
}
function refreshCounts(){
  var n=document.querySelectorAll('tr.dirty').length;
  document.getElementById('dirtycount').textContent = n ? (n+' row'+(n>1?'s':'')+' changed') : 'No changes';
  document.getElementById('pushbtn').disabled = n===0;
  var chk=document.querySelectorAll('.rowchk:checked').length;
  var bc=document.getElementById('bulkcat');
  document.getElementById('bulkapply').disabled = chk===0 || !bc.value;
  document.getElementById('bulkapply').textContent='Set on selected ('+chk+')';
}
document.querySelectorAll('.edit').forEach(function(el){
  el.addEventListener('input', function(){ refreshRow(el.closest('tr')); refreshCounts(); });
  el.addEventListener('change', function(){ refreshRow(el.closest('tr')); refreshCounts(); });
});
document.querySelectorAll('.rowchk').forEach(function(c){ c.addEventListener('change', refreshCounts); });
document.getElementById('chkall').addEventListener('change', function(e){
  document.querySelectorAll('.rowchk').forEach(function(c){ c.checked=e.target.checked; }); refreshCounts();
});
document.getElementById('bulkcat').addEventListener('change', refreshCounts);
document.getElementById('bulkapply').addEventListener('click', function(){
  var val=document.getElementById('bulkcat').value; if(!val) return;
  document.querySelectorAll('.rowchk:checked').forEach(function(c){
    var tr=c.closest('tr'), sel=tr.querySelector('.ecat'); if(sel){ sel.value=val; refreshRow(tr); }
  });
  refreshCounts();
});
document.getElementById('pushbtn').addEventListener('click', async function(){
  var edits=[];
  document.querySelectorAll('tr.dirty').forEach(function(tr){
    var e={ seq: tr.querySelector('.edit').getAttribute('data-seq') };
    tr.querySelectorAll('.edit').forEach(function(el){ if(fieldDirty(el)) e[el.getAttribute('data-field')]=el.value; });
    edits.push(e);
  });
  if(!edits.length) return;
  var btn=document.getElementById('pushbtn'), st=document.getElementById('pushstatus');
  btn.disabled=true; st.textContent='Pushing '+edits.length+' row(s) to Square…';
  try{
    var res=await fetch('/catalog/edits?client=RE',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edits:edits})});
    var j=await res.json();
    if(res.ok){
      st.textContent='Pushed — '+j.fieldsChanged+' field(s) on '+j.rowsChanged+' row(s)'+(j.errors&&j.errors.length?', '+j.errors.length+' error(s) (see console)':'')+'.';
      var errSeqs={}; (j.errors||[]).forEach(function(x){ errSeqs[x.seq]=1; });
      document.querySelectorAll('tr.dirty').forEach(function(tr){
        var seq=tr.querySelector('.edit').getAttribute('data-seq'); if(errSeqs[seq]) return;
        tr.querySelectorAll('.edit').forEach(function(el){ el.setAttribute('data-orig', el.value); el.classList.remove('dirty'); });
        var nm=tr.querySelector('.ename'); if(nm) nm.setAttribute('data-canon', nm.value);
        tr.classList.remove('dirty'); tr.classList.remove('diverged');
      });
      refreshCounts();
      if(j.errors&&j.errors.length) console.log('edit errors', j.errors);
    } else { st.textContent='Error: '+(j.error||res.status); btn.disabled=false; }
  }catch(e){ st.textContent='Error: '+e.message; btn.disabled=false; }
});
document.querySelectorAll('.ename').forEach(function(el){ refreshRow(el.closest('tr')); });

// Arrow Up/Down move between rows in the same column (and stop a <select> from opening its overlay).
document.querySelectorAll('.edit').forEach(function(el){
  el.addEventListener('keydown', function(ev){
    if(ev.key!=='ArrowDown' && ev.key!=='ArrowUp') return;
    ev.preventDefault();
    var tr=el.closest('tr');
    var next = ev.key==='ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
    var target = next ? next.querySelector('[data-field="'+el.getAttribute('data-field')+'"]') : null;
    if(target){ target.focus(); if(target.select){ try{ target.select(); }catch(e){} } }
  });
});

// Fill the category column from Square, then reload to show it.
var sc=document.getElementById('synccat');
if(sc) sc.addEventListener('click', async function(){
  sc.disabled=true; var st=document.getElementById('pushstatus'); st.textContent='Reading categories from Square…';
  try{
    var res=await fetch('/catalog/sync-categories?client=RE',{method:'POST'});
    var j=await res.json();
    if(res.ok){ st.textContent='Synced '+j.updated+' row(s) from '+j.matched+' item(s) — reloading…'; setTimeout(function(){ location.reload(); }, 700); }
    else { st.textContent='Error: '+(j.error||res.status); sc.disabled=false; }
  }catch(e){ st.textContent='Error: '+e.message; sc.disabled=false; }
});
</script>
</body></html>`;
}

// --- Alternatives backend: read candidates, replace the image, or clear it. ---

export interface ImageEditOps {
  deleteImage(imageId: string): Promise<void>;
  download(url: string): Promise<{ bytes: Buffer; contentType: string }>;
  attach(opts: { variationId: string; itemName: string; bytes: Buffer; contentType?: string; sourceUrl?: string }): Promise<{ imageId: string; url: string }>;
  setItemImage(itemId: string, imageId: string): Promise<void>;
}

/** Download the first URL that is a Square-allowed image type (full-size, then thumbnail). */
async function downloadValidated(
  ops: ImageEditOps,
  urls: Array<string | undefined>,
): Promise<{ bytes: Buffer; contentType: string; url: string } | null> {
  for (const url of urls) {
    if (!url) continue;
    try {
      const dl = await ops.download(url);
      if (isAllowedImageType(dl.contentType)) return { bytes: dl.bytes, contentType: dl.contentType, url };
    } catch {
      // try the next url
    }
  }
  return null;
}

export function liveImageEditOps(cfg: SquareConfig): ImageEditOps {
  return {
    deleteImage: (id) => deleteCatalogObject(cfg, id),
    download: (url) => downloadImage(url),
    attach: (o) => attachVariationImage(cfg, o),
    setItemImage: (itemId, imageId) => setItemImage(cfg, itemId, imageId),
  };
}

/** Promote a variation's image to its item's primary (grid) image — a reviewer override. */
export async function setItemImageFromRow(
  db: Queryable,
  clientId: string,
  seq: string,
  opts: { ops?: ImageEditOps } = {},
): Promise<{ ok: boolean }> {
  const ops = opts.ops ?? liveImageEditOps(squareConfigFromEnv());
  const { rows } = await db.query(
    `select square_item_id, square_image_id from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { ok: false };
  const row = rows[0] as { square_item_id: string | null; square_image_id: string | null };
  if (!row.square_item_id || !row.square_image_id) return { ok: false };
  await ops.setItemImage(row.square_item_id, row.square_image_id);
  return { ok: true };
}

export interface Candidate {
  thumb: string;
  pushUrl: string;
}

export async function getCandidates(
  db: Queryable,
  clientId: string,
  seq: string,
): Promise<{ candidates: Candidate[]; itemName: string }> {
  const { rows } = await db.query(
    `select item_name, image_candidates from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { candidates: [], itemName: '' };
  const row = rows[0] as { item_name: string | null; image_candidates: string | null };
  let candidates: Candidate[] = [];
  try {
    candidates = row.image_candidates ? (JSON.parse(row.image_candidates) as Candidate[]) : [];
  } catch {
    candidates = [];
  }
  return { candidates, itemName: stripTagSuffix(row.item_name ?? '') };
}

/** Replace the variation's image with a reviewer-chosen candidate (thumbnail as fallback). */
export async function setVariationImage(
  db: Queryable,
  clientId: string,
  seq: string,
  chosenUrl: string,
  thumbUrl: string,
  opts: { ops?: ImageEditOps } = {},
): Promise<{ ok: boolean }> {
  const ops = opts.ops ?? liveImageEditOps(squareConfigFromEnv());
  const { rows } = await db.query(
    `select square_variation_id, item_name, square_image_id from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { ok: false };
  const row = rows[0] as { square_variation_id: string; item_name: string | null; square_image_id: string | null };

  // Get a valid image before touching the existing one, so a bad URL never leaves it blank.
  const dl = await downloadValidated(ops, [chosenUrl, thumbUrl]);
  if (!dl) return { ok: false };

  if (row.square_image_id) await ops.deleteImage(row.square_image_id).catch(() => {});
  const attached = await ops.attach({
    variationId: row.square_variation_id,
    itemName: row.item_name ?? '',
    bytes: dl.bytes,
    contentType: dl.contentType,
    sourceUrl: dl.url,
  });
  await db.query(
    `update catalog_mapping set status = 'ENRICHED', image_url = $3, square_image_id = $4, updated_at = now()
       where client_id = $1 and seq = $2`,
    [clientId, seq, dl.url, attached.imageId],
  );
  return { ok: true };
}

/**
 * Attach an operator-uploaded photo (raw bytes) to a variation's Square image — the studios'
 * own-photography path. Unlike setVariationImage it doesn't download from a URL; the bytes are the
 * upload. Explicit user action, so it replaces any existing image (delete-then-attach). A unique
 * sourceUrl per upload keeps the Square idempotency key fresh (re-uploading = a new image).
 */
export async function uploadVariationImage(
  db: Queryable,
  clientId: string,
  seq: string,
  file: { bytes: Buffer; contentType: string },
  opts: { ops?: ImageEditOps; setItem?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!isAllowedImageType(file.contentType)) {
    return { ok: false, error: `unsupported image type: ${file.contentType || 'unknown'}` };
  }
  if (file.bytes.length === 0) return { ok: false, error: 'empty upload' };
  const ops = opts.ops ?? liveImageEditOps(squareConfigFromEnv());
  const { rows } = await db.query(
    `select square_variation_id, square_item_id, item_name, square_image_id
       from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { ok: false, error: 'row not found' };
  const row = rows[0] as { square_variation_id: string | null; square_item_id: string | null; item_name: string | null; square_image_id: string | null };
  if (!row.square_variation_id) return { ok: false, error: 'no Square variation for this row' };

  if (row.square_image_id) await ops.deleteImage(row.square_image_id).catch(() => {});
  const attached = await ops.attach({
    variationId: row.square_variation_id,
    itemName: row.item_name ?? '',
    bytes: file.bytes,
    contentType: file.contentType,
    sourceUrl: `upload:${seq}:${Date.now()}`,
  });
  await db.query(
    `update catalog_mapping set status = 'ENRICHED', image_url = $3, square_image_id = $4, updated_at = now()
       where client_id = $1 and seq = $2`,
    [clientId, seq, attached.url, attached.imageId],
  );
  if (opts.setItem && row.square_item_id) await ops.setItemImage(row.square_item_id, attached.imageId).catch(() => {});
  return { ok: true };
}

/** Remove the variation's image entirely (none of the candidates fit). */
export async function clearVariationImage(
  db: Queryable,
  clientId: string,
  seq: string,
  opts: { ops?: ImageEditOps } = {},
): Promise<{ ok: boolean }> {
  const ops = opts.ops ?? liveImageEditOps(squareConfigFromEnv());
  const { rows } = await db.query(
    `select square_image_id from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { ok: false };
  const row = rows[0] as { square_image_id: string | null };
  if (row.square_image_id) await ops.deleteImage(row.square_image_id).catch(() => {});
  await db.query(
    `update catalog_mapping set status = 'NO_IMAGE', image_url = null, square_image_id = null, updated_at = now()
       where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  return { ok: true };
}
