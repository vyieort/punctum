// Supabase session verification (asymmetric, local keypair) + GoTrue login (mocked fetch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { verifyAccessToken } from '../src/auth/session.js';
import { passwordLogin, refreshSession } from '../src/auth/gotrue.js';

const ISS = 'https://proj.supabase.co/auth/v1';

async function signToken(over: { sub?: string; email?: string; iss?: string; aud?: string; expSecFromNow?: number } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwt = new SignJWT({ email: over.email ?? 'owner@studio.co' })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(over.sub ?? 'user-123')
    .setIssuer(over.iss ?? ISS)
    .setAudience(over.aud ?? 'authenticated')
    .setExpirationTime(over.expSecFromNow != null ? Math.floor(Date.now() / 1000) + over.expSecFromNow : '1h');
  const token = await jwt.sign(privateKey);
  const keySet: JWTVerifyGetKey = async () => publicKey;
  return { token, keySet };
}

test('verifyAccessToken accepts a valid token and extracts the user', async () => {
  const { token, keySet } = await signToken({ sub: 'abc', email: 'a@b.co' });
  const u = await verifyAccessToken(token, { keySet, issuer: ISS });
  assert.equal(u.userId, 'abc');
  assert.equal(u.email, 'a@b.co');
});

test('verifyAccessToken rejects an expired token', async () => {
  const { token, keySet } = await signToken({ expSecFromNow: -30 });
  await assert.rejects(() => verifyAccessToken(token, { keySet, issuer: ISS }));
});

test('verifyAccessToken rejects a wrong-issuer token', async () => {
  const { token, keySet } = await signToken({ iss: 'https://evil.example/auth/v1' });
  await assert.rejects(() => verifyAccessToken(token, { keySet, issuer: ISS }));
});

test('verifyAccessToken rejects a token signed by a different key', async () => {
  const { token } = await signToken();
  const other = await generateKeyPair('ES256');
  const keySet: JWTVerifyGetKey = async () => other.publicKey;
  await assert.rejects(() => verifyAccessToken(token, { keySet, issuer: ISS }));
});

const mockFetch = (status: number, body: unknown, capture?: (u: string) => void) =>
  (async (u: string) => {
    capture?.(u);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof globalThis.fetch;

test('passwordLogin posts the password grant and returns tokens', async () => {
  let seenUrl = '';
  const t = await passwordLogin('a@b.co', 'pw', {
    url: 'https://proj.supabase.co',
    anonKey: 'anon',
    fetchImpl: mockFetch(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }, (u) => (seenUrl = u)),
  });
  assert.equal(t.accessToken, 'AT');
  assert.equal(t.refreshToken, 'RT');
  assert.equal(t.expiresIn, 3600);
  assert.match(seenUrl, /grant_type=password/);
});

test('passwordLogin surfaces the Supabase error message', async () => {
  await assert.rejects(
    () => passwordLogin('a@b.co', 'bad', { url: 'https://p.co', anonKey: 'k', fetchImpl: mockFetch(400, { error_description: 'Invalid login credentials' }) }),
    /Invalid login credentials/,
  );
});

test('refreshSession uses the refresh_token grant', async () => {
  let seenUrl = '';
  const t = await refreshSession('RT', {
    url: 'https://p.co',
    anonKey: 'k',
    fetchImpl: mockFetch(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }, (u) => (seenUrl = u)),
  });
  assert.equal(t.accessToken, 'AT2');
  assert.match(seenUrl, /grant_type=refresh_token/);
});
