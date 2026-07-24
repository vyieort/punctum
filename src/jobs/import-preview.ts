// Import dry-run: show exactly what an approved invoice WOULD send to Square. Reads the
// stored classification (written at intake) — NO AI call — applies pricing + categories,
// groups into items, and builds a sample payload. Makes zero Square calls.

import type { Queryable } from './pg-rows.js';
import type { PricingRules } from '../lib/pricing.js';
import type { ClassifiedItem } from '../lib/classify.js';
import { toImportLines } from '../lib/import-map.js';
import { foldAddOns } from '../lib/addons.js';
import { planItems, createItemBody } from '../lib/square.js';

export async function loadPricingRules(db: Queryable, clientId: string): Promise<PricingRules> {
  const r = await db.query(`select pricing_rules from client_config where client_id = $1`, [clientId]);
  if (r.rows.length === 0) throw new Error(`no client_config for client ${clientId}`);
  const pr = (r.rows[0] as { pricing_rules: unknown }).pricing_rules;
  return (typeof pr === 'string' ? JSON.parse(pr) : pr) as PricingRules;
}

export async function loadCategoryMap(db: Queryable, clientId: string): Promise<Map<string, string>> {
  const r = await db.query(
    `select path, square_category_id from category_map where client_id = $1`,
    [clientId],
  );
  const m = new Map<string, string>();
  for (const row of r.rows as Array<{ path: string; square_category_id: string | null }>) {
    if (row.square_category_id) m.set(String(row.path), String(row.square_category_id));
  }
  return m;
}

/**
 * The stored classification for an invoice's PRODUCT lines, with add-on lines (#32) folded into the
 * product they belong to. Add-ons (a separately-listed gem, a threading/gauge upcharge) raise their
 * parent's wholesale; order-level fees (shipping/tax) are dropped; excluded lines are ignored. The
 * full ordered set is passed to foldAddOns so it can attribute by link or adjacency.
 */
export async function loadClassifiedProducts(db: Queryable, invoiceId: string): Promise<{ vendor: string; items: ClassifiedItem[] }> {
  const inv = await db.query(`select vendor from invoices where id = $1`, [invoiceId]);
  if (inv.rows.length === 0) throw new Error(`invoice ${invoiceId} not found`);
  const vendor = String((inv.rows[0] as { vendor: string | null }).vendor ?? '');
  const l = await db.query(
    `select classification, is_product, coalesce(excluded, false) as excluded
       from invoice_lines where invoice_id = $1 order by line_no nulls last, created_at`,
    [invoiceId],
  );
  const ordered = (l.rows as Array<{ classification: unknown; is_product: boolean; excluded: boolean }>).map((r) => ({
    item: (typeof r.classification === 'string' ? JSON.parse(r.classification) : r.classification) as ClassifiedItem,
    isProduct: r.is_product !== false,
    excluded: r.excluded === true,
  }));
  return { vendor, items: foldAddOns(ordered) };
}

export interface ImportPreview {
  invoiceId: string;
  vendor: string;
  productLines: number;
  itemCount: number;
  skipped: number;
  flaggedItemNames: string[];
  items: Array<{
    item_name: string;
    category_ids: string[];
    variations: Array<{ variation_name: string; sku: string; price: string; qty: number }>;
  }>;
  samplePayload: unknown;
}

export async function previewInvoiceImport(db: Queryable, clientId: string, invoiceId: string): Promise<ImportPreview> {
  const [{ vendor, items }, pricingRules, categoryMap] = await Promise.all([
    loadClassifiedProducts(db, invoiceId),
    loadPricingRules(db, clientId),
    loadCategoryMap(db, clientId),
  ]);

  const { lines: importLines, skipped, flaggedItemNames } = toImportLines(items, { pricingRules, categoryMap });
  const planned = planItems(importLines);

  return {
    invoiceId,
    vendor,
    productLines: items.length,
    itemCount: planned.length,
    skipped,
    flaggedItemNames,
    items: planned.map((p) => ({
      item_name: p.item_name,
      category_ids: p.category_ids,
      variations: p.variations.map((v) => ({
        variation_name: v.variation_name,
        sku: v.sku,
        price: '$' + (v.retail_cents / 100).toFixed(2),
        qty: v.qty,
      })),
    })),
    samplePayload: planned.length ? createItemBody(planned[0]!, { idempotencyKey: 'preview' }) : null,
  };
}
