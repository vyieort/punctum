// Sandbox catalog reset: delete every catalog item from the connected Square account and
// clear Punctum's SKU->Square mapping, so a test invoice can be re-imported from a clean slate.
//
// SAFETY: this is sandbox-only. It refuses to run when SQUARE_ENV is production, and it skips
// booking/appointment items (only REGULAR items are deleted) — a prod delete once wiped booking
// services as collateral. Categories are left intact so re-provisioning isn't needed.

import type { Queryable } from './pg-rows.js';
import { squareConfigFromEnv, listCatalogItems, batchDeleteObjects, type SquareConfig } from '../lib/square-client.js';

export interface WipeResult {
  env: string;
  itemsFound: number;
  itemsDeleted: number;
  mappingsCleared: number;
  invoicesCleared: number;
}

export interface WipeOps {
  env: string;
  listItems(): Promise<Array<{ id?: string; item_data?: { product_type?: string } }>>;
  deleteItems(ids: string[]): Promise<number>;
}

export function liveWipeOps(cfg: SquareConfig): WipeOps {
  return {
    env: cfg.env,
    listItems: () => listCatalogItems(cfg),
    deleteItems: (ids) => batchDeleteObjects(cfg, ids),
  };
}

export async function wipeSandboxCatalog(
  db: Queryable,
  clientId: string,
  opts: { ops?: WipeOps; clearInvoices?: boolean } = {},
): Promise<WipeResult> {
  const ops = opts.ops ?? liveWipeOps(squareConfigFromEnv());

  // Hard guard: never wipe a production catalog (or, below, production invoices).
  if (ops.env === 'production') {
    throw new Error('Refusing to wipe: SQUARE_ENV is production. This tool is sandbox-only.');
  }

  const all = await ops.listItems();
  // Only regular catalog items — never booking/appointment services.
  const ids = all
    .filter((o) => {
      const pt = o?.item_data?.product_type;
      return pt === undefined || pt === 'REGULAR';
    })
    .map((o) => o.id)
    .filter((id): id is string => Boolean(id));

  const itemsDeleted = ids.length ? await ops.deleteItems(ids) : 0;

  const del = await db.query(`delete from catalog_mapping where client_id = $1 returning id`, [clientId]);

  // Clear the invoice queue too for a true clean slate (sandbox-only; invoice_lines cascade).
  let invoicesCleared = 0;
  if (opts.clearInvoices !== false) {
    const inv = await db.query(`delete from invoices where client_id = $1 returning id`, [clientId]);
    invoicesCleared = inv.rows.length;
  }

  return { env: ops.env, itemsFound: all.length, itemsDeleted, mappingsCleared: del.rows.length, invoicesCleared };
}
