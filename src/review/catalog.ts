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
  imageUrl: string;
  hasCandidates: boolean;
  squareItemId: string;
}

const stripTagSuffix = (name: string): string => name.replace(/\s*\[.*\]\s*$/, '').trim();

export async function getCatalogRows(db: Queryable, clientId: string, limit = 1000): Promise<CatalogRow[]> {
  const { rows } = await db.query(
    `select seq, vendor, vendor_sku, square_item_id, item_name, variation_name, tags,
            status::text as status, wholesale_price::text as wholesale_price, retail_price::text as retail_price,
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

export function renderCatalogPage(rows: CatalogRow[]): string {
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const countLine = Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');

  const body = rows
    .map((r) => {
      const color = STATUS_COLOR[r.status] ?? '#6b7280';
      const caption = `${r.itemName}${r.variationName ? ' — ' + r.variationName : ''}`;
      const thumb = r.imageUrl
        ? `<img class="thumb" src="${esc(r.imageUrl)}" data-url="${esc(r.imageUrl)}" data-cap="${esc(caption)}" loading="lazy" alt="" title="Click to enlarge">`
        : '<span class="nothumb">—</span>';
      const urlCell = r.imageUrl
        ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noreferrer" class="url">${esc(r.imageUrl)}</a>`
        : '';
      const wholesale = r.wholesalePrice ? `$${esc(r.wholesalePrice)}` : '';
      const retail = r.retailPrice ? `$${esc(r.retailPrice)}` : '';
      const alts = r.hasCandidates
        ? `<button class="alts" data-seq="${esc(r.seq)}" data-cap="${esc(caption)}">Review alternatives</button>`
        : '';
      return `<tr id="row-${esc(r.seq)}">
        <td class="showcell">${thumb}</td>
        <td><div class="item">${esc(r.itemName)}</div>${r.tags ? `<div class="tags">${esc(r.tags)}</div>` : ''}</td>
        <td>${esc(r.variationName)}</td>
        <td>${esc(r.vendor)}</td>
        <td class="mono">${esc(r.vendorSku)}</td>
        <td class="wcell">${wholesale}</td>
        <td>${retail}</td>
        <td><span class="badge" style="background:${color}">${esc(r.status)}</span></td>
        <td class="url-td">${urlCell}</td>
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
  .showcell{width:58px}
  .thumb{width:50px;height:50px;object-fit:cover;border-radius:5px;border:1px solid #e5e7eb;background:#f3f4f6;cursor:pointer;display:block}
  .nothumb{color:#9ca3af}
  .item{font-weight:600} .tags{color:#6b7280;font-size:11px;margin-top:2px}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#374151}
  .badge{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600;white-space:nowrap}
  .url{color:#2563eb;font-size:11px;word-break:break-all;display:inline-block;max-width:280px} .url-td{max-width:300px}
  .alts{font:inherit;font-size:12px;padding:.25rem .6rem;border:1px solid #2563eb;color:#2563eb;background:#fff;border-radius:6px;cursor:pointer;white-space:nowrap}
  .alts:disabled{opacity:.6;cursor:default}
  tr.active{background:#f0fdf4} tr.active .thumb{outline:2px solid #166534}
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
  <table>
    <thead><tr><th></th><th>Item</th><th>Variation</th><th>Vendor</th><th>SKU</th><th>Wholesale</th><th>Retail</th><th>Status</th><th>Image URL</th><th></th></tr></thead>
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
</script>
</body></html>`;
}

// --- Alternatives backend: read candidates, replace the image, or clear it. ---

export interface ImageEditOps {
  deleteImage(imageId: string): Promise<void>;
  download(url: string): Promise<{ bytes: Buffer; contentType: string }>;
  attach(opts: { variationId: string; itemName: string; bytes: Buffer; contentType?: string; sourceUrl?: string }): Promise<{ imageId: string; url: string }>;
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
  };
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
