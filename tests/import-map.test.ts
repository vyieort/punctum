// Bridge glue tests: classified item -> ImportLine (pricing + leaf/vendor category + flag).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toImportLine, toImportLines, type BridgeConfig } from '../src/lib/import-map.js';
import type { PricingRules } from '../src/lib/pricing.js';
import type { ClassifiedItem } from '../src/lib/classify.js';

const RULES: PricingRules = {
  multipliers: { gold: 2.5, default: 3.0 },
  gold_when: { metal_contains: ['14k', '18k', 'gold'], vendor_in: ['bvla'] },
  rounding: { op: 'ceil', to_cents: 50 },
};

const MAP = new Map<string, string>([
  ['Threadless > Threadless Ends > Bezel-Set', 'CAT_TL_BEZEL'],
  ['Rings > Seam Rings', 'CAT_SEAM'],
  ['Vendors > NeoMetal', 'CAT_V_NEO'],
  ['Vendors > BVLA', 'CAT_V_BVLA'],
  ['Diagnostic > Flag For Review', 'CAT_FLAG'],
]);

const CFG: BridgeConfig = { pricingRules: RULES, categoryMap: MAP };

const ci = (over: Partial<ClassifiedItem>): ClassifiedItem => ({
  vendor: '', sku: '', description: '', qty: '1', price: '0', product_type: '', thread_type: '', setting: '',
  stone_type: '', stone_color: '', metal: '', gauge: '', size: '', diameter: '', bar_length: '', style_name: '',
  is_complex: false, finish: '', ring_format: '', ring_style: '', barbell_format: '', barbell_subtype: '',
  item_name: '', variation_name: '', gems: '', notes: '', orientation: '', ...over,
});

test('non-gold end: default multiplier, leaf + vendor category, qty parsed', () => {
  const r = toImportLine(
    ci({ vendor: 'NeoMetal', product_type: 'THREADLESS_END', setting: 'bezel', metal: 'Titanium', price: '20', qty: '2', item_name: '18G 4MM Threadless Bezel-Set', variation_name: '4MM White Opal', sku: 'NEO-1' }),
    CFG,
  );
  assert.equal(r.line!.retail_cents, 6000); // 20 * 3.0 -> $60.00
  assert.equal(r.line!.wholesale_cents, 2000); // invoice cost carried through
  assert.equal(r.line!.category_id, 'CAT_TL_BEZEL');
  assert.equal(r.line!.vendor_category_id, 'CAT_V_NEO');
  assert.equal(r.line!.qty, 2);
  assert.ok(!r.flagged);
});

test('BVLA ring: gold multiplier + rounds up to $0.50, seam category', () => {
  const r = toImportLine(
    ci({ vendor: 'BVLA', product_type: 'RING', ring_format: 'SEAM', metal: 'Yellow 14K', price: '147', item_name: '18G Muse Seam Ring', sku: 'BVLA-1' }),
    CFG,
  );
  assert.equal(r.line!.retail_cents, 36750); // 147 * 2.5 -> $367.50
  assert.equal(r.line!.category_id, 'CAT_SEAM');
  assert.equal(r.line!.vendor_category_id, 'CAT_V_BVLA');
});

test('FILTER lines are skipped (not pushed)', () => {
  const r = toImportLine(ci({ product_type: 'FILTER', description: 'Insertion Taper' }), CFG);
  assert.equal(r.line, null);
  assert.equal(r.skipped, 'FILTER');
});

test('unroutable line is force-routed to Flag For Review and marked flagged', () => {
  const r = toImportLine(ci({ vendor: 'BVLA', product_type: 'FALLBACK', price: '10', item_name: 'Mystery', sku: 'Z' }), CFG);
  assert.equal(r.flagged, true);
  assert.match(r.flagReason ?? '', /undetermined/);
  assert.equal(r.line!.category_id, 'CAT_FLAG');
});

test('empty item_name falls back to the description so Square gets a name', () => {
  const r = toImportLine(ci({ product_type: 'THREADLESS_END', setting: 'bezel', item_name: '', description: 'Titanium Bezel 4mm White Opal', sku: 'X' }), CFG);
  assert.equal(r.line!.item_name, 'Titanium Bezel 4mm White Opal');
});

test('carries the item description into description_html for the push', () => {
  const r = toImportLine(
    ci({ vendor: 'NeoMetal', product_type: 'THREADLESS_END', setting: 'bezel', price: '20', item_name: '18G Bezel', description: 'Titanium Bezel 4mm White Opal', sku: 'NEO-9' }),
    CFG,
  );
  assert.equal(r.line!.description_html, 'Titanium Bezel 4mm White Opal');
});

test('no description leaves description_html unset', () => {
  const r = toImportLine(ci({ product_type: 'THREADLESS_END', setting: 'bezel', item_name: 'X', description: '', sku: 'Y' }), CFG);
  assert.equal(r.line!.description_html, undefined);
});

test('toImportLines aggregates: keeps products, counts skips + flags', () => {
  const out = toImportLines(
    [
      ci({ vendor: 'NeoMetal', product_type: 'THREADLESS_END', setting: 'bezel', metal: 'Titanium', price: '20', item_name: 'A' }),
      ci({ product_type: 'FILTER', description: 'Taper' }),
      ci({ product_type: 'FINISH', description: 'Finish upcharge' }),
      ci({ vendor: 'BVLA', product_type: 'FALLBACK', price: '5', item_name: 'Mystery' }),
    ],
    CFG,
  );
  assert.equal(out.lines.length, 2); // the two non-skipped
  assert.equal(out.skipped, 2); // FILTER + FINISH
  assert.deepEqual(out.flaggedItemNames, ['Mystery']);
});
