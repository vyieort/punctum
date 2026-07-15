// Seed a parsed Square library export into a client's catalog_mapping — the onboarding step, so
// future invoices reorder-match the existing library. Client-scoped (nothing RE-specific).
//
// Each row is keyed by its Square variation token (the reliable unique id). Blank vendor SKUs are
// filled with genSku (same generator invoices use). square_item_id is left null — filled later by
// a Square API sync — since the export only carries variation tokens. Rows land as 'PUSHED' (they
// already exist in Square), so image enrichment (which processes 'PENDING') skips them.

import type { Queryable } from './pg-rows.js';
import { deriveVendor, extractTags, skuForRow, type LibraryRow } from '../lib/library-import.js';

export interface SeedResult {
  seeded: number;
  inserted: number;
  updated: number;
  generatedSkus: number; // rows that had no vendor SKU and got a synthetic one
  noSku: number; // still blank after generation (couldn't derive)
}

export async function seedLibrary(db: Queryable, clientId: string, rows: LibraryRow[]): Promise<SeedResult> {
  const result: SeedResult = { seeded: 0, inserted: 0, updated: 0, generatedSkus: 0, noSku: 0 };

  for (const row of rows) {
    if (!row.token) continue; // no catalog id -> can't map it

    const sku = skuForRow(row);
    if (!row.sku && sku) result.generatedSkus++;
    if (!sku) result.noSku++;

    const vendor = deriveVendor(row.itemName) || null;
    const tags = extractTags(row.itemName);
    const retail = row.retailCents / 100;
    const wholesale = row.wholesaleCents != null ? row.wholesaleCents / 100 : null;

    const found = await db.query(
      `select id from catalog_mapping where client_id = $1 and square_variation_id = $2 limit 1`,
      [clientId, row.token],
    );
    if (found.rows.length > 0) {
      await db.query(
        `update catalog_mapping
           set vendor = $3, vendor_sku = $4, item_name = $5, variation_name = $6, item_description = $7,
               retail_price = $8, wholesale_price = $9, tags = $10, updated_at = now()
         where client_id = $1 and square_variation_id = $2`,
        [clientId, row.token, vendor, sku || null, row.itemName, row.variationName, row.description, retail, wholesale, tags],
      );
      result.updated++;
    } else {
      await db.query(
        `insert into catalog_mapping
           (client_id, vendor, vendor_sku, square_variation_id, item_name, variation_name, item_description,
            retail_price, wholesale_price, tags, status, first_seen)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PUSHED', now()::date)`,
        [clientId, vendor, sku || null, row.token, row.itemName, row.variationName, row.description, retail, wholesale, tags],
      );
      result.inserted++;
    }
    result.seeded++;
  }

  return result;
}
