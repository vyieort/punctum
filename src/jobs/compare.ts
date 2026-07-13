// A/B: run BOTH pipelines on the same invoice and diff the classifications.
//   two-pass (current): extract -> parse -> fillSkus -> classify
//   one-pass (merged):  extractAndClassify
// Both produce ClassifiedItem[]; we match products by SKU and diff their fields, SPLIT into
// output-critical fields (what actually builds the catalog — grouping, category, price) and
// supporting fields (internal/detail fields that feed into the critical ones or aren't used).
// A line "agrees" for the merge decision when the CRITICAL fields match.

import type { AnthropicOptions } from '../lib/anthropic.js';
import { extractInvoiceText } from '../lib/anthropic.js';
import { parseInvoiceLines, type ExtractedLineItem } from '../lib/parse.js';
import { fillSkus } from '../lib/sku.js';
import { classifyLines, type ClassifiedItem, type ClassifierLineInput } from '../lib/classify.js';
import { extractAndClassify } from '../lib/merged.js';

// The fields that determine catalog OUTPUT: grouping (item_name/variation_name), category
// (product_type/thread_type/setting/ring_format/barbell_format), and price (metal).
const CRITICAL_FIELDS = [
  'item_name', 'variation_name', 'product_type', 'thread_type', 'setting',
  'ring_format', 'barbell_format', 'metal',
] as const;
// Detail fields — they feed into the critical ones (so if item_name/variation_name agree,
// their differences didn't matter) or aren't used downstream. Reported separately.
const SUPPORTING_FIELDS = [
  'stone_type', 'stone_color', 'gauge', 'size', 'diameter', 'bar_length', 'style_name',
  'is_complex', 'ring_style', 'barbell_subtype', 'orientation',
] as const;

export interface FieldDiff {
  field: string;
  twoPass: unknown;
  onePass: unknown;
}
export interface LineComparison {
  sku: string;
  description: string;
  critical: FieldDiff[]; // catalog-output differences — the ones that matter
  supporting: FieldDiff[]; // cosmetic / internal differences
}
export interface InvoiceComparison {
  products: { twoPass: number; onePass: number };
  matched: number;
  criticalAgree: number; // matched lines whose catalog output is identical
  criticalDiffer: number;
  lines: LineComparison[]; // lines with any diff, critical-first
  unmatched: { twoPassOnly: string[]; onePassOnly: string[] };
}

const s = (v: unknown): string => String(v ?? '').trim();
const isProduct = (i: ClassifiedItem): boolean => i.is_product !== false;

function diffFields(a: ClassifiedItem, b: ClassifiedItem, fields: readonly string[]): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of fields) {
    if (s(a[f]) !== s(b[f])) out.push({ field: f, twoPass: a[f], onePass: b[f] });
  }
  return out;
}

export function compareClassifications(twoPass: ClassifiedItem[], onePass: ClassifiedItem[]): InvoiceComparison {
  const two = twoPass.filter(isProduct);
  const one = onePass.filter(isProduct);

  const oneBySku = new Map<string, ClassifiedItem>();
  for (const it of one) {
    const k = s(it.sku);
    if (k) oneBySku.set(k, it);
  }

  const matchedSkus = new Set<string>();
  const lines: LineComparison[] = [];
  let criticalAgree = 0;

  for (const a of two) {
    const k = s(a.sku);
    const b = k ? oneBySku.get(k) : undefined;
    if (!b) continue;
    matchedSkus.add(k);
    const critical = diffFields(a, b, CRITICAL_FIELDS);
    const supporting = diffFields(a, b, SUPPORTING_FIELDS);
    if (critical.length === 0) criticalAgree++;
    if (critical.length || supporting.length) lines.push({ sku: k, description: s(a.description), critical, supporting });
  }

  // Surface the catalog-output disagreements first.
  lines.sort((x, y) => y.critical.length - x.critical.length);

  const twoSkus = new Set(two.map((a) => s(a.sku)).filter(Boolean));
  const oneSkus = new Set(one.map((a) => s(a.sku)).filter(Boolean));

  return {
    products: { twoPass: two.length, onePass: one.length },
    matched: matchedSkus.size,
    criticalAgree,
    criticalDiffer: matchedSkus.size - criticalAgree,
    lines,
    unmatched: { twoPassOnly: [...twoSkus].filter((k) => !oneSkus.has(k)), onePassOnly: [...oneSkus].filter((k) => !twoSkus.has(k)) },
  };
}

/** The current two-pass pipeline, run in-memory (no DB): extract -> parse -> fillSkus -> classify. */
export async function twoPassClassify(pdfBase64: string, opts: AnthropicOptions = {}): Promise<ClassifiedItem[]> {
  const raw = await extractInvoiceText(pdfBase64, opts);
  const parsed = parseInvoiceLines(raw);
  const filled = fillSkus(parsed.vendor_name, parsed.line_items) as unknown as ExtractedLineItem[];
  const products = filled.filter((l) => l.is_product !== false);
  const input: ClassifierLineInput[] = products.map((l) => ({
    vendor: parsed.vendor_name,
    sku: s(l.sku),
    description: s(l.description),
    qty: l.quantity ?? 1,
    price: l.unit_price ?? 0,
    gems: s(l.gems),
    notes: s(l.notes),
  }));
  return classifyLines(input, opts);
}

export interface CompareDeps {
  anthropic?: AnthropicOptions;
  twoPass?: (pdf: string, opts?: AnthropicOptions) => Promise<ClassifiedItem[]>;
  onePass?: (pdf: string, opts?: AnthropicOptions) => Promise<ClassifiedItem[]>;
}

export async function runComparison(pdfBase64: string, deps: CompareDeps = {}): Promise<InvoiceComparison> {
  const two = await (deps.twoPass ?? twoPassClassify)(pdfBase64, deps.anthropic);
  const one = await (deps.onePass ?? extractAndClassify)(pdfBase64, deps.anthropic);
  return compareClassifications(two, one);
}
