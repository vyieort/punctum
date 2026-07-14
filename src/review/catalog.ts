// Catalog review page: the enriched catalog_mapping rows rendered with the matched image
// inline (thumbnail + URL), so image matches can be eyeballed without digging through Square.
// Each imaged row has a Reject button — it deletes the wrong image from Square and re-queues
// the variation (excluding the rejected URL) so the next enrich run finds a different one.

import type { Queryable } from '../jobs/pg-rows.js';
import { squareConfigFromEnv, deleteCatalogObject, type SquareConfig } from '../lib/square-client.js';

export interface CatalogRow {
  seq: string;
  vendor: string;
  vendorSku: string;
  itemName: string; // base name (tag suffix stripped)
  tags: string;
  variationName: string;
  status: string;
  retailPrice: string;
  imageUrl: string;
  squareItemId: string;
}

const stripTagSuffix = (name: string): string => name.replace(/\s*\[.*\]\s*$/, '').trim();

export async function getCatalogRows(db: Queryable, clientId: string, limit = 1000): Promise<CatalogRow[]> {
  const { rows } = await db.query(
    `select seq, vendor, vendor_sku, square_item_id, item_name, variation_name, tags,
            status::text as status, retail_price::text as retail_price, image_url
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
      retailPrice: str(row.retail_price),
      imageUrl: str(row.image_url),
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
      const thumb = r.imageUrl
        ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noreferrer"><img src="${esc(r.imageUrl)}" loading="lazy" alt=""></a>`
        : '<div class="noimg">—</div>';
      const urlCell = r.imageUrl
        ? `<a href="${esc(r.imageUrl)}" target="_blank" rel="noreferrer" class="url">${esc(r.imageUrl)}</a>`
        : '';
      const price = r.retailPrice ? `$${esc(r.retailPrice)}` : '';
      const reject = r.imageUrl
        ? `<button class="rej" onclick="rej(this,'${esc(r.seq)}')">Reject</button>`
        : '';
      return `<tr>
        <td class="imgcell">${thumb}</td>
        <td><div class="item">${esc(r.itemName)}</div>${r.tags ? `<div class="tags">${esc(r.tags)}</div>` : ''}</td>
        <td>${esc(r.variationName)}</td>
        <td>${esc(r.vendor)}</td>
        <td class="mono">${esc(r.vendorSku)}</td>
        <td>${price}</td>
        <td><span class="badge" style="background:${color}">${esc(r.status)}</span></td>
        <td class="url-td">${urlCell}</td>
        <td>${reject}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Catalog review</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:1.5rem auto;max-width:1280px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .25rem} .sub{color:#555;margin:0 0 1rem;font-size:14px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid #eee;padding:.5rem .6rem;text-align:left;vertical-align:top}
  th{color:#666;font-weight:600;position:sticky;top:0;background:#fff;z-index:1}
  .imgcell{width:76px} img{width:64px;height:64px;object-fit:cover;border-radius:6px;background:#f3f4f6;border:1px solid #e5e7eb}
  .noimg{width:64px;height:64px;border-radius:6px;background:#f9fafb;border:1px dashed #d1d5db;display:flex;align-items:center;justify-content:center;color:#9ca3af}
  .item{font-weight:600} .tags{color:#6b7280;font-size:11px;margin-top:2px}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#374151}
  .badge{color:#fff;border-radius:999px;padding:.1rem .5rem;font-size:11px;font-weight:600;white-space:nowrap}
  .url{color:#2563eb;font-size:11px;word-break:break-all;display:inline-block;max-width:280px} .url-td{max-width:300px}
  .rej{font:inherit;font-size:12px;padding:.25rem .6rem;border:1px solid #b91c1c;color:#b91c1c;background:#fff;border-radius:6px;cursor:pointer}
  .rej:disabled{opacity:.6;cursor:default}
  tr.rejected{opacity:.45}
</style></head>
<body>
  <h2>Catalog review</h2>
  <p class="sub">${rows.length} variations${countLine ? ' — ' + esc(countLine) : ''}. Thumbnails are the matched image; click to open full size. Reject removes a wrong image and re-queues it for a new match.</p>
  <table>
    <thead><tr><th>Image</th><th>Item</th><th>Variation</th><th>Vendor</th><th>SKU</th><th>Price</th><th>Status</th><th>Image URL</th><th></th></tr></thead>
    <tbody>${body}</tbody>
  </table>
<script>
async function rej(btn, seq){
  if(!confirm('Remove this image and re-queue this variation for a new match?')) return;
  btn.disabled=true; btn.textContent='…';
  try{
    var res=await fetch('/catalog/reject?client=RE&seq='+encodeURIComponent(seq),{method:'POST'});
    if(res.ok){
      var tr=btn.closest('tr'); tr.classList.add('rejected');
      var img=tr.querySelector('img'); if(img) img.remove();
      btn.textContent='Rejected';
    } else { btn.disabled=false; btn.textContent='Reject'; alert('Error '+res.status); }
  }catch(e){ btn.disabled=false; btn.textContent='Reject'; alert(e.message); }
}
</script>
</body></html>`;
}

// --- Reject: remove the wrong image from Square + re-queue for a fresh (different) match. ---

export interface RejectOps {
  deleteImage(imageId: string): Promise<void>;
}

export function liveRejectOps(cfg: SquareConfig): RejectOps {
  return { deleteImage: (id) => deleteCatalogObject(cfg, id) };
}

export async function rejectImage(
  db: Queryable,
  clientId: string,
  seq: string,
  opts: { ops?: RejectOps } = {},
): Promise<{ rejected: boolean }> {
  const ops = opts.ops ?? liveRejectOps(squareConfigFromEnv());
  const { rows } = await db.query(
    `select square_image_id, image_url, rejected_image_urls from catalog_mapping where client_id = $1 and seq = $2`,
    [clientId, seq],
  );
  if (rows.length === 0) return { rejected: false };
  const row = rows[0] as { square_image_id: string | null; image_url: string | null; rejected_image_urls: string | null };

  if (row.square_image_id) {
    // Best-effort delete; still clear the DB even if Square already lost the object.
    await ops.deleteImage(row.square_image_id).catch(() => {});
  }
  const rejectedList = [row.rejected_image_urls, row.image_url]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join('\n');

  await db.query(
    `update catalog_mapping
        set status = 'PENDING', image_url = null, square_image_id = null, rejected_image_urls = $3, updated_at = now()
      where client_id = $1 and seq = $2`,
    [clientId, seq, rejectedList || null],
  );
  return { rejected: true };
}
