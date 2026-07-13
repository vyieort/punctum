// A/B: run BOTH pipelines on the same invoice and diff the classifications.
//   two-pass (current): extract -> parse -> fillSkus -> classify
//   one-pass (merged):  extractAndClassify
// Both produce ClassifiedItem[]; we match products by SKU and diff the catalog-decision
// fields, so we can judge every disagreement against the real invoice.

import type { AnthropicOptions } from '../lib/anthropic.js';
import { extractInvoiceText } from '../lib/anthropic.js';
import { parseInvoiceLines, type ExtractedLineItem } from '../lib/parse.js';
import { fillSkus } from '../lib/sku.js';
import { classifyLines, type ClassifiedItem, type ClassifierLineInput } from '../lib/classify.js';
import { extractAndClassify } from '../lib/merged.js';

// The classification decisions that actually drive the catalog (grouping, naming, pricing,
// categorization). Echoed extraction fields (qty/price/gems/notes) are not compared here.
const COMPARE_FIELDS = [
  'product_type', 'thread_type', 'setting', 'stone_type', 'stone_color', 'metal', 'gauge',
  'size', 'diameter', 'bar_length', 'style_name', 'is_complex', 'ring_format', 'ring_style',
  'barbell_format', 'barbell_subtype', 'item_name', 'variation_name', 'orientation',
] as const;

export interface FieldDiff {
  field: string;
  twoPass: unknown;
  onePass: unknown;
}
export interface LineComparison {
  sku: string;
  description: string;
  agree: boolean;
  diffs: FieldDiff[];
}
export interface InvoiceComparison {
  products: { twoPass: number; onePass: number };
  matched: number;
  agreements: number;
  disagreements: number;
  lines: LineComparison[]; // only the lines that disagree, for signal
  unmatched: { twoPassOnly: string[]; onePassOnly: string[] };
}

const s = (v: unknown): string => String(v ?? '').trim();
const isProduct = (i: ClassifiedItem): boolean => i.is_product !== false;

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
  let agreements = 0;

  for (const a of two) {
    const k = s(a.sku);
    const b = k ? oneBySku.get(k) : undefined;
    if (!b) continue;
    matchedSkus.add(k);
    const diffs: FieldDiff[] = [];
    for (const f of COMPARE_FIELDS) {
      if (s(a[f]) !== s(b[f])) diffs.push({ field: f, twoPass: a[f], onePass: b[f] });
    }
    if (diffs.length === 0) agreements++;
    else lines.push({ sku: k, description: s(a.description), agree: false, diffs });
  }

  const twoSkus = new Set(two.map((a) => s(a.sku)).filter(Boolean));
  const oneSkus = new Set(one.map((a) => s(a.sku)).filter(Boolean));
  const twoPassOnly = [...twoSkus].filter((k) => !oneSkus.has(k));
  const onePassOnly = [...oneSkus].filter((k) => !twoSkus.has(k));

  return {
    products: { twoPass: two.length, onePass: one.length },
    matched: matchedSkus.size,
    agreements,
    disagreements: lines.length,
    lines,
    unmatched: { twoPassOnly, onePassOnly },
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
