// Supabase session verification (asymmetric JWTs). Access tokens are signed with Supabase's
// private key; we verify against their published JWKS (public keys) at
// {SUPABASE_URL}/auth/v1/.well-known/jwks.json. jose handles JWKS fetch/caching + key rotation.
//
// The key resolver is injectable so tests verify locally-signed tokens without a live Supabase.

import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { Queryable } from '../jobs/pg-rows.js';
import { parseCookies, resolveClientForUser } from './tenant.js';

export const ACCESS_COOKIE = 'sb_access';
export const REFRESH_COOKIE = 'sb_refresh';

export interface SessionUser {
  userId: string;
  email: string | null;
}

export interface VerifyOpts {
  keySet?: JWTVerifyGetKey; // default: Supabase's remote JWKS
  issuer?: string;
  audience?: string;
}

let cachedJwks: JWTVerifyGetKey | undefined;
function supabaseJwks(): JWTVerifyGetKey {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL not set');
  cachedJwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return cachedJwks;
}

/** Verify a Supabase access token and return the user, or throw if invalid/expired. */
export async function verifyAccessToken(token: string, opts: VerifyOpts = {}): Promise<SessionUser> {
  const keySet = opts.keySet ?? supabaseJwks();
  const issuer = opts.issuer ?? (process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/auth/v1` : undefined);
  const { payload } = await jwtVerify(token, keySet, { issuer, audience: opts.audience ?? 'authenticated' });
  return { userId: String(payload.sub ?? ''), email: typeof payload.email === 'string' ? payload.email : null };
}

/** Verify the request's access cookie -> user (no tenant lookup). Null if missing/invalid. */
export async function getUser(req: { headers: { cookie?: string } }, opts: VerifyOpts = {}): Promise<SessionUser | null> {
  const token = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
  if (!token) return null;
  try {
    const u = await verifyAccessToken(token, opts);
    return u.userId ? u : null;
  } catch {
    return null;
  }
}

export interface Session {
  user: SessionUser;
  clientId: string;
}

/** Full authenticated session: valid token AND a tenant membership. Null otherwise. */
export async function getSession(
  req: { headers: { cookie?: string } },
  db: Queryable,
  opts: VerifyOpts = {},
): Promise<Session | null> {
  const user = await getUser(req, opts);
  if (!user) return null;
  const clientId = await resolveClientForUser(db, user.userId);
  return clientId ? { user, clientId } : null;
}
