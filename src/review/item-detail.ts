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

export interface VariationDetail {
  seq: string;
  squareItemId: string;
  itemName: string;
  variationName: string;
  sku: string;
  retail: string;
  wholesale: string;
  imageUrl: string;
  status: string;
  categoryPath: string;
  vendor: string;
}

export async function getVariationDetail(db: Queryable, clientId: string, seq: string): Promise<VariationDetail | null> {
  const { rows } = await db.query(
    `select square_item_id, item_name, variation_name, vendor, vendor_sku, status::text as status,
            coalesce(category_path,'') as category_path, image_url,
            wholesale_price::text as wholesale_price, retail_price::text as retail_price
       from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    seq,
    squareItemId: str(r.square_item_id),
    itemName: stripTagSuffix(str(r.item_name)),
    variationName: str(r.variation_name),
    sku: str(r.vendor_sku),
    retail: str(r.retail_price),
    wholesale: str(r.wholesale_price),
    imageUrl: str(r.image_url),
    status: str(r.status),
    categoryPath: str(r.category_path),
    vendor: str(r.vendor),
  };
}

export function renderVariationPage(v: VariationDetail): string {
  const color = STATUS_COLOR[v.status] ?? '#6b7280';
  const itemHref = v.squareItemId ? `/items/${esc(v.squareItemId)}` : '/catalog';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.itemName)} — ${esc(v.variationName)} · Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:640px;color:#1a1a1a;padding:0 1rem}
  a{color:#2563eb;text-decoration:none} a:hover{text-decoration:underline}
  .bc{font-size:13px;color:#6b7280;margin-bottom:.75rem}
  h2{margin:0 0 1rem}
  .row{display:flex;gap:1.25rem;align-items:flex-start}
  .imgcol{flex:0 0 180px;text-align:center}
  .img{width:180px;height:180px;object-fit:cover;border-radius:10px;border:1px solid #e5e7eb;background:#f3f4f6}
  .imgempty{width:180px;height:180px;display:flex;align-items:center;justify-content:center;color:#9ca3af;border:1px dashed #d1d5db;border-radius:10px;font-size:13px}
  .imgbtns{margin-top:.5rem;display:flex;gap:.4rem;justify-content:center;flex-wrap:wrap}
  .fields{flex:1}
  label{display:block;font-size:12px;color:#6b7280;margin:.7rem 0 .2rem}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.45rem .6rem;border:1px solid #d1d5db;border-radius:6px}
  .ro{color:#374151;font-size:14px;padding:.2rem 0} .mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
  .badge{color:#fff;border-radius:999px;padding:.12rem .55rem;font-size:11px;font-weight:600}
  button{font:inherit;font-size:13px;border-radius:6px;cursor:pointer;padding:.4rem .8rem}
  .save{margin-top:1rem;border:1px solid #166534;background:#166534;color:#fff}
  .save:disabled{opacity:.5}
  .mini{font-size:12px;padding:.3rem .6rem;border:1px solid #7c3aed;color:#7c3aed;background:#fff}
  .up{border:1px solid #166534;color:#166534;background:#fff;font-size:12px;padding:.3rem .6rem}
  .clr{border:1px solid #b45309;color:#b45309;background:#fff;font-size:12px;padding:.3rem .6rem}
  #status{margin-top:.75rem;font-size:13px;color:#333;min-height:1.1em}
</style></head>
<body>
  <div class="bc"><a href="/catalog">Catalog</a> › <a href="${itemHref}">${esc(v.itemName)}</a> › ${esc(v.variationName) || '(default)'}</div>
  <h2>${esc(v.variationName) || '(default variation)'} <span class="badge" style="background:${color}">${esc(v.status)}</span></h2>
  <div class="row">
    <div class="imgcol">
      ${v.imageUrl ? `<img class="img" src="${esc(v.imageUrl)}" alt="">` : '<div class="imgempty">no image</div>'}
      <div class="imgbtns">
        <label class="up">Upload<input type="file" id="file" accept="image/*,.heic,.heif" hidden></label>
        ${v.imageUrl ? '<button class="mini" id="asitem">★ item</button><button class="clr" id="clear">Remove</button>' : ''}
      </div>
    </div>
    <div class="fields">
      <label>Variation name</label>
      <input id="vname" value="${esc(v.variationName)}">
      <label>Retail price ($)</label>
      <input id="price" value="${esc(v.retail)}" inputmode="decimal">
      <label>SKU</label>
      <div class="ro mono">${esc(v.sku) || '—'}</div>
      <label>Wholesale cost</label>
      <div class="ro">${v.wholesale ? '$' + esc(v.wholesale) : '—'}</div>
      <label>Item / category</label>
      <div class="ro"><a href="${itemHref}">${esc(v.itemName)}</a>${v.categoryPath ? ' · ' + esc(v.categoryPath) : ''}</div>
      <button class="save" id="save">Save to Square</button>
    </div>
  </div>
  <div id="status"></div>
<script>
var SEQ=${JSON.stringify(v.seq)};
function st(t){ document.getElementById('status').textContent=t; }
function downscale(file, maxPx, quality){
  return new Promise(function(resolve){
    if(!/^image\\/(jpeg|png|webp)$/i.test(file.type||'')){ resolve(file); return; }
    var img=new Image(), url=URL.createObjectURL(file);
    img.onload=function(){ var w=img.naturalWidth,h=img.naturalHeight,m=Math.max(w,h); if(m<=maxPx){ URL.revokeObjectURL(url); resolve(file); return; } var sc=maxPx/m,c=document.createElement('canvas'); c.width=Math.round(w*sc); c.height=Math.round(h*sc); c.getContext('2d').drawImage(img,0,0,c.width,c.height); c.toBlob(function(bl){ URL.revokeObjectURL(url); resolve(bl||file); },'image/jpeg',quality); };
    img.onerror=function(){ URL.revokeObjectURL(url); resolve(file); };
    img.src=url;
  });
}
document.getElementById('save').addEventListener('click', async function(){
  var b=this; b.disabled=true; st('Saving to Square…');
  var edit={ seq:SEQ, variationName:document.getElementById('vname').value, retailPrice:document.getElementById('price').value };
  try{
    var res=await fetch('/catalog/edits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edits:[edit]})});
    var j=await res.json();
    if(res.ok){ st('Saved — '+j.fieldsChanged+' field(s) changed'+(j.errors&&j.errors.length?', '+j.errors.length+' error(s)':'')+'.'); }
    else { st('Error: '+(j.error||res.status)); }
  }catch(e){ st('Error: '+e.message); }
  b.disabled=false;
});
document.getElementById('file').addEventListener('change', async function(){
  if(!this.files||!this.files[0]) return;
  var f=this.files[0]; st('Uploading '+f.name+'…');
  try{
    var toSend=await downscale(f,2048,0.85);
    var res=await fetch('/catalog/upload-image?seq='+encodeURIComponent(SEQ),{method:'POST',headers:{'content-type':toSend.type||f.type||'application/octet-stream'},body:toSend});
    var j=await res.json();
    if(res.ok&&j.ok){ st('Uploaded ✓ — reloading…'); setTimeout(function(){location.reload();},600); } else { st('Error: '+(j.error||res.status)); }
  }catch(e){ st('Error: '+e.message); }
});
var ai=document.getElementById('asitem');
if(ai) ai.addEventListener('click', async function(){
  st('Setting item image…');
  try{ var res=await fetch('/catalog/set-item-image?seq='+encodeURIComponent(SEQ),{method:'POST'}); st(res.ok?'Item image set ✓':'Error '+res.status); }catch(e){ st('Error: '+e.message); }
});
var cl=document.getElementById('clear');
if(cl) cl.addEventListener('click', async function(){
  if(!confirm('Remove this image?')) return;
  st('Removing…');
  try{ var res=await fetch('/catalog/clear-image?seq='+encodeURIComponent(SEQ),{method:'POST'}); if(res.ok){ st('Removed — reloading…'); setTimeout(function(){location.reload();},500);} else st('Error '+res.status); }catch(e){ st('Error: '+e.message); }
});
</script>
</body></html>`;
}

export function renderItemPage(item: ItemDetail, itemImageUrl = ''): string {
  // Prefer the item's true primary image (which may be an item-only upload); fall back to the
  // first variation that has a photo so the page still shows something before any item image is set.
  const hero = itemImageUrl || (item.variations.find((v) => v.imageUrl)?.imageUrl ?? '');
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
          <label class="up">Upload<input type="file" accept="image/*,.heic,.heif" data-seq="${esc(v.seq)}" hidden></label>
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
  .herocol{flex:0 0 120px;text-align:center}
  .herobtns{margin-top:.4rem;display:flex;gap:.35rem;justify-content:center;flex-wrap:wrap}
  .clr{border:1px solid #b45309;color:#b45309;background:#fff;font-size:12px;padding:.25rem .6rem;border-radius:6px;cursor:pointer}
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
    <div class="herocol">
      ${hero ? `<img class="heroimg" src="${esc(hero)}" alt="">` : '<div class="heroempty">no image yet</div>'}
      <div class="herobtns">
        <label class="up">${hero ? 'Replace photo' : 'Upload photo'}<input type="file" id="itemfile" accept="image/*,.heic,.heif" hidden></label>
        ${hero ? '<button class="clr" id="itemclear">Remove</button>' : ''}
      </div>
    </div>
    <div class="desc">${esc(item.description) || '<span style="color:#9ca3af">No description.</span>'}</div>
  </div>
  <div id="status"></div>
  <table>
    <thead><tr><th></th><th>Variation</th><th>SKU</th><th>Price</th><th>Status</th><th>Photo</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
<script>
function setStatus(t){ document.getElementById('status').textContent = t; }
function downscale(file, maxPx, quality){
  return new Promise(function(resolve){
    if(!/^image\\/(jpeg|png|webp)$/i.test(file.type||'')){ resolve(file); return; }
    var img=new Image(), url=URL.createObjectURL(file);
    img.onload=function(){ var w=img.naturalWidth,h=img.naturalHeight,m=Math.max(w,h); if(m<=maxPx){ URL.revokeObjectURL(url); resolve(file); return; } var sc=maxPx/m,c=document.createElement('canvas'); c.width=Math.round(w*sc); c.height=Math.round(h*sc); c.getContext('2d').drawImage(img,0,0,c.width,c.height); c.toBlob(function(bl){ URL.revokeObjectURL(url); resolve(bl||file); },'image/jpeg',quality); };
    img.onerror=function(){ URL.revokeObjectURL(url); resolve(file); };
    img.src=url;
  });
}
document.querySelectorAll('input[type=file][data-seq]').forEach(function(inp){
  inp.addEventListener('change', async function(){
    if(!inp.files || !inp.files[0]) return;
    var f=inp.files[0], seq=inp.getAttribute('data-seq');
    setStatus('Uploading '+f.name+'…');
    try{
      var toSend=await downscale(f,2048,0.85);
      var res=await fetch('/catalog/upload-image?seq='+encodeURIComponent(seq),{method:'POST',headers:{'content-type':toSend.type||f.type||'application/octet-stream'},body:toSend});
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
var ITEMID=${JSON.stringify(item.itemId)};
var itemFile=document.getElementById('itemfile');
if(itemFile) itemFile.addEventListener('change', async function(){
  if(!itemFile.files || !itemFile.files[0]) return;
  var f=itemFile.files[0];
  setStatus('Uploading item photo '+f.name+'…');
  try{
    var toSend=await downscale(f,2048,0.85);
    var res=await fetch('/catalog/upload-item-image?item='+encodeURIComponent(ITEMID),{method:'POST',headers:{'content-type':toSend.type||f.type||'application/octet-stream'},body:toSend});
    var j=await res.json();
    if(res.ok && j.ok){ setStatus('Item photo updated ✓ — reloading…'); setTimeout(function(){ location.reload(); }, 600); }
    else { setStatus('Error: '+(j.error||res.status)); }
  }catch(e){ setStatus('Error: '+e.message); }
});
var itemClear=document.getElementById('itemclear');
if(itemClear) itemClear.addEventListener('click', async function(){
  if(!confirm('Remove the item photo?')) return;
  itemClear.disabled=true; setStatus('Removing item photo…');
  try{
    var res=await fetch('/catalog/clear-item-image?item='+encodeURIComponent(ITEMID),{method:'POST'});
    if(res.ok){ setStatus('Removed — reloading…'); setTimeout(function(){ location.reload(); }, 500); }
    else { setStatus('Error '+res.status); itemClear.disabled=false; }
  }catch(e){ setStatus('Error: '+e.message); itemClear.disabled=false; }
});
</script>
</body></html>`;
}
