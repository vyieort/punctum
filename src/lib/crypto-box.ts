// Symmetric encryption for secrets at rest (per-client Square OAuth tokens). AES-256-GCM with a
// key from TOKEN_ENC_KEY (64-hex = raw 32 bytes, else any string is SHA-256'd to 32 bytes). Output
// is base64(iv[12] ‖ tag[16] ‖ ciphertext). The key is injectable so it's unit-testable.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export function encKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const k = env.TOKEN_ENC_KEY;
  if (!k) throw new Error('TOKEN_ENC_KEY is not set');
  return /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, 'hex') : createHash('sha256').update(k).digest();
}

export function encryptSecret(plaintext: string, key: Buffer = encKeyFromEnv()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(b64: string, key: Buffer = encKeyFromEnv()): string {
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
