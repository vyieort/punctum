// Diff-test: the config-driven pricing port must be byte-for-byte identical to the Make
// Sc2 bridge over a wide input matrix. The oracle below is the exact `calculatePricing`
// from Make scenario 5330168, module 59 — verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, type PricingRules } from '../src/lib/pricing.js';

// --- Oracle: verbatim Make Sc2 bridge pricing (module 59) --------------------
function makeCalculatePricing(item: { metal?: unknown; vendor?: unknown; price?: unknown }) {
  const norm = (s: unknown) => String(s ?? '').toLowerCase().trim();
  const metal = norm(item.metal);
  const vendor = norm(item.vendor);
  const isGold =
    metal.indexOf('14k') !== -1 ||
    metal.indexOf('18k') !== -1 ||
    metal.indexOf('gold') !== -1 ||
    vendor.indexOf('bvla') !== -1;
  const multiplier = isGold ? 2.5 : 3.0;
  const wholesale = parseFloat(item.price as string) || 0;
  const retailCents = Math.ceil(wholesale * multiplier * 2) * 50;
  const wholesaleCents = Math.round(wholesale * 100);
  return { wholesale_cents: wholesaleCents, retail_cents: retailCents, multiplier };
}

// RE's pricing_rules exactly as seeded into client_config.
const RE_RULES: PricingRules = {
  multipliers: { gold: 2.5, default: 3.0 },
  gold_when: { metal_contains: ['14k', '18k', 'gold'], vendor_in: ['bvla'] },
  rounding: { op: 'ceil', to_cents: 50 },
};

const VENDORS = ['BVLA', 'NeoMetal', 'Anatometal', 'Quetzalli', 'Stiletto Piercing Supply', "People's Jewelry", ''];
const METALS = [
  'Yellow 14K', 'Rose 14K', 'White 14K', 'Yellow 18K', 'Rose 18K', 'White 18K',
  '14K Yellow Gold', 'solid gold', 'Titanium', 'Niobium', 'Sterling Silver', 'Steel', '', 'GOLD',
];
const PRICES: Array<number | string> = [0, 1, 2.5, 5, 5.5, 9.99, 10, 12.34, 40, 59, 110, 250.75, '75', '18.50'];

test('pricing port matches the Make bridge across the full input matrix', () => {
  let checked = 0;
  for (const vendor of VENDORS) {
    for (const metal of METALS) {
      for (const price of PRICES) {
        const item = { vendor, metal, price };
        const port = computePricing(item, RE_RULES);
        const oracle = makeCalculatePricing(item);
        assert.deepEqual(
          port,
          oracle,
          `mismatch for vendor="${vendor}" metal="${metal}" price=${price}: ` +
            `${JSON.stringify(port)} vs ${JSON.stringify(oracle)}`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked >= 500, `expected a broad matrix, only checked ${checked}`);
});

test('pricing spot-values (documented behavior)', () => {
  // Stiletto gold disk, $110 wholesale -> $275.00 (Make sample-execution value).
  assert.equal(computePricing({ vendor: 'Stiletto', metal: '14K', price: 110 }, RE_RULES).retail_cents, 27500);
  // BVLA always gold (×2.5): $59 -> $147.50.
  assert.equal(computePricing({ vendor: 'BVLA', metal: 'Titanium', price: 59 }, RE_RULES).retail_cents, 14750);
  // Non-gold (×3.0), round up to $0.50: $5.20 -> 5.20*3=15.60 -> $16.00.
  assert.equal(computePricing({ vendor: 'NeoMetal', metal: 'Titanium', price: 5.2 }, RE_RULES).retail_cents, 1600);
});
