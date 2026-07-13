// Import dry-run: run the full chain (classify -> price/categorize -> group -> payloads)
// on an approved invoice and return what WOULD be sent to Square. Reads the DB and calls
// the classifier (Claude), but makes zero Square calls — a safe pre-flight.

import type { Queryable } from './pg-rows.js';
import type { PricingRules } from '../lib/pricing.js';
import { classifyLines, type ClassifiedItem, type ClassifierLineInput } from '../lib/classify.js';
import type { AnthropicOptions } from '../lib/anthropic.js';
import { toImportLines } from '../lib/import-map.js';
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

async function loadInvoiceLines(
  db: Queryable,
  invoiceId: string,
): Promise<{ vendor: string; lines: ClassifierLineInput[] }> {
  const inv = await db.query(`select vendor from invoices where id = $1`, [invoiceId]);
  if (inv.rows.length === 0) throw new Error(`invoice ${invoiceId} not found`);
  const vendor = String((inv.rows[0] as { vendor: string | null }).vendor ?? '');
  const l = await db.query(
    `select synthetic_sku, description, quantity::text as quantity, wholesale::text as wholesale,
            gems, notes, is_product
       from invoice_lines where invoice_id = $1 order by line_no nulls last, created_at`,
    [invoiceId],
  );
  const lines = (l.rows as Array<Record<string, unknown>>)
    .filter((r) => r.is_product !== false)
    .map((r) => ({
      vendor,
      sku: String(r.synthetic_sku ?? ''),
      description: String(r.description ?? ''),
      qty: String(r.quantity ?? ''),
      price: String(r.wholesale ?? ''),
      gems: String(r.gems ?? ''),
      notes: String(r.notes ?? ''),
    }));
  return { vendor, lines };
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
  samplePayload: unknown; // the createItemBody for the first item, exactly as it would be sent
}

export type Classifier = (lines: ClassifierLineInput[], opts?: AnthropicOptions) => Promise<ClassifiedItem[]>;

export async function previewInvoiceImport(
  db: Queryable,
  clientId: string,
  invoiceId: string,
  opts: { classify?: Classifier; anthropic?: AnthropicOptions } = {},
): Promise<ImportPreview> {
  const [{ vendor, lines }, pricingRules, categoryMap] = await Promise.all([
    loadInvoiceLines(db, invoiceId),
    loadPricingRules(db, clientId),
    loadCategoryMap(db, clientId),
  ]);

  const classify = opts.classify ?? classifyLines;
  const classified = await classify(lines, opts.anthropic);

  const { lines: importLines, skipped, flaggedItemNames } = toImportLines(classified, { pricingRules, categoryMap });
  const planned = planItems(importLines);

  return {
    invoiceId,
    vendor,
    productLines: lines.length,
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
