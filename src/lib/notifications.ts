// The notification core: one pipeline for anything that needs a human. System alerts and user
// reports share it — they differ only by `source`. Delivery is in-app for now (studio banner +
// /admin); email becomes a second channel once an outbound provider is picked.

import type { Queryable } from '../jobs/pg-rows.js';

export type Audience = 'client' | 'admin';
export type Severity = 'info' | 'warn' | 'error';
export type Source = 'system' | 'user';

export interface NotificationInput {
  clientId?: string | null; // null => platform-level
  audience?: Audience;
  source?: Source;
  type: string;
  severity?: Severity;
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
  actionUrl?: string;
  /** Suppresses duplicates while an identical notification is still open. */
  dedupeKey?: string;
}

export interface Notification {
  id: string;
  clientId: string | null;
  audience: Audience;
  source: Source;
  type: string;
  severity: Severity;
  title: string;
  detail: string;
  context: Record<string, unknown>;
  actionUrl: string;
  createdAt: string;
  resolvedAt: string | null;
}

function toNotification(r: Record<string, unknown>): Notification {
  const ctx = r.context;
  let context: Record<string, unknown> = {};
  if (ctx && typeof ctx === 'object') context = ctx as Record<string, unknown>;
  else if (typeof ctx === 'string') {
    try {
      context = JSON.parse(ctx) as Record<string, unknown>;
    } catch {
      context = {};
    }
  }
  return {
    id: String(r.id),
    clientId: r.client_id == null ? null : String(r.client_id),
    audience: (String(r.audience ?? 'client') as Audience),
    source: (String(r.source ?? 'system') as Source),
    type: String(r.type ?? ''),
    severity: (String(r.severity ?? 'warn') as Severity),
    title: String(r.title ?? ''),
    detail: r.detail == null ? '' : String(r.detail),
    context,
    actionUrl: r.action_url == null ? '' : String(r.action_url),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
    resolvedAt: r.resolved_at == null ? null : String(r.resolved_at),
  };
}

/**
 * Record something that needs a human. Deduped: if an identical (dedupeKey) notification is already
 * open, this is a no-op and returns created:false — so a failure looping every minute doesn't spam.
 */
export async function raiseNotification(db: Queryable, input: NotificationInput): Promise<{ id: string | null; created: boolean }> {
  const { rows } = await db.query(
    `insert into notifications (client_id, audience, source, type, severity, title, detail, context, action_url, dedupe_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     on conflict do nothing
     returning id`,
    [
      input.clientId ?? null,
      input.audience ?? 'client',
      input.source ?? 'system',
      input.type,
      input.severity ?? 'warn',
      input.title,
      input.detail ?? null,
      JSON.stringify(input.context ?? {}),
      input.actionUrl ?? null,
      input.dedupeKey ?? null,
    ],
  );
  return rows.length ? { id: String((rows[0] as { id: string }).id), created: true } : { id: null, created: false };
}

/**
 * The call site everything else should use: record it, then try to email it. Email failures are
 * swallowed on purpose — a notification that's saved but undelivered is recoverable; a push that
 * crashed because the mail server was down is not. Deduped alerts aren't re-emailed.
 */
export async function raiseAndDeliver(
  db: Queryable,
  input: NotificationInput,
  ops?: DeliverOps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: string | null; created: boolean; delivered: boolean }> {
  const { id, created } = await raiseNotification(db, input);
  if (!created || !id || !ops) return { id, created, delivered: false };
  try {
    const [n] = await listNotifications(db, { includeResolved: true, limit: 1, id });
    if (!n) return { id, created, delivered: false };
    return { id, created, delivered: await deliverNotification(db, n, ops, env) };
  } catch {
    return { id, created, delivered: false }; // stays visible in-app; email can be retried later
  }
}

export interface ListOpts {
  clientId?: string; // a studio's own notifications
  audience?: Audience;
  includeResolved?: boolean;
  limit?: number;
  id?: string; // fetch one
}

