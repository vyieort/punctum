// #32 Fold add-on line items into the jewelry price. On many invoices a piece's true cost is split
// across lines: the jewelry line, plus separate lines for a gem, a gold-threading upcharge, or a
// gauge-conversion fee. Those add-ons must be folded into the parent item's wholesale BEFORE markup,
// or retail is computed from an understated cost. Order-level charges (shipping/tax/handling) are
// NOT folded — they belong to no single item.
//
// Attribution prefers the AI-provided `folds_into` link (the parent line's SKU, or its exact
// description when it has no SKU); when that's absent it falls back to the nearest PRECEDING product
// line. The arithmetic lives here and is deterministic — the model decides WHICH item an add-on
// belongs to; code decides the money — so this is fully unit-tested.

import type { ClassifiedItem } from './classify.js';

export interface OrderedLine {
  item: ClassifiedItem;
  isProduct: boolean;
  excluded: boolean;
}

const numOr0 = (v: unknown): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const qtyOr1 = (v: unknown): number => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** The parent link the extractor may set on an add-on line (SKU or exact description). '' if none. */
export function foldsIntoKey(item: ClassifiedItem): string {
  const v = (item as Record<string, unknown>).folds_into;
  return v == null ? '' : String(v).trim();
}

// Order-level charges that must never fold into a single item.
const FEE_PATTERNS = /(shipping|freight|handling|insurance|postage|\btax\b|surcharge|fuel|delivery|discount|credit)/i;
// Per-item upcharges that DO fold — the fallback signal when the extractor didn't set folds_into.
const ADDON_PATTERNS = /(add[\s-]?on|thread(ed|ing)?|gauge conversion|conversion|upcharge|engrav|anodiz|\bgem\b|\bstone\b|accent)/i;

/** Is this non-product line an item add-on we should fold (vs an order-level fee we drop)? */
export function isFoldableAddOn(item: ClassifiedItem): boolean {
  if (foldsIntoKey(item)) return true; // the extractor linked it to a parent -> fold
  const hay = `${norm(item.description)} ${norm(item.item_name)}`;
  if (FEE_PATTERNS.test(hay)) return false; // shipping/tax/etc -> order-level fee
  return ADDON_PATTERNS.test(hay);
}

/**
 * Fold add-on lines into their parent products' wholesale and return ONLY the product items (in
 * order, cloned). Non-product lines are consumed: item add-ons raise a product's price; order fees
 * are dropped. Excluded lines are ignored on both sides.
 */
export function foldAddOns(lines: OrderedLine[]): ClassifiedItem[] {
  const products: ClassifiedItem[] = [];
  const bySku = new Map<string, ClassifiedItem>();
  const byName = new Map<string, ClassifiedItem>();
  const precedingProduct: Array<ClassifiedItem | null> = [];

  // Pass 1: clone products (so we can raise price without mutating the caller's objects), index them
  // by SKU and name for link matching, and record the preceding product at each position for the
  // adjacency fallback.
  let last: ClassifiedItem | null = null;
  for (const ln of lines) {
    precedingProduct.push(last);
    if (ln.isProduct && !ln.excluded) {
      const clone = { ...ln.item };
      products.push(clone);
      const sku = norm(clone.sku);
      if (sku) bySku.set(sku, clone);
      const nm = norm(clone.item_name) || norm(clone.description);
      if (nm && !byName.has(nm)) byName.set(nm, clone);
      last = clone;
    }
  }

  // Pass 2: fold each foldable add-on into its target — explicit link first (works regardless of
  // whether the parent is above or below), else the nearest preceding product.
  lines.forEach((ln, i) => {
    if (ln.isProduct || ln.excluded) return;
    if (!isFoldableAddOn(ln.item)) return; // order-level fee -> not folded
    const key = norm(foldsIntoKey(ln.item));
    let target: ClassifiedItem | null = null;
    if (key) target = bySku.get(key) ?? byName.get(key) ?? null;
    if (!target) target = precedingProduct[i] ?? null;
    if (!target) return; // add-on with no attributable product -> leave it out

    const addonTotal = numOr0(ln.item.price) * qtyOr1(ln.item.qty);
    if (addonTotal === 0) return;
    // Distribute the add-on's total across the parent's units so per-unit wholesale stays correct.
    const newUnit = numOr0(target.price) + addonTotal / qtyOr1(target.qty);
    target.price = String(Math.round(newUnit * 100) / 100);
  });

  return products;
}
