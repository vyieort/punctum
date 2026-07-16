// Supabase GoTrue calls for server-side login. The app is server-rendered, so we exchange
// credentials for tokens here (not in the browser): POST /auth/v1/token. The signing mode
// (asymmetric) only affects verification (session.ts), not obtaining tokens. fetch is injectable
// for tests.

type FetchImpl = typeof globalThis.fetch;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface GoTrueConfig {
  url?: string;
  anonKey?: string;
  fetchImpl?: FetchImpl;
}

function resolve(o: GoTrueConfig): { url: string; anon: string; doFetch: FetchImpl } {
  const url = o.url ?? process.env.SUPABASE_URL;
  const anon = o.anonKey ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
  return { url, anon, doFetch: o.fetchImpl ?? globalThis.fetch };
}

async function tokenRequest(query: string, body: unknown, o: GoTrueConfig): Promise<Tokens> {
  const { url, anon, doFetch } = resolve(o);
  const res = await doFetch(`${url}/auth/v1/token?${query}`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = j.error_description ?? j.msg ?? j.error ?? `auth failed (${res.status})`;
    throw new Error(String(msg));
  }
  return {
    accessToken: String(j.access_token ?? ''),
    refreshToken: String(j.refresh_token ?? ''),
    expiresIn: Number(j.expires_in ?? 3600),
  };
}

/** Exchange email + password for a session (grant_type=password). */
export function passwordLogin(email: string, password: string, o: GoTrueConfig = {}): Promise<Tokens> {
  return tokenRequest('grant_type=password', { email, password }, o);
}

export interface SignUpResult {
  userId: string;
  email: string | null;
  /** A session when the project auto-confirms signups; null when email confirmation is required. */
  tokens: Tokens | null;
}

/** Create a Supabase auth user (POST /auth/v1/signup). Returns tokens when the project auto-confirms,
 *  otherwise tokens=null and the user must confirm via email before logging in. */
export async function signUp(email: string, password: string, o: GoTrueConfig = {}): Promise<SignUpResult> {
  const { url, anon, doFetch } = resolve(o);
  const res = await doFetch(`${url}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = j.error_description ?? j.msg ?? j.error ?? `sign up failed (${res.status})`;
    throw new Error(String(msg));
  }
  // Two response shapes: a Session { access_token, refresh_token, user:{...} } when auto-confirmed,
  // or a bare User { id, email, ... } when email confirmation is on.
  const user = (j.user ?? j) as Record<string, unknown>;
  const tokens = j.access_token
    ? {
        accessToken: String(j.access_token),
        refreshToken: String(j.refresh_token ?? ''),
        expiresIn: Number(j.expires_in ?? 3600),
      }
    : null;
  return {
    userId: String(user.id ?? ''),
    email: typeof user.email === 'string' ? user.email : null,
    tokens,
  };
}

/** Exchange a refresh token for a fresh session (grant_type=refresh_token). */
export function refreshSession(refreshToken: string, o: GoTrueConfig = {}): Promise<Tokens> {
  return tokenRequest('grant_type=refresh_token', { refresh_token: refreshToken }, o);
}
