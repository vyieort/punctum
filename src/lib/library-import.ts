// Parse a Square Item Library export (.xlsx) into rows we can seed into catalog_mapping — the
// client-onboarding path (any client uploads their current library; nothing RE-specific).
//
// Column layout varies by account (e.g. the quantity column embeds the location name, and Cost
// may be absent), so we map by HEADER NAME, tolerantly, not by index. `mapLibraryRows` is a pure
// function (no xlsx dependency) so it's fully unit-testable; `parseSquareLibraryXlsx` is the thin
// reader that feeds it real workbook rows.

import * as XLSX from 'xlsx';
import { genSku } from './sku.js';

// Reverse of the tagger's vendor codes — to recover the vendor from an item name's [TAGS] suffix.
const VENDOR_BY_CODE: Record<string, string> = {
  NEO: 'NeoMetal', ANA: 'Anatometal', BVLA: 'BVLA', PJ: "People's Jewelry", QZ: 'Quetzalli',
  GW: 'Glasswear Studios', BJ: 'Buddha Jewelry', JNP: 'Junipurr', KJ: 'Kate Jack', LR: 'LeRoi',
  PH: 'Pupil Hall', SF: 'So Fine',
};

const tagSuffix = (itemName: string): string => {
  const m = itemName.match(/\[([^\]]*)\]\s*$/);
  return m ? m[1]!.trim() : '';
};

/** The POS tags stored in an item name's trailing [ ... ] suffix. */
export function extractTags(itemName: string): string {
  return tagSuffix(itemName);
}

/** Recover the vendor from an item name's [TAGS] suffix (contains a vendor code like ANA/BVLA). */
export function deriveVendor(itemName: string): string {
  for (const tok of tagSuffix(itemName).split(/\s+/)) {
    const v = VENDOR_BY_CODE[tok.toUpperCase()];
    if (v) return v;
  }
  return '';
}

const stripSuffix = (name: string): string => name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

/** Vendor SKU if present, else a synthetic one generated the same way invoices are (genSku). */
export function skuForRow(row: LibraryRow): string {
  if (row.sku) return row.sku;
  const base = stripSuffix(row.itemName);
  const desc = row.variationName ? `${base} - ${row.variationName}` : base;
  return genSku(deriveVendor(row.itemName), desc);
}

export interface LibraryRow {
  token: string; // Square variation catalog id -> square_variation_id (reorder-match key)
  itemName: string; // may carry a [TAGS] suffix already, kept as-is (it's the live Square name)
  variationName: string;
  sku: string;
  description: string;
  reportingCategory: string;
  retailCents: number;
  wholesaleCents: number | null; // from a 'Cost' column when present
  quantity: number | null;
}

const str = (v: unknown): string => (v == null ? '' : String(v).trim());
const cents = (v: unknown): number => {
  const n = parseFloat(str(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const int = (v: unknown): number | null => {
  const n = parseInt(str(v), 10);
  return Number.isFinite(n) ? n : null;
};

/** Map a header row + data rows to LibraryRows by header name (case-insensitive, tolerant). */
export function mapLibraryRows(header: unknown[], rows: unknown[][]): LibraryRow[] {
  const idx = new Map<string, number>();
  header.forEach((h, i) => idx.set(str(h).toLowerCase(), i));
  const col = (name: string): number => idx.get(name) ?? -1;
  const findCol = (re: RegExp): number => {
    for (const [h, i] of idx) if (re.test(h)) return i;
    return -1;
  };
  const at = (row: unknown[], i: number): unknown => (i >= 0 ? row[i] : undefined);

  const cToken = col('token');
  const cItem = col('item name');
  const cVar = col('variation name');
  const cSku = col('sku');
  const cDesc = col('description');
  const cCat = col('reporting category');
  const cPrice = col('price');
  const cCost = col('cost'); // often absent
  const cQty = findCol(/current quantity/) >= 0 ? findCol(/current quantity/) : findCol(/quantity/);

  const out: LibraryRow[] = [];
  for (const row of rows) {
    const token = str(at(row, cToken));
    const sku = str(at(row, cSku));
    if (!token && !sku) continue; // skip blank / spacer rows
    out.push({
      token,
      itemName: str(at(row, cItem)),
      variationName: str(at(row, cVar)),
      sku,
      description: str(at(row, cDesc)),
      reportingCategory: str(at(row, cCat)),
      retailCents: cents(at(row, cPrice)),
      wholesaleCents: cCost >= 0 ? cents(at(row, cCost)) : null,
      quantity: int(at(row, cQty)),
    });
  }
  return out;
}

/** Read the 'Items' sheet (or the first sheet) of a Square library .xlsx buffer. */
export function parseSquareLibraryXlsx(buffer: Buffer): LibraryRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.includes('Items') ? 'Items' : wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (grid.length === 0) return [];
  return mapLibraryRows(grid[0] as unknown[], grid.slice(1) as unknown[][]);
}
