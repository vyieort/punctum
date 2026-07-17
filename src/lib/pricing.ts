// Config-driven pricing.
//
// Port of the Make Sc2 bridge `calculatePricing` (module 59). The RE-specific values —
// the gold/default multipliers, what counts as "gold", and the rounding — now come from
// `client_config.pricing_rules` instead of being hardcoded, so a new client is a config
// row, not a code change. Behavior is proven identical to the Make bridge in
// tests/pricing.diff.test.ts.

/** One pricing rule: a condition on metals and/or vendors + the multiplier it applies. Within a
 *  dimension the strings are OR'd (any match); when BOTH metals and vendors are set, both must match
 *  (AND) — that's the "specific metal from a specific vendor" case. An empty rule matches nothing. */
export interface PricingRule {
  name?: string;
  metals?: string[]; // substrings matched against the item metal (OR)
  vendors?: string[]; // substrings matched against the item vendor (OR)
  multiplier: number;
}

export interface PricingRules {
  // Legacy binary gold/default. Kept for back-compat and as the fallback when `rules` is absent;
  // the Make-bridge parity test pins this path.
  multipliers: { gold: number; default: number };
  gold_when: { metal_contains: string[]; vendor_in: string[] };
  rounding: { op: 'ceil'; to_cents: number };
  // Rule-based pricing (takes precedence when present & non-empty): first matching rule wins,
  // else `default_multiplier`. `exempt_categories` are priced at cost (1×, no markup) — fees/tools.
  rules?: PricingRule[];
  default_multiplier?: number;
  exempt_categories?: string[]; // category paths (exact match) that skip markup
}

export interface PricingInput {
  metal?: string | null;
  vendor?: string | null;
  price?: number | string | null; // wholesale
  category?: string | null; // resolved category path, for fee/service exemption
}

export interface PricingResult {
  wholesale_cents: number;
  retail_cents: number;
  multiplier: number;
  exempt?: boolean; // priced at cost (a fee/service/tool)
}

const norm = (s: unknown): string => String(s ?? '').toLowerCase().trim();

/** Does a rule match this item's metal/vendor? metals & vendors OR within; both present => AND. */
function ruleMatches(rule: PricingRule, metal: string, vendor: string): boolean {
  const metals = rule.metals ?? [];
  const vendors = rule.vendors ?? [];
  const metalHit = metals.length ? metals.some((m) => metal.indexOf(norm(m)) !== -1) : null;
  const vendorHit = vendors.length ? vendors.some((v) => vendor.indexOf(norm(v)) !== -1) : null;
  if (metalHit !== null && vendorHit !== null) return metalHit && vendorHit; // both -> AND
  if (metalHit !== null) return metalHit;
  if (vendorHit !== null) return vendorHit;
  return false; // empty rule never matches
}

export function computePricing(item: PricingInput, rules: PricingRules): PricingResult {
  const metal = norm(item.metal);
  const vendor = norm(item.vendor);
  const category = norm(item.category);
  const wholesale =
    typeof item.price === 'number' ? item.price : parseFloat(String(item.price ?? '')) || 0;
  const wholesaleCents = Math.round(wholesale * 100);

  // Fee/service/tool exemption: sell at cost, no markup, no rounding.
  if (category && (rules.exempt_categories ?? []).some((c) => norm(c) === category)) {
    return { wholesale_cents: wholesaleCents, retail_cents: wholesaleCents, multiplier: 1, exempt: true };
  }

  let multiplier: number;
  if (rules.rules && rules.rules.length > 0) {
    const match = rules.rules.find((r) => ruleMatches(r, metal, vendor));
    multiplier = match ? match.multiplier : rules.default_multiplier ?? rules.multipliers.default;
  } else {
    // Legacy gold/default (unchanged — preserves Make-bridge parity).
    const isGold =
      rules.gold_when.metal_contains.some((m) => metal.indexOf(m) !== -1) ||
      rules.gold_when.vendor_in.some((v) => vendor.indexOf(v) !== -1);
    multiplier = isGold ? rules.multipliers.gold : rules.multipliers.default;
  }

  // Round the retail UP to the nearest `to_cents` (RE: 50 = nearest $0.50).
  const unit = rules.rounding.to_cents;
  const retailCents = Math.ceil((wholesale * multiplier * 100) / unit) * unit;

  return { wholesale_cents: wholesaleCents, retail_cents: retailCents, multiplier };
}
