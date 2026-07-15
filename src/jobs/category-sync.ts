// Backfill catalog_mapping.category_path from the live Square catalog. Items imported before the
// category_path column existed have a blank category in the edit grid; this reads each item's
// actual reporting category from Square and writes its human-readable path back, so the grid shows
// the real current assignment. Square is the source of truth, so it refreshes every row it can map
// (an operator's grid edit already lives in Square, so this stays consistent with it).

import type { Queryable } from './pg-rows.js';
import { squareConfigFromEnv, listCatalogItems } from '../lib/square-client.js';
import { loadCategoryMap } from './import-preview.js';

interface CatalogItem {
  id?: string;
  item_data?: { reporting_category?: { id?: string }; categories?: Array<{ id?: string }> };
}

export interface CategorySyncOps {
  listItems(): Promise<CatalogItem[]>;
}

export interface CategorySyncResult {
  items: number; // Square items scanned
  matched: number; // items whose category id resolved to a known path
  updated: number; // mapping rows written
}

export async function syncCategoryPaths(
  db: Queryable,
  clientId: string,
  opts: { ops?: CategorySyncOps } = {},
): Promise<CategorySyncResult> {
  const ops = opts.ops ?? { listItems: () => listCatalogItems(squareConfigFromEnv()) };
  const categoryMap = await loadCategoryMap(db, clientId); // path -> id
  const pathById = new Map<string, string>();
  for (const [path, id] of categoryMap) if (!pathById.has(id)) pathById.set(id, path);

  const items = await ops.listItems();
  const result: CategorySyncResult = { items: items.length, matched: 0, updated: 0 };

  for (const it of items) {
    if (!it.id) continue;
    const catId = it.item_data?.reporting_category?.id ?? it.item_data?.categories?.[0]?.id;
    const path = catId ? pathById.get(catId) : undefined;
    if (!path) continue;
    result.matched++;
    const upd = await db.query(
      `update catalog_mapping set category_path = $1, updated_at = now()
        where client_id = $2 and square_item_id = $3 and coalesce(category_path, '') <> $1
        returning seq`,
      [path, clientId, it.id],
    );
    result.updated += upd.rows.length;
  }
  return result;
}
