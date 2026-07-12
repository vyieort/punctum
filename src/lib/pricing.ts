// Config-driven pricing.
//
// Port of the Make Sc2 bridge `calculatePricing` (module 59). The RE-specific values —
// the gold/default multipliers, what counts as "gold", and the rounding — now come from
// `client_config.pricing_rules` instead of being hardcoded, so a new client is a config
// row, not a code change. Behavior is proven identical to the Make bridge in
// tests/pricing.diff.test.ts.

export interface PricingRules {
  multipliers: { gold: number; default: number };
  gold_when: { metal_contains: string[]; vendor_in: string[] };
  rounding: { op: 'ceil'; to_cents: number };
}

export interface PricingInput {
  metal?: string | null;
  vendor?: string | null;
  price?: number | string | null; // wholesale
}

export interface PricingResult {
  wholesale_cents: number;
  retail_cents: number;
  multiplier: number;
}

const norm = (s: unknown): string => String(s ?? '').toLowerCase().trim();

export function computePricing(item: PricingInput, rules: PricingRules): PricingResult {
  const metal = norm(item.metal);
  const vendor = norm(item.vendor);

  const isGold =
    rules.gold_when.metal_contains.some((m) => metal.indexOf(m) !== -1) ||
    rules.gold_when.vendor_in.some((v) => vendor.indexOf(v) !== -1);

  const multiplier = isGold ? rules.multipliers.gold : rules.multipliers.default;

  const wholesale =
    typeof item.price === 'number' ? item.price : parseFloat(String(item.price ?? '')) || 0;

  // Round the retail UP to the nearest `to_cents` (RE: 50 = nearest $0.50).
  const unit = rules.rounding.to_cents;
  const retailCents = Math.ceil((wholesale * multiplier * 100) / unit) * unit;
  const wholesaleCents = Math.round(wholesale * 100);

  return { wholesale_cents: wholesaleCents, retail_cents: retailCents, multiplier };
}
