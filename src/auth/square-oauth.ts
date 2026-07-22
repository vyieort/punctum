// Square OAuth: build the authorize URL and exchange the code (and refresh) for tokens. Lets each
// studio connect its OWN Square account instead of the single env token. App credentials come from
// SQUARE_APP_ID / SQUARE_APP_SECRET; SQUARE_OAUTH_ENV picks sandbox vs production. fetch injectable.

import type { SquareEnv } from '../lib/square-client.js';
import { appBaseUrl } from '../lib/app-url.js';

const OAUTH_HOSTS: Record<SquareEnv, string> = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
};

// Catalog + inventory read/write, plus merchant profile (to read the location on connect).
const SCOPES = ['ITEMS_READ', 'ITEMS_WRITE', 'INVENTORY_READ', 'INVENTORY_WRITE', 'MERCHANT_PROFILE_READ'];

export interface OAuthConfig {
  appId: string;
  appSecret: string;
  env: SquareEnv;
  redirectUri: string;
  fetchImpl?: typeof globalThis.fetch;
}

export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  const appId = env.SQUARE_APP_ID;
  const appSecret = env.SQUARE_APP_SECRET;
  if (!appId || !appSecret) throw new Error('SQUARE_APP_ID / SQUARE_APP_SECRET not set');
  const oenv: SquareEnv = env.SQUARE_OAUTH_ENV === 'production' ? 'production' : 'sandbox';
  // Must byte-match the Redirect URL registered in the Square dashboard (per environment).
  return { appId, appSecret, env: oenv, redirectUri: `${appBaseUrl(env)}/oauth/square/callback` };
}

export function squareAuthorizeUrl(cfg: OAuthConfig, state: string): string {
  const p = new URLSearchParams({
    client_id: cfg.appId,
    scope: SCOPES.join(' '),
    session: 'false',
    state,
    redirect_uri: cfg.redirectUri,
  });
  return `${OAUTH_HOSTS[cfg.env]}/oauth2/authorize?${p.toString()}`;
}

export interface SquareTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
  merchantId: string | null;
}

async function tokenRequest(cfg: OAuthConfig, body: Record<string, unknown>): Promise<SquareTokens> {
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${OAUTH_HOSTS[cfg.env]}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'square-version': '2026-01-22' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Square OAuth ${res.status}: ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: String(j.refresh_token ?? ''),
    expiresAt: typeof j.expires_at === 'string' ? j.expires_at : null,
    merchantId: typeof j.merchant_id === 'string' ? j.merchant_id : null,
  };
}

export function exchangeCode(cfg: OAuthConfig, code: string): Promise<SquareTokens> {
  return tokenRequest(cfg, {
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
}

export function refreshSquareToken(cfg: OAuthConfig, refreshToken: string): Promise<SquareTokens> {
  return tokenRequest(cfg, {
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