export async function listNotifications(db: Queryable, opts: ListOpts = {}): Promise<Notification[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.id) {
    params.push(opts.id);
    where.push(`id = $${params.length}`);
  }
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (opts.audience) {
    params.push(opts.audience);
    where.push(`audience = $${params.length}`);
  }
  if (!opts.includeResolved) where.push('resolved_at is null');
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const { rows } = await db.query(
    `select id, client_id, audience, source, type, severity, title, detail, context, action_url, created_at, resolved_at
       from notifications
      ${where.length ? 'where ' + where.join(' and ') : ''}
      order by created_at desc
      limit $${params.length}`,
    params,
  );
  return rows.map((r) => toNotification(r as Record<string, unknown>));
}

/** Mark handled. Scoped by client when a studio resolves its own, so one tenant can't clear another's. */
export async function resolveNotification(db: Queryable, id: string, clientId?: string): Promise<boolean> {
  const params: unknown[] = [id];
  let scope = '';
  if (clientId) {
    params.push(clientId);
    scope = ` and client_id = $2`;
  }
  const { rows } = await db.query(
    `update notifications set resolved_at = now() where id = $1${scope} and resolved_at is null returning id`,
    params,
  );
  return rows.length > 0;
}

export async function countOpenForClient(db: Queryable, clientId: string): Promise<number> {
  const { rows } = await db.query(
    `select count(*)::int as n from notifications where client_id = $1 and audience = 'client' and resolved_at is null`,
    [clientId],
  );
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Open-notification counts per tenant — the roll-up the admin health page leads with. */
export async function tenantHealth(db: Queryable): Promise<Array<{ clientId: string; name: string; open: number }>> {
  const { rows } = await db.query(
    `select c.id, c.name, count(n.id) filter (where n.resolved_at is null)::int as open
       from clients c
       left join notifications n on n.client_id = c.id
      group by c.id, c.name
      order by open desc, c.name`,
  );
  return rows.map((r) => {
    const x = r as Record<string, unknown>;
    return { clientId: String(x.id), name: String(x.name ?? ''), open: Number(x.open ?? 0) };
  });
}

/** Platform admin addresses from ADMIN_EMAILS (comma-separated). */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Platform admins, by email. No ADMIN_EMAILS => nobody is admin (so /admin stays closed). */
export function isAdminEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = (email ?? '').trim().toLowerCase();
  return Boolean(e) && adminEmails(env).some((a) => a.toLowerCase() === e);
}

// --- Email channel -----------------------------------------------------------------------------

/** Who should hear about this: the studio's notification list, or the platform admins. */
export async function recipientsFor(db: Queryable, n: Notification, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (n.audience === 'admin') return adminEmails(env);
  if (!n.clientId) return [];
  const { rows } = await db.query(`select notification_emails from client_config where client_id = $1`, [n.clientId]);
  const raw = (rows[0] as { notification_emails?: unknown } | undefined)?.notification_emails;
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  // Postgres text[] can come back as a literal '{a,b}' depending on the driver.
  if (typeof raw === 'string') return raw.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '').trim()).filter(Boolean);
  return [];
}

/** Plain-text alert email. Every alert carries the link that actually fixes it. */
export function formatNotificationEmail(n: Notification, baseUrl = ''): { subject: string; text: string } {
  const base = baseUrl.replace(/\/$/, '');
  const lines = [n.title];
  if (n.detail) lines.push('', n.detail);
  if (n.clientId) lines.push('', `Studio: ${n.clientId}`);
  if (n.actionUrl) lines.push('', `Fix it: ${n.actionUrl.startsWith('http') ? n.actionUrl : base + n.actionUrl}`);
  if (Object.keys(n.context).length) lines.push('', `Details: ${JSON.stringify(n.context)}`);
  return { subject: `[Punctum] ${n.title}`, text: lines.join('\n') };
}

export interface DeliverOps {
  send: (msg: { to: string[]; subject: string; text: string }) => Promise<unknown>;
}

/**
 * Email a notification to its audience and stamp delivered_at. Best-effort by design: the caller
 * shouldn't fail (e.g. an invoice push shouldn't break) just because email is down or unconfigured.
 */
export async function deliverNotification(
  db: Queryable,
  n: Notification,
  ops: DeliverOps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const to = await recipientsFor(db, n, env);
  if (to.length === 0) return false;
  const { subject, text } = formatNotificationEmail(n, env.APP_BASE_URL ?? '');
  await ops.send({ to, subject, text });
  await db.query(`update notifications set delivered_at = now() where id = $1`, [n.id]);
  return true;
}
