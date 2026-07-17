// Email-to-Punctum ingestion (#27). A studio forwards a vendor invoice PDF to its unique inbound
// address (<token>@<domain>); an email provider posts the parsed message to /inbound/email; this
// resolves the token back to a client and queues each PDF attachment for the normal review flow.
//
// The core (ingestInboundEmail) is provider-agnostic — it takes a normalized message. A thin
// per-provider adapter (parsePostmarkInbound) maps the webhook payload onto that shape.

import { randomBytes } from 'node:crypto';
import type { Queryable } from '../jobs/pg-rows.js';
import { queueInvoice } from '../jobs/intake.js';

/** The domain tenant inbound addresses live on. Set once the email provider + MX records are up. */
export function inboundDomain(env: NodeJS.ProcessEnv = process.env): string {
  return env.INBOUND_EMAIL_DOMAIN || 'in.punctum.app'; // placeholder; set once the provider/MX is up
}

export function inboundAddressFor(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${token}@${inboundDomain(env)}`;
}

/** The single shared address clients forward to; routed by sender. Configurable via env. */
export function commonInboundAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.INBOUND_COMMON_ADDRESS || `invoices@${inboundDomain(env)}`;
}

/** Opaque routing token (lowercase hex, safe in an email local part). */
export function genInboundToken(): string {
  return randomBytes(10).toString('hex'); // 20 chars, 80 bits
}

/** Extract the token from a recipient address: `<token>@d` or plus-addressed `inbox+<token>@d`. */
export function parseInboundToken(recipient: string): string {
  const local = String(recipient ?? '').trim().toLowerCase().split('@')[0] ?? '';
  const plus = local.indexOf('+');
  return (plus >= 0 ? local.slice(plus + 1) : local).trim();
}

/** The tenant's inbound token, generating + persisting one if it doesn't have one yet. Idempotent. */
export async function ensureInboundToken(db: Queryable, clientId: string): Promise<string> {
  const existing = await db.query(`select inbound_token from client_config where client_id = $1`, [clientId]);
  const cur = (existing.rows[0] as { inbound_token?: string | null } | undefined)?.inbound_token;
  if (cur) return cur;
  const token = genInboundToken();
  // Upsert so it works even before a client_config row exists; only set when still null.
  await db.query(
    `insert into client_config (client_id, inbound_token) values ($1, $2)
     on conflict (client_id) do update set inbound_token = coalesce(client_config.inbound_token, $2), updated_at = now()`,
    [clientId, token],
  );
  const after = await db.query(`select inbound_token from client_config where client_id = $1`, [clientId]);
  return String((after.rows[0] as { inbound_token: string }).inbound_token);
}

/** Resolve an inbound token back to its client, or null if unknown. */
export async function resolveClientByInboundToken(db: Queryable, token: string): Promise<string | null> {
  if (!token) return null;
  const { rows } = await db.query(`select client_id from client_config where inbound_token = $1`, [token]);
  return rows.length ? String((rows[0] as { client_id: string }).client_id) : null;
}

/** Resolve a SENDER email to the studio it's the registered email for. Checks member emails first,
 *  then the client contact email. Case-insensitive. This is the primary "forward from your account
 *  email to the common address" route. */
export async function resolveClientBySenderEmail(db: Queryable, email: string): Promise<string | null> {
  const e = String(email ?? '').trim().toLowerCase();
  if (!e) return null;
  const m = await db.query(`select client_id from client_members where lower(email) = $1 order by created_at limit 1`, [e]);
  if (m.rows.length) return String((m.rows[0] as { client_id: string }).client_id);
  const c = await db.query(`select id from clients where lower(contact_email) = $1 limit 1`, [e]);
  return c.rows.length ? String((c.rows[0] as { id: string }).id) : null;
}

export interface InboundAttachment {
  filename?: string;
  contentType?: string;
  contentBase64: string;
}

export interface InboundMessage {
  sender?: string; // the From address — primary routing key
  recipients: string[]; // every To/Cc address the provider saw — token-address fallback
  attachments: InboundAttachment[];
}

export interface IngestInboundResult {
  ok: boolean;
  reason?: string;
  clientId?: string;
  route?: 'sender' | 'address'; // how the studio was resolved
  queued: number; // PDFs queued
  skipped: number; // non-PDF attachments ignored
  invoiceIds: string[];
}

const isPdf = (a: InboundAttachment): boolean =>
  /application\/pdf/i.test(a.contentType ?? '') || /\.pdf$/i.test(a.filename ?? '');

export interface IngestOps {
  queue: (clientId: string, input: { pdfBase64: string; filename?: string }) => Promise<{ invoiceId: string }>;
}

/**
 * Route a normalized inbound message to a tenant and queue its PDF attachments. Resolves the client
 * from the FIRST recipient whose token maps to one. Unknown recipient or no PDFs -> ok:false (so the
 * webhook can log/measure), but always a well-formed result.
 */
export async function ingestInboundEmail(
  db: Queryable,
  msg: InboundMessage,
  opts: { ops?: IngestOps } = {},
): Promise<IngestInboundResult> {
  const queue = opts.ops?.queue ?? ((clientId, input) => queueInvoice(db, clientId, input));

  // Primary: match the sender to a registered studio email (forward from your account address to the
  // common inbox). Fallback: a per-client token address in the recipients (for vendor-direct sends).
  let clientId: string | null = msg.sender ? await resolveClientBySenderEmail(db, msg.sender) : null;
  let route: 'sender' | 'address' | undefined = clientId ? 'sender' : undefined;
  if (!clientId) {
    for (const r of msg.recipients ?? []) {
      clientId = await resolveClientByInboundToken(db, parseInboundToken(r));
      if (clientId) {
        route = 'address';
        break;
      }
    }
  }
  if (!clientId) return { ok: false, reason: 'sender not registered to any studio', queued: 0, skipped: 0, invoiceIds: [] };

  const pdfs = (msg.attachments ?? []).filter(isPdf);
  const skipped = (msg.attachments ?? []).length - pdfs.length;
  if (pdfs.length === 0) return { ok: false, reason: 'no PDF attachment', clientId, route, queued: 0, skipped, invoiceIds: [] };

  const invoiceIds: string[] = [];
  for (const a of pdfs) {
    const { invoiceId } = await queue(clientId, { pdfBase64: a.contentBase64, filename: a.filename });
    invoiceIds.push(invoiceId);
  }
  return { ok: true, clientId, route, queued: invoiceIds.length, skipped, invoiceIds };
}

// --- Provider adapters: map a webhook payload -> InboundMessage. Add more as needed. ---

/** Postmark inbound webhook (JSON). ToFull/CcFull carry the addresses; Attachments are base64. */
export function parsePostmarkInbound(body: unknown): InboundMessage {
  const b = (body ?? {}) as Record<string, unknown>;
  const addrs = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String((x as { Email?: unknown })?.Email ?? '')).filter(Boolean) : [];
  const fromFull = b.FromFull as { Email?: unknown } | undefined;
  const sender = String(fromFull?.Email ?? (typeof b.From === 'string' ? b.From : '') ?? '');
  const recipients = [...addrs(b.ToFull), ...addrs(b.CcFull)];
  if (recipients.length === 0 && typeof b.To === 'string') recipients.push(b.To);
  const attachments: InboundAttachment[] = Array.isArray(b.Attachments)
    ? (b.Attachments as Array<Record<string, unknown>>).map((a) => ({
        filename: typeof a.Name === 'string' ? a.Name : undefined,
        contentType: typeof a.ContentType === 'string' ? a.ContentType : undefined,
        contentBase64: String(a.Content ?? ''),
      }))
    : [];
  return { sender, recipients, attachments };
}
