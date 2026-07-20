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

export interface ListOpts {
  clientId?: string; // a studio's own notifications
  audience?: Audience;
  includeResolved?: boolean;
  limit?: number;
}

export async function listNotifications(db: Queryable, opts: ListOpts = {}): Promise<Notification[]> {
  const where: string[] = [];
  const params: unknown[] = [];
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

/** Platform admins, by email, from ADMIN_EMAILS (comma-separated). No admin => no /admin access. */
export function isAdminEmail(email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const e = (email ?? '').trim().toLowerCase();
  return Boolean(e) && list.includes(e);
}
