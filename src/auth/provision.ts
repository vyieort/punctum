// Tenant provisioning: turn a freshly signed-up Supabase user into a real Punctum tenant. Creates
// the clients row (with a generated, readable client_id), a default client_config, and an owner
// membership. Idempotent per user — a retried signup returns the existing tenant, never a second.
//
// This is where client_id finally becomes a real, per-studio id instead of the legacy 'RE'
// placeholder (see project_client_model): every new studio gets its own slug-based key.

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../jobs/pg-rows.js';

// Sensible starting pricing so a brand-new tenant's imports aren't priced at cost. Two OR'd gold
// rules (metal OR vendor) + a 3× default + fee/service categories exempt from markup. Legacy
// multipliers/gold_when are kept for back-compat. The owner tunes all of this in Settings.
const DEFAULT_PRICING = {
  multipliers: { gold: 2.5, default: 3.0 },
  gold_when: { metal_contains: ['14k', '18k', 'gold'], vendor_in: ['bvla'] },
  rounding: { op: 'ceil', to_cents: 50 },
  rules: [
    { name: 'Gold metal', metals: ['14k', '18k', 'gold'], multiplier: 2.5 },
    { name: 'BVLA', vendors: ['bvla'], multiplier: 2.5 },
  ],
  default_multiplier: 3.0,
  exempt_categories: ['Piercing Fee', 'Service & Tool Fees', 'Diagnostic'],
};

/** A readable, collision-resistant tenant id from the studio name: slug + short random suffix. */
export function genClientId(studioName: string): string {
  const slug =
    (studioName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'studio';
  return `${slug}-${randomUUID().slice(0, 6)}`;
}

export interface ProvisionResult {
  clientId: string;
  created: boolean; // false when the user already had a tenant
}

export async function provisionTenant(
  db: Queryable,
  opts: { userId: string; studioName: string; email?: string | null; clientId?: string },
): Promise<ProvisionResult> {
  if (!opts.userId) throw new Error('provisionTenant: userId required');

  // Idempotent: if this user already owns a tenant, reuse it (a retried/double-submitted signup
  // must not create a second studio).
  const existing = await db.query(
    `select client_id from client_members where user_id = $1 order by created_at limit 1`,
    [opts.userId],
  );
  if (existing.rows.length > 0) {
    return { clientId: String((existing.rows[0] as { client_id: string }).client_id), created: false };
  }

  const clientId = opts.clientId ?? genClientId(opts.studioName);
  const name = opts.studioName?.trim() || 'My Studio';
  await db.query(
    `insert into clients (id, name, contact_email) values ($1, $2, $3) on conflict (id) do nothing`,
    [clientId, name, opts.email ?? null],
  );
  await db.query(
    `insert into client_config (client_id, pricing_rules, notification_emails)
       values ($1, $2::jsonb, $3) on conflict (client_id) do nothing`,
    [clientId, JSON.stringify(DEFAULT_PRICING), opts.email ? [opts.email] : []],
  );
  await db.query(
    `insert into client_members (user_id, client_id, email, role) values ($1, $2, $3, 'owner')
       on conflict (user_id, client_id) do nothing`,
    [opts.userId, clientId, opts.email ?? null],
  );
  return { clientId, created: true };
}
