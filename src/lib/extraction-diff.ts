// Compare two extractions of the same invoice — baseline (no vendor hints) vs hinted — so we can
// see, on a KNOWN vendor, exactly what a vendor profile changes before trusting it on new vendors.
// Pure + testable; the vendor-eval CLI runs the real model and feeds the two results in here.

import type { MergedInvoice } from './merged.js';

// The fields a vendor profile is most likely to move. Aligned by line index (a quick eval; a big
// line-count delta is surfaced separately since it shifts the alignment).
const KEY_FIELDS = ['sku', 'metal', 'gems', 'stone_type', 'product_type', 'item_name', 'variation_name', 'price', 'qty'] as const;

export interface FieldChange {
  line: number; // 1-based
  field: string;
  before: string;
  after: string;
}

export interface ExtractionDiff {
  baselineItems: number;
  hintedItems: number;
  changedLines: number;
  changes: FieldChange[];
}

const s = (v: unknown): string => (v == null ? '' : String(v));

export function diffExtractions(baseline: MergedInvoice, hinted: MergedInvoice): ExtractionDiff {
  const a = baseline.items ?? [];
  const b = hinted.items ?? [];
  const n = Math.max(a.length, b.length);
  const changes: FieldChange[] = [];
  const changedLines = new Set<number>();
  for (let i = 0; i < n; i++) {
    const ai = (a[i] ?? {}) as Record<string, unknown>;
    const bi = (b[i] ?? {}) as Record<string, unknown>;
    for (const f of KEY_FIELDS) {
      const before = s(ai[f]);
      const after = s(bi[f]);
      if (before !== after) {
        changes.push({ line: i + 1, field: f, before, after });
        changedLines.add(i);
      }
    }
  }
  return { baselineItems: a.length, hintedItems: b.length, changedLines: changedLines.size, changes };
}

/** Human-readable summary for the CLI. */
export function formatExtractionDiff(d: ExtractionDiff): string {
  const head =
    `baseline items: ${d.baselineItems}   hinted items: ${d.hintedItems}` +
    (d.baselineItems !== d.hintedItems ? '   ⚠ line count changed (index alignment below is approximate)' : '') +
    `\nlines changed: ${d.changedLines}   field changes: ${d.changes.length}`;
  if (d.changes.length === 0) return head + '\n(no field differences — the profile changed nothing on this invoice)';
  const rows = d.changes
    .map((c) => `  line ${c.line} · ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`)
    .join('\n');
  return `${head}\n${rows}`;
}
