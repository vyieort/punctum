// Tenant resolution: turn an authenticated Supabase user into their client (tenant) scope, which
// replaces the ?client=RE query param as the source of truth. Kept dependency-free and pure where
// possible so it's unit-testable without a live Supabase.

import type { Queryable } from '../jobs/pg-rows.js';

/** The client_id a Supabase user belongs to (first membership), or null if none. */
export async function resolveClientForUser(db: Queryable, userId: string): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await db.query(
    `select client_id from client_members where user_id = $1 order by created_at limit 1`,
    [userId],
  );
  return rows.length > 0 ? String((rows[0] as { client_id: string }).client_id) : null;
}

/** Parse a Cookie header into a name->value map (decoded). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}
