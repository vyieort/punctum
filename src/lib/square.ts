// Square catalog import planner + payload builders.
//
// Port of Sc2's write side (scenario 5330168), with one deliberate improvement: Sc2
// processes invoice lines one at a time and re-queries Square by item name to regroup
// them, which can spawn duplicate items within an invoice and double-count inventory on a
// re-run. Punctum instead groups the invoice's lines IN MEMORY (one item, N variations)
// and builds a single payload per item.
//
// These are pure functions (no network) so the whole plan is unit-testable; the live
// Square client (added later) consumes createItemBody / addVariationBody /
// inventoryAdjustBody and POSTs them.

import { generateTags } from './tagger.js';

/** A classified + priced invoice line, ready to be grouped into a catalog item. */
export interface ImportLine {
  item_name: string; // shared across variations of one product (the grouping key)
  variation_name: string; // the differentiator (color/size/metal)
  sku: string;
  retail_cents: number;
  qty: number;
  category_id: string; // leaf / reporting category
  vendor_category_id?: string; // optional second (vendor) category
  description_html?: string; // optional item description
  wholesale_cents?: number; // invoice cost, carried for the mapping/review
}

export interface PlannedVariation {
  variation_name: string;
  sku: string;
  retail_cents: number;
  qty: number;
  wholesale_cents?: number;
}

export interface PlannedItem {
  item_name: string; // base name (no tag suffix)
  category_ids: string[]; // [leaf, vendor?]
  reporting_category_id: string;
  variations: PlannedVariation[];
  description_html?: string;
  tags?: string; // POS search-suffix codes (space-joined), appended to the Square name
}

/**
 * Group lines into catalog items by item_name. Within an item, lines that share a
 * variation_name are the same physical product (e.g. the same SKU appearing twice on the
 * invoice) and are merged, summing quantity. Insertion order is preserved.
 */
export function planItems(lines: ImportLine[]): PlannedItem[] {
  const byItem = new Map<string, PlannedItem>();
  for (const l of lines) {
    let item = byItem.get(l.item_name);
    if (!item) {
      item = {
        item_name: l.item_name,
        category_ids: [l.category_id, ...(l.vendor_category_id ? [l.vendor_category_id] : [])],
        reporting_category_id: l.category_id,
        variations: [],
        ...(l.description_html ? { description_html: l.description_html } : {}),
      };
      byItem.set(l.item_name, item);
    }
    const existing = item.variations.find((v) => v.variation_name === l.variation_name);
    if (existing) {
      existing.qty += l.qty;
    } else {
      item.variations.push({
        variation_name: l.variation_name,
        sku: l.sku,
        retail_cents: l.retail_cents,
        qty: l.qty,
        ...(l.wholesale_cents != null ? { wholesale_cents: l.wholesale_cents } : {}),
      });
    }
  }

  // Square SKUs must be unique across the WHOLE catalog, not just within one item. Gem-pairing
  // (Anatometal) reuses one parent SKU across several gem variations (which may land in the
  // same or different items), so any SKU used more than once gets a deterministic suffix from
  // its variation name — same variation -> same SKU, so reorders still line up.
  const items = [...byItem.values()];
  const counts = new Map<string, number>();
  for (const item of items) for (const v of item.variations) counts.set(v.sku, (counts.get(v.sku) ?? 0) + 1);
  for (const item of items) {
    for (const v of item.variations) {
      if ((counts.get(v.sku) ?? 0) > 1) v.sku = `${v.sku}-${skuSlug(v.variation_name)}`;
    }
  }
  return items;
}

const skuSlug = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 24);

/**
 * Compute the POS search-suffix tag string for a planned item (vendor + its variations),
 * using the ported Sc2.5 tagger. Empty when the tagger produces nothing.
 */
export function computePosTags(vendor: string, item: PlannedItem): string {
  if (item.variations.length === 0) return '';
  const rows = item.variations.map((v, i) => ({
    vendor,
    itemName: item.item_name,
    variationName: v.variation_name,
    catalogId: item.item_name || 'item', // generateTags requires a non-empty group id
    rowNumber: i + 1,
  }));
  return generateTags(rows).tags;
}

/** The Square-facing item name: base name plus the `[TAGS]` search suffix when present. */
export function displayName(item: Pick<PlannedItem, 'item_name' | 'tags'>): string {
  const tags = (item.tags ?? '').trim();
  return tags ? `${item.item_name} [${tags}]` : item.item_name;
}

const variationData = (v: PlannedVariation) => ({
  name: v.variation_name,
  sku: v.sku,
  track_inventory: true,
  pricing_type: 'FIXED_PRICING',
  price_money: { amount: v.retail_cents, currency: 'USD' },
});

/** POST /v2/catalog/object — create a new ITEM with all its variations in one call. */
export function createItemBody(item: PlannedItem, opts: { idempotencyKey: string }) {
  return {
    idempotency_key: opts.idempotencyKey,
    object: {
      type: 'ITEM',
      id: '#new-item',
      item_data: {
        name: displayName(item),
        ...(item.description_html ? { description_html: item.description_html } : {}),
        categories: item.category_ids.map((id) => ({ id })),
        reporting_category: { id: item.reporting_category_id },
        variations: item.variations.map((v, i) => ({
          type: 'ITEM_VARIATION',
          id: `#new-variation-${i}`,
          item_variation_data: variationData(v),
        })),
      },
    },
  };
}

/** POST /v2/catalog/object — add one ITEM_VARIATION to an item that already exists. */
export function addVariationBody(itemId: string, v: PlannedVariation, opts: { idempotencyKey: string }) {
  return {
    idempotency_key: opts.idempotencyKey,
    object: {
      type: 'ITEM_VARIATION',
      id: '#upsert-var',
      item_variation_data: { item_id: itemId, ...variationData(v) },
    },
  };
}

/**
 * POST /v2/inventory/changes/batch-create — receive qty into stock (NONE -> IN_STOCK).
 * Additive, exactly like Sc2: a reorder adds to the existing count.
 */
export function inventoryAdjustBody(
  variationId: string,
  qty: number,
  opts: { locationId: string; occurredAt: string; idempotencyKey: string },
) {
  return {
    idempotency_key: opts.idempotencyKey,
    changes: [
      {
        type: 'ADJUSTMENT',
        adjustment: {
          catalog_object_id: variationId,
          from_state: 'NONE',
          to_state: 'IN_STOCK',
          location_id: opts.locationId,
          occurred_at: opts.occurredAt,
          quantity: String(qty),
        },
      },
    ],
  };
}
