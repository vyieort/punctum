// Backfill square_item_id on library-seeded rows. A Square library export carries variation
// tokens but not the parent item id, so seedLibrary leaves square_item_id null. This lists the
// live Square catalog once, maps each variation id -> its item id, and fills the blanks — which
// lets the import matcher add new variations to an existing library item on reorder.
//
// Square ops are injected so it's unit-testable with a fake catalog (no live call in tests).

import type { Queryable } from './pg-rows.js';
import { squareConfigFromEnv, listCatalogItems } from '../lib/square-client.js';

interface CatalogItem {
  id?: string;
  item_data?: { variations?: Array<{ id?: string }> };
}

export interface LibrarySyncOps {
  listItems(): Promise<CatalogItem[]>;
}

export interface LibrarySyncResult {
  needing: number; // rows missing a square_item_id
  matched: number; // of those, found in the live catalog
  updated: number; // rows actually written
}

export async function syncLibraryItemIds(
  db: Queryable,
  clientId: string,
  opts: { ops?: LibrarySyncOps } = {},
): Promise<LibrarySyncResult> {
  const ops = opts.ops ?? { listItems: () => listCatalogItems(squareConfigFromEnv()) };
  const items = await ops.listItems();

  const itemByVariation = new Map<string, string>();
  for (const it of items) {
    if (!it.id) continue;
    for (const v of it.item_data?.variations ?? []) {
      if (v.id) itemByVariation.set(v.id, it.id);
    }
  }

  const { rows } = await db.query(
    `select square_variation_id from catalog_mapping
      where client_id = $1 and square_variation_id is not null and coalesce(square_item_id, '') = ''`,
    [clientId],
  );

  const result: LibrarySyncResult = { needing: rows.length, matched: 0, updated: 0 };
  for (const r of rows as Array<{ square_variation_id: string }>) {
    const vid = String(r.square_variation_id);
    const iid = itemByVariation.get(vid);
    if (!iid) continue;
    result.matched++;
    // The row came from the "missing id" query above, so this update always writes exactly it.
    await db.query(
      `update catalog_mapping set square_item_id = $1
        where client_id = $2 and square_variation_id = $3 and coalesce(square_item_id, '') = ''`,
      [iid, clientId, vid],
    );
    result.updated++;
  }
  return result;
}
