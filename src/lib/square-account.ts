// Per-client Square account: store the OAuth tokens (encrypted) and load a SquareConfig for a
// tenant. Until a client connects their own Square, loadSquareConfig falls back to the env token so
// the existing single-tenant (RE) flow keeps working during the transition.

import type { Queryable } from '../jobs/pg-rows.js';
import { squareConfigFromEnv, type SquareConfig, type SquareEnv } from './square-client.js';
import { encryptSecret, decryptSecret } from './crypto-box.js';
import { refreshSquareToken, oauthConfigFromEnv, type SquareTokens } from '../auth/square-oauth.js';

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
       set merchant_id = coalesce($3, square_accounts.merchant_id),
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

/** Refresh a Square access token once it's within this window of expiry. Square access tokens last
 *  ~30 days and refresh tokens ~90; refreshing well before expiry keeps a tenant connected without
 *  manual reconnection. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LoadSquareOpts {
  now?: Date;
  refreshWindowMs?: number;
  /** Injectable for tests; defaults to the real Square OAuth refresh (app creds from env). */
  refresh?: (refreshToken: string, env: SquareEnv) => Promise<SquareTokens>;
}

function tokenNearExpiry(expiresAt: string | null | undefined, now: Date, windowMs: number): boolean {
  if (!expiresAt) return false; // unknown expiry -> leave it alone
  const exp = new Date(expiresAt).getTime();
  if (Number.isNaN(exp)) return false;
  return exp - now.getTime() <= windowMs; // includes already-expired (negative delta)
}

function defaultRefresh(refreshToken: string, env: SquareEnv): Promise<SquareTokens> {
  return refreshSquareToken({ ...oauthConfigFromEnv(), env }, refreshToken);
}

// De-dupe concurrent refreshes for one client: a burst of jobs shouldn't fire N refreshes at once
// (and a rotated refresh_token shouldn't be clobbered by a racing refresh). Cleared on completion.
const inflightRefresh = new Map<string, Promise<SquareTokens>>();

function refreshAndSave(
  db: Queryable,
  clientId: string,
  env: SquareEnv,
  refreshToken: string,
  locationId: string,
  refresh: (rt: string, env: SquareEnv) => Promise<SquareTokens>,
): Promise<SquareTokens> {
  const pending = inflightRefresh.get(clientId);
  if (pending) return pending;
  const p = (async () => {
    const tokens = await refresh(refreshToken, env);
    await saveSquareAccount(db, clientId, env, tokens, locationId);
    return tokens;
  })().finally(() => inflightRefresh.delete(clientId));
  inflightRefresh.set(clientId, p);
  return p;
}

/** SquareConfig for a client: their stored OAuth token if connected (auto-refreshed when it's near
 *  expiry), else the env token (Danforth Butchery / transition). */
export async function loadSquareConfig(db: Queryable, clientId: string, opts: LoadSquareOpts = {}): Promise<SquareConfig> {
  const { rows } = await db.query(
    `select environment, location_id, access_token, refresh_token, expires_at
       from square_accounts where client_id = $1 order by updated_at desc limit 1`,
    [clientId],
  );
  const r = rows[0] as
    | { environment?: string; location_id?: string; access_token?: string; refresh_token?: string; expires_at?: string }
    | undefined;
  if (r && r.access_token && r.location_id) {
    const env = (r.environment as SquareEnv) ?? 'sandbox';
    let token = decryptSecret(r.access_token);
    const now = opts.now ?? new Date();
    const windowMs = opts.refreshWindowMs ?? REFRESH_WINDOW_MS;
    if (r.refresh_token && tokenNearExpiry(r.expires_at, now, windowMs)) {
      try {
        const tokens = await refreshAndSave(
          db, clientId, env, decryptSecret(r.refresh_token), r.location_id, opts.refresh ?? defaultRefresh,
        );
        if (tokens.accessToken) token = tokens.accessToken;
      } catch {
        // Best-effort: keep the stored token. A hard 401 surfaces via the push error path, and the
        // studio can reconnect Square from Settings.
      }
    }
    return { token, env, locationId: r.location_id };
  }
  return squareConfigFromEnv();
}
