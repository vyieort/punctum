// Orchestrator (W2): push an approved invoice into Square. For each planned item it searches
// by name, then creates a new item (with all variations) or adds only the missing variations
// to an existing one (reorder), receives quantity into inventory, and writes the SKU ->
// Square-ID mapping back to catalog_mapping (status PENDING, for the tagger).
//
// Square ops are injected so the whole flow is unit-testable with a fake client — no live
// call until an operator triggers it. Idempotency keys are stable per (invoice, sku) so a
// re-run is a no-op on Square rather than a duplicate/double-count.

import type { Queryable } from './pg-rows.js';
import {
  squareConfigFromEnv,
  searchItemByName,
  upsertCatalogObject,
  batchChangeInventory,
  type SquareConfig,
} from '../lib/square-client.js';
import { loadClassifiedProducts, loadPricingRules, loadCategoryMap } from './import-preview.js';
import { toImportLines } from '../lib/import-map.js';
import { planItems, createItemBody, addVariationBody, inventoryAdjustBody, type PlannedVariation } from '../lib/square.js';

interface SquareVariation {
  id?: string;
  item_variation_data?: { name?: string; sku?: string };
}
interface SquareObject {
  id?: string;
  item_data?: { variations?: SquareVariation[] };
}

export interface SquareOps {
  search(name: string): Promise<SquareObject[]>;
  upsert(body: unknown): Promise<{ catalog_object?: SquareObject }>;
  inventory(body: unknown): Promise<unknown>;
}

export function liveSquareOps(cfg: SquareConfig): SquareOps {
  return {
    search: (n) => searchItemByName(cfg, n),
    upsert: (b) => upsertCatalogObject(cfg, b),
    inventory: (b) => batchChangeInventory(cfg, b),
  };
}

export interface ImportResult {
  invoiceId: string;
  itemsCreated: number;
  variationsAdded: number;
  variationsRestocked: number;
  inventoryAdjusted: number;
}

export interface ImportOptions {
  ops?: SquareOps;
  locationId?: string;
  occurredAt?: string;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

async function upsertMapping(
  db: Queryable,
  clientId: string,
  row: { vendor: string; sku: string; itemId: string; variationId: string; itemName: string; variationName: string; retailCents: number },
): Promise<void> {
  const retail = row.retailCents / 100;
  const found = await db.query(
    `select id, times_ordered from catalog_mapping where client_id = $1 and vendor_sku = $2 limit 1`,
    [clientId, row.sku],
  );
  if (found.rows.length > 0) {
    const r = found.rows[0] as { id: string; times_ordered: number | null };
    await db.query(
      `update catalog_mapping
         set square_item_id = $1, square_variation_id = $2, item_name = $3, variation_name = $4,
             retail_price = $5, status = 'PENDING', times_ordered = $6, last_ordered = now()::date, updated_at = now()
       where id = $7`,
      [row.itemId, row.variationId, row.itemName, row.variationName, retail, (r.times_ordered ?? 0) + 1, r.id],
    );
  } else {
    await db.query(
      `insert into catalog_mapping
         (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name,
          retail_price, status, times_ordered, first_seen, last_ordered)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', 1, now()::date, now()::date)`,
      [clientId, row.vendor || null, row.sku, row.itemId, row.variationId, row.itemName, row.variationName, retail],
    );
  }
}

export async function runImport(
  db: Queryable,
  invoiceId: string,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  let ops = opts.ops;
  let locationId = opts.locationId;
  if (!ops) {
    const cfg = squareConfigFromEnv();
    ops = liveSquareOps(cfg);
    locationId = locationId ?? cfg.locationId;
  }
  if (!locationId) throw new Error('runImport: no Square location id');
  const occurredAt = opts.occurredAt ?? new Date().toISOString();

  const inv = await db.query(`select client_id, vendor from invoices where id = $1`, [invoiceId]);
  if (inv.rows.length === 0) throw new Error(`invoice ${invoiceId} not found`);
  const clientId = String((inv.rows[0] as { client_id: string }).client_id);
  const vendor = String((inv.rows[0] as { vendor: string | null }).vendor ?? '');

  const [{ items }, pricingRules, categoryMap] = await Promise.all([
    loadClassifiedProducts(db, invoiceId),
    loadPricingRules(db, clientId),
    loadCategoryMap(db, clientId),
  ]);
  const planned = planItems(toImportLines(items, { pricingRules, categoryMap }).lines);

  await db.query(`update invoices set status = 'importing', updated_at = now() where id = $1`, [invoiceId]);
  const result: ImportResult = { invoiceId, itemsCreated: 0, variationsAdded: 0, variationsRestocked: 0, inventoryAdjusted: 0 };

  try {
    for (const item of planned) {
      const found = await ops.search(item.item_name);
      const resolved: Array<{ v: PlannedVariation; itemId: string; variationId: string }> = [];

      if (found.length === 0) {
        // New item — create it with all its variations in one call.
        const resp = await ops.upsert(
          createItemBody(item, { idempotencyKey: `${invoiceId}:item:${item.variations[0]?.sku ?? item.item_name}` }),
        );
        const created = resp.catalog_object;
        const itemId = created?.id ?? '';
        const idBySku = new Map<string, string>();
        for (const cv of created?.item_data?.variations ?? []) {
          const sku = cv.item_variation_data?.sku;
          if (sku && cv.id) idBySku.set(sku, cv.id);
        }
        result.itemsCreated++;
        for (const v of item.variations) {
          resolved.push({ v, itemId, variationId: idBySku.get(v.sku) ?? '' });
          result.variationsAdded++;
        }
      } else {
        // Existing item — add only variations that aren't already present.
        const itemId = found[0]?.id ?? '';
        const existingByName = new Map<string, string>();
        for (const ev of found[0]?.item_data?.variations ?? []) {
          const nm = norm(ev.item_variation_data?.name);
          if (nm && ev.id) existingByName.set(nm, ev.id);
        }
        for (const v of item.variations) {
          const existingId = existingByName.get(norm(v.variation_name));
          if (existingId) {
            resolved.push({ v, itemId, variationId: existingId });
            result.variationsRestocked++;
          } else {
            const resp = await ops.upsert(addVariationBody(itemId, v, { idempotencyKey: `${invoiceId}:var:${v.sku}` }));
            resolved.push({ v, itemId, variationId: resp.catalog_object?.id ?? '' });
            result.variationsAdded++;
          }
        }
      }

      for (const { v, itemId, variationId } of resolved) {
        if (variationId) {
          await ops.inventory(
            inventoryAdjustBody(variationId, v.qty, { locationId, occurredAt, idempotencyKey: `${invoiceId}:inv:${v.sku}` }),
          );
          result.inventoryAdjusted++;
        }
        await upsertMapping(db, clientId, {
          vendor,
          sku: v.sku,
          itemId,
          variationId,
          itemName: item.item_name,
          variationName: v.variation_name,
          retailCents: v.retail_cents,
        });
      }
    }
    await db.query(`update invoices set status = 'done', updated_at = now() where id = $1`, [invoiceId]);
  } catch (err) {
    await db.query(`update invoices set status = 'error', updated_at = now() where id = $1`, [invoiceId]).catch(() => {});
    throw err;
  }

  return result;
}
