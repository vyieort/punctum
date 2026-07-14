// Bridge glue: classified item -> ImportLine (Sc2 module 59's assembly step).
//
// Applies the ported pricing + category resolution, adds the vendor category (the second
// category Sc2 puts on each item), carries item_name/variation_name/sku/qty for grouping,
// and — like Sc2 — force-routes anything that resolves no category to Flag For Review so
// Square never rejects an empty category. FILTER/FINISH lines are skipped (not pushed).

import { computePricing, type PricingRules } from './pricing.js';
import { resolveCategoryPath, CATEGORY_PATHS } from './categories.js';
import type { ClassifiedItem } from './classify.js';
import type { ImportLine } from './square.js';

// vendor substring -> its "Vendors > X" category path (resolved to an id via category_map).
const VENDOR_CATEGORY_PATHS: Array<[string, string]> = [
  ['neometal', 'Vendors > NeoMetal'],
  ['anatometal', 'Vendors > Anatometal'],
  ['bvla', 'Vendors > BVLA'],
  ["people's jewelry", "Vendors > People's Jewelry"],
  ['peoples jewelry', "Vendors > People's Jewelry"],
  ['quetzalli', 'Vendors > Quetzalli'],
  ['glasswear', 'Vendors > Glasswear Studios'],
  ['stiletto', 'Vendors > Stiletto Piercing Supply'],
];

function vendorCategoryPath(vendor: string): string | null {
  const v = vendor.toLowerCase().trim();
  for (const [key, path] of VENDOR_CATEGORY_PATHS) if (v.includes(key)) return path;
  return null;
}

export interface BridgeConfig {
  pricingRules: PricingRules;
  categoryMap: ReadonlyMap<string, string>;
}

export interface BridgeResult {
  line: ImportLine | null; // null when skipped
  skipped?: 'FILTER' | 'FINISH';
  flagged?: boolean;
  flagReason?: string;
}

export function toImportLine(item: ClassifiedItem, cfg: BridgeConfig): BridgeResult {
  const pt = String(item.product_type ?? '').toUpperCase();
  if (pt === 'FILTER') return { line: null, skipped: 'FILTER' };
  if (pt === 'FINISH') return { line: null, skipped: 'FINISH' };

  const { retail_cents } = computePricing(item, cfg.pricingRules);

  const leafPath = resolveCategoryPath(item);
  let categoryId = leafPath ? (cfg.categoryMap.get(leafPath) ?? null) : null;
  let flagged = false;
  let flagReason: string | undefined;
  if (!categoryId) {
    flagged = true;
    flagReason =
      pt === 'FALLBACK' || pt === ''
        ? 'product type undetermined'
        : `no category for ${pt}${item.setting ? '/' + String(item.setting) : ''}`;
    categoryId = cfg.categoryMap.get(CATEGORY_PATHS.FLAG_FOR_REVIEW) ?? '';
  }

  const vendorPath = vendorCategoryPath(String(item.vendor ?? ''));
  const vendorCategoryId = vendorPath ? cfg.categoryMap.get(vendorPath) : undefined;

  const itemName =
    String(item.item_name ?? '').trim() || String(item.description ?? '').trim().slice(0, 60) || 'Unnamed Item';

  // Real item description for Square (replaces Sc2's grouping_key-as-description hack).
  const descriptionHtml = String(item.description ?? '').trim();

  const line: ImportLine = {
    item_name: itemName,
    variation_name: String(item.variation_name ?? '').trim(),
    sku: String(item.sku ?? '').trim(),
    retail_cents,
    qty: parseInt(String(item.qty ?? '1'), 10) || 1,
    category_id: categoryId,
    wholesale_cents: Math.round((parseFloat(String(item.price ?? '')) || 0) * 100),
    ...(vendorCategoryId ? { vendor_category_id: vendorCategoryId } : {}),
    ...(descriptionHtml ? { description_html: descriptionHtml } : {}),
  };
  return { line, flagged, flagReason };
}

export interface BridgeOutput {
  lines: ImportLine[];
  skipped: number;
  flaggedItemNames: string[];
}

/** Map a batch of classified items to import lines, dropping FILTER/FINISH. */
export function toImportLines(items: ClassifiedItem[], cfg: BridgeConfig): BridgeOutput {
  const lines: ImportLine[] = [];
  const flaggedItemNames: string[] = [];
  let skipped = 0;
  for (const it of items) {
    const r = toImportLine(it, cfg);
    if (!r.line) {
      skipped++;
      continue;
    }
    lines.push(r.line);
    if (r.flagged) flaggedItemNames.push(r.line.item_name);
  }
  return { lines, skipped, flaggedItemNames };
}
