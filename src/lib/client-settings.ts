// Per-client preferences (client_config.settings jsonb). First setting: auto_enrich_images —
// studios supplying their own photos turn off the SerpAPI+Vision auto-match. Defaults to enabled.

import type { Queryable } from '../jobs/pg-rows.js';
import type { PricingRules } from './pricing.js';

export interface ClientSettings {
  autoEnrichImages: boolean;
  pricingReviewed: boolean; // owner has confirmed pricing (drives the onboarding step)
}

export async function getClientSettings(db: Queryable, clientId: string): Promise<ClientSettings> {
  const { rows } = await db.query(`select settings from client_config where client_id = $1`, [clientId]);
  const raw = (rows[0] as { settings?: unknown } | undefined)?.settings;
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    autoEnrichImages: s.auto_enrich_images !== false, // absent -> enabled (current behavior)
    pricingReviewed: s.pricing_reviewed === true,
  };
}

/** Persist the tenant's pricing rules and mark pricing as reviewed (satisfies the onboarding step).
 *  Upserts so it works whether or not the client_config row already exists. */
export async function savePricingRules(db: Queryable, clientId: string, rules: PricingRules): Promise<void> {
  await db.query(
    `insert into client_config (client_id, pricing_rules, settings)
       values ($1, $2::jsonb, jsonb_build_object('pricing_reviewed', true))
     on conflict (client_id) do update
       set pricing_rules = $2::jsonb,
           settings = coalesce(client_config.settings, '{}'::jsonb) || jsonb_build_object('pricing_reviewed', true),
           updated_at = now()`,
    [clientId, JSON.stringify(rules)],
  );
}

/** Set the auto-enrich toggle, creating the client_config row if needed (merges, doesn't clobber). */
export async function setAutoEnrichImages(db: Queryable, clientId: string, on: boolean): Promise<void> {
  await db.query(
    `insert into client_config (client_id, settings)
       values ($1, jsonb_build_object('auto_enrich_images', $2::boolean))
     on conflict (client_id) do update
       set settings = coalesce(client_config.settings, '{}'::jsonb) || jsonb_build_object('auto_enrich_images', $2::boolean),
           updated_at = now()`,
    [clientId, on],
  );
}
