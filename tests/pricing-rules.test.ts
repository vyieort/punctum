// Rule-based pricing: metal / vendor / both conditions, first-match-wins, default fallback, and
// fee/service category exemptions. The legacy gold_when path is covered by pricing.diff.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing, type PricingRules } from '../src/lib/pricing.js';

const base: PricingRules = {
  multipliers: { gold: 2.5, default: 3.0 },
  gold_when: { metal_contains: ['14k', '18k', 'gold'], vendor_in: ['bvla'] },
  rounding: { op: 'ceil', to_cents: 50 },
};

test('metal-only rule matches on metal, else default', () => {
  const rules: PricingRules = { ...base, rules: [{ metals: ['14k', 'gold'], multiplier: 2.5 }], default_multiplier: 3.0 };
  assert.equal(computePricing({ metal: 'Yellow 14K', vendor: 'Anatometal', price: 100 }, rules).multiplier, 2.5);
  assert.equal(computePricing({ metal: 'Titanium', vendor: 'Anatometal', price: 100 }, rules).multiplier, 3.0);
});

test('vendor-only rule matches on vendor, else default', () => {
  const rules: PricingRules = { ...base, rules: [{ vendors: ['bvla'], multiplier: 2.2 }], default_multiplier: 3.0 };
  assert.equal(computePricing({ metal: 'Titanium', vendor: 'BVLA', price: 100 }, rules).multiplier, 2.2);
  assert.equal(computePricing({ metal: 'Titanium', vendor: 'NeoMetal', price: 100 }, rules).multiplier, 3.0);
});

test('metal AND vendor rule requires both to match', () => {
  const rules: PricingRules = { ...base, rules: [{ metals: ['gold'], vendors: ['anatometal'], multiplier: 2.8 }], default_multiplier: 3.0 };
  assert.equal(computePricing({ metal: '14K Gold', vendor: 'Anatometal', price: 100 }, rules).multiplier, 2.8); // both
  assert.equal(computePricing({ metal: '14K Gold', vendor: 'BVLA', price: 100 }, rules).multiplier, 3.0); // vendor misses
  assert.equal(computePricing({ metal: 'Titanium', vendor: 'Anatometal', price: 100 }, rules).multiplier, 3.0); // metal misses
});

test('first matching rule wins', () => {
  const rules: PricingRules = {
    ...base,
    rules: [{ vendors: ['bvla'], multiplier: 2.0 }, { metals: ['gold'], multiplier: 2.5 }],
    default_multiplier: 3.0,
  };
  assert.equal(computePricing({ metal: '14K Gold', vendor: 'BVLA', price: 100 }, rules).multiplier, 2.0);
});

test('fee/service categories are priced at cost — no markup, no rounding', () => {
  const rules: PricingRules = { ...base, exempt_categories: ['Piercing Fee', 'Service & Tool Fees'] };
  const r = computePricing({ metal: '', vendor: '', price: 40, category: 'Service & Tool Fees' }, rules);
  assert.equal(r.exempt, true);
  assert.equal(r.multiplier, 1);
  assert.equal(r.retail_cents, 4000); // = wholesale
});

test('exemption is case-insensitive and leaves other categories priced normally', () => {
  const rules: PricingRules = { ...base, exempt_categories: ['Piercing Fee'] };
  assert.equal(computePricing({ price: 40, category: 'piercing fee' }, rules).exempt, true);
  // A normal item (legacy ×3, round up to $0.50): 5.2 × 3 = 15.60 -> $16.00
  const normal = computePricing({ metal: 'Titanium', vendor: 'NeoMetal', price: 5.2, category: 'Threadless > Threadless Ends' }, rules);
  assert.equal(normal.exempt ?? false, false);
  assert.equal(normal.retail_cents, 1600);
});
