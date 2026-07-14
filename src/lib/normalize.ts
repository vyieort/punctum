// Deterministic normalization guards for the classified item, applied at intake before
// storing — so what we persist (and later push to Square) is consistent regardless of how
// the model happened to phrase it. From the A/B punch-list:
//   - inch marks: straight " -> ″ (proper inch mark) in the naming/measurement fields
//   - casing: title-case ALL-CAPS words (SMALL -> Small, MOONSTONE -> Moonstone) so a
//     design name can't split grouping across invoices
//
// Only touches classification/naming fields — never description/gems/notes/sku, which stay
// faithful to the invoice for the human review.

import type { ClassifiedItem } from './classify.js';

// Straight double-quote -> ″. Apostrophes (') are NOT touched — they appear in gem names
// like "Tiger's Eye" and are not foot marks.
const inch = (v: string): string => v.replace(/"/g, '″');

// Title-case a fully-uppercase word of 4+ letters. Tokens with digits (YG14K, 18G) and short
// codes (CZ, AA, AAA, SEP) never match, so metal/grade/orientation codes are preserved.
const titleCaps = (v: string): string =>
  v.replace(/\b[A-Z]{4,}\b/g, (w) => w.charAt(0) + w.slice(1).toLowerCase());

const nameNorm = (v: unknown): string => titleCaps(inch(String(v ?? '')));

export function normalizeClassification(item: ClassifiedItem): ClassifiedItem {
  return {
    ...item,
    item_name: nameNorm(item.item_name),
    variation_name: nameNorm(item.variation_name),
    style_name: titleCaps(String(item.style_name ?? '')),
    size: inch(String(item.size ?? '')),
    diameter: inch(String(item.diameter ?? '')),
    bar_length: inch(String(item.bar_length ?? '')),
  };
}
