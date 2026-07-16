// Per-client Square account: store the OAuth tokens (encrypted) and load a SquareConfig for a
// tenant. Until a client connects their own Square, loadSquareConfig falls back to the env token so
// the existing single-tenant (RE) flow keeps working during the transition.

import type { Queryable } from '../jobs/pg-rows.js';
import { squareConfigFromEnv, type SquareConfig, type SquareEnv } from './square-client.js';
import { encryptSecret, decryptSecret } from './crypto-box.js';
import type { SquareTokens } from '../auth/square-oauth.js';

export async function saveSquareAccount(
  db: Queryable,
  clientId: string,
  env: SquareEnv,
  tokens: SquareTokens,
  locationId: string | null,
): Promise<void> {
  await db.query(
    `insert into square_accounts (client_id, environment, merchant_id, location_id, access_token, refresh_token, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (client_id, environment) do update
       set merchant_id = $3,
           location_id = coalesce($4, square_accounts.location_id),
           access_token = $5, refresh_token = $6, expires_at = $7, updated_at = now()`,
    [
      clientId, env, tokens.merchantId, locationId,
      encryptSecret(tokens.accessToken),
      tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      tokens.expiresAt,
    ],
  );
}

export interface SquareConnection {
  connected: boolean;
  merchantId: string | null;
  environment: string | null;
  locationId: string | null;
}

export async function getSquareConnection(db: Queryable, clientId: string): Promise<SquareConnection> {
  const { rows } = await db.query(
    `select environment, merchant_id, location_id, access_token
       from square_accounts where client_id = $1 order by updated_at desc limit 1`,
    [clientId],
  );
  const r = rows[0] as { environment?: string; merchant_id?: string; location_id?: string; access_token?: string } | undefined;
  if (!r || !r.access_token) return { connected: false, merchantId: null, environment: null, locationId: null };
  return { connected: true, merchantId: r.merchant_id ?? null, environment: r.environment ?? null, locationId: r.location_id ?? null };
}

/** SquareConfig for a client: their stored OAuth token if connected, else the env token (RE/transition). */
export async function loadSquareConfig(db: Queryable, clientId: string): Promise<SquareConfig> {
  const { rows } = await db.query(
    `select environment, location_id, access_token from square_accounts where client_id = $1 order by updated_at desc limit 1`,
    [clientId],
  );
  const r = rows[0] as { environment?: string; location_id?: string; access_token?: string } | undefined;
  if (r && r.access_token && r.location_id) {
    return { token: decryptSecret(r.access_token), env: (r.environment as SquareEnv) ?? 'sandbox', locationId: r.location_id };
  }
  return squareConfigFromEnv();
}
