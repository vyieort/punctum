// Item detail page: one product in a focused view — its item-level fields and a table of its
// variations, each with a photo upload. The hub the catalog grid links down into (and that a
// variation detail page will link down from). Read/display + per-variation photo upload here;
// field editing reuses the same applyEdits backend as the catalog grid.

import type { Queryable } from '../jobs/pg-rows.js';

const str = (v: unknown): string => (v == null ? '' : String(v));
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTagSuffix = (name: string): string => name.replace(/\s*\[.*\]\s*$/, '').trim();

export interface ItemVariation {
  seq: string;
  variationName: string;
  sku: string;
  retail: string;
  wholesale: string;
  imageUrl: string;
  status: string;
}

export interface ItemDetail {
  itemId: string;
  itemName: string;
  tags: string;
  categoryPath: string;
  description: string;
  vendor: string;
  variations: ItemVariation[];
}

export async function getItemDetail(db: Queryable, clientId: string, itemId: string): Promise<ItemDetail | null> {
  const { rows } = await db.query(
    `select seq, vendor, vendor_sku, item_name, variation_name, tags, coalesce(category_path,'') as category_path,
            coalesce(item_description,'') as item_description, status::text as status,
            wholesale_price::text as wholesale_price, retail_price::text as retail_price, image_url
       from catalog_mapping
      where client_id = $1 and square_item_id = $2
      order by variation_name`,
    [clientId, itemId],
  );
  if (rows.length === 0) return null;
  const first = rows[0] as Record<string, unknown>;
  return {
    itemId,
    itemName: stripTagSuffix(str(first.item_name)),
    tags: str(first.tags),
    categoryPath: str(first.category_path),
    description: str(first.item_description),
    vendor: str(first.vendor),
    variations: rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        seq: str(row.seq),
        variationName: str(row.variation_name),
        sku: str(row.vendor_sku),
        retail: str(row.retail_price),
        wholesale: str(row.wholesale_price),
        imageUrl: str(row.image_url),
        status: str(row.status),
      };
    }),
  };
}

const STATUS_COLOR: Record<string, string> = {
  ENRICHED: '#166534', NO_IMAGE: '#b45309', PENDING: '#6b7280', PUSHED: '#166534', NEEDS_REVIEW: '#b91c1c',
};

export function renderItemPage(item: ItemDetail): string {
  const hero = item.variations.find((v) => v.imageUrl)?.imageUrl ?? '';
  const rows = item.variations
    .map((v) => {
      const color = STATUS_COLOR[v.status] ?? '#6b7280';
      const thumb = v.imageUrl
        ? `<img class="thumb" src="${esc(v.imageUrl)}" alt="">`
        : '<span class="nothumb">—</span>';
      return `<tr id="var-${esc(v.seq)}">
        <td class="tc">${thumb}</td>
        <td><a href="/variations/${esc(v.seq)}">${esc(v.variationName) || '(default)'}</a></td>
        <td class="mono">${esc(v.sku)}</td>
        <td>${v.retail ? '$' + esc(v.retail) : ''}</td>
        <td><span class="badge" style="background:${color}">${esc(v.status)}</span></td>
        <td>
          <label class="up">Upload<input type="file" accept="image/*" data-seq="${esc(v.seq)}" hidden></label>
          <button class="asitem" data-seq="${esc(v.seq)}" title="Use as the item's main image">&#9733;</button>
        </td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(item.itemName)} &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:900px;color:#1a1a1a;padding:0 1rem}
  a{color:#2563eb;text-decoration:none} a:hover{text-decoration:underline}
  .bc{font-size:13px;color:#6b7280;margin-bottom:.5rem}
  h2{margin:0 0 .25rem} .meta{color:#555;font-size:13px;margin-bottom:1rem}
  .meta code{background:#f3f4f6;padding:.05rem .3rem;border-radius:4px}
  .head{display:flex;gap:1rem;align-items:flex-start;margin-bottom:1rem}
  .heroimg{width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;background:#f3f4f6}
  .heroempty{width:120px;height:120px;display:flex;align-items:center;justify-content:center;color:#9ca3af;border:1px dashed #d1d5db;border-radius:8px;font-size:12px;text-align:center}
  .desc{color:#374151;font-size:14px}
  table{border-collapse:collapse;width:100%;font-size:13px;margin-top:.5rem}
  th,td{border-bottom:1px solid #eee;padding:.5rem .6rem;text-align:left;vertical-align:middle}
  th{color:#666;font-weight:600}
  .tc{width:56px} .thumb{width:44px;height:44px;object-fit:cover;border-radius:5px;border:1px solid #e5e7eb;background:#f3f4f6;display:block}
  .nothumb{color:#9ca3af} .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#374151}
  .badge{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600}
  .up{font-size:12px;padding:.25rem .6rem;border:1px solid #166534;color:#166534;border-radius:6px;cursor:pointer}
  .asitem{font-size:12px;padding:.2rem .45rem;border:1px solid #7c3aed;color:#7c3aed;background:#fff;border-radius:6px;cursor:pointer;margin-left:.3rem}
  .up:hover{background:#f0fdf4} #status{margin:.5rem 0;color:#333;font-size:13px;min-height:1.1em}
</style></head>
<body>
  <div class="bc"><a href="/catalog">← Catalog</a> › ${esc(item.itemName)}</div>
  <h2>${esc(item.itemName)}</h2>
  <div class="meta">${esc(item.vendor)}${item.categoryPath ? ' · ' + esc(item.categoryPath) : ''}${item.tags ? ' · <code>' + esc(item.tags) + '</code>' : ''}</div>
  <div class="head">
    ${hero ? `<img class="heroimg" src="${esc(hero)}" alt="">` : '<div class="heroempty">no image yet</div>'}
    <div class="desc">${esc(item.description) || '<span style="color:#9ca3af">No description.</span>'}</div>
  </div>
  <div id="status"></div>
  <table>
    <thead><tr><th></th><th>Variation</th><th>SKU</th><th>Price</th><th>Status</th><th>Photo</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
<script>
function setStatus(t){ document.getElementById('status').textContent = t; }
document.querySelectorAll('input[type=file]').forEach(function(inp){
  inp.addEventListener('change', async function(){
    if(!inp.files || !inp.files[0]) return;
    var f=inp.files[0], seq=inp.getAttribute('data-seq');
    setStatus('Uploading '+f.name+'…');
    try{
      var buf=await f.arrayBuffer();
      var res=await fetch('/catalog/upload-image?seq='+encodeURIComponent(seq),{method:'POST',headers:{'content-type':f.type||'application/octet-stream'},body:buf});
      var j=await res.json();
      if(res.ok && j.ok){ setStatus('Uploaded ✓ — reloading…'); setTimeout(function(){ location.reload(); }, 600); }
      else { setStatus('Error: '+(j.error||res.status)); }
    }catch(e){ setStatus('Error: '+e.message); }
  });
});
document.querySelectorAll('.asitem').forEach(function(b){
  b.addEventListener('click', async function(){
    b.disabled=true; setStatus('Setting item image…');
    try{
      var res=await fetch('/catalog/set-item-image?seq='+encodeURIComponent(b.getAttribute('data-seq')),{method:'POST'});
      if(res.ok){ setStatus('Item image set ✓ — reloading…'); setTimeout(function(){ location.reload(); }, 600); }
      else { setStatus('Error '+res.status); b.disabled=false; }
    }catch(e){ setStatus('Error: '+e.message); b.disabled=false; }
  });
});
</script>
</body></html>`;
}
