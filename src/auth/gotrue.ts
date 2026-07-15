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

/** Exchange a refresh token for a fresh session (grant_type=refresh_token). */
export function refreshSession(refreshToken: string, o: GoTrueConfig = {}): Promise<Tokens> {
  return tokenRequest('grant_type=refresh_token', { refresh_token: refreshToken }, o);
}
