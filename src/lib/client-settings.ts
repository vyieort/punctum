// Per-client preferences (client_config.settings jsonb). First setting: auto_enrich_images —
// studios supplying their own photos turn off the SerpAPI+Vision auto-match. Defaults to enabled.

import type { Queryable } from '../jobs/pg-rows.js';

export interface ClientSettings {
  autoEnrichImages: boolean;
}

export async function getClientSettings(db: Queryable, clientId: string): Promise<ClientSettings> {
  const { rows } = await db.query(`select settings from client_config where client_id = $1`, [clientId]);
  const raw = (rows[0] as { settings?: unknown } | undefined)?.settings;
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { autoEnrichImages: s.auto_enrich_images !== false }; // absent -> enabled (current behavior)
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
