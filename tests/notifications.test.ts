// Notification core: raise (with dedupe), list/scope, resolve (tenant-scoped), tenant health,
// and admin identification. One pipeline for system alerts AND user reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import {
  raiseNotification, listNotifications, resolveNotification, countOpenForClient, tenantHealth, isAdminEmail,
  escalateStaleAlerts,
} from '../src/lib/notifications.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0019_notifications.sql'));
  await db.exec(mig('0021_notification_escalated_at.sql'));
  await db.exec(`insert into clients (id,name) values ('acme','Acme Piercing'),('other','Other Studio')`);
  return db;
}

test('raiseNotification stores an alert with its context and action link', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await raiseNotification(q, {
    clientId: 'acme', type: 'push_failed', severity: 'error', title: 'Square push failed',
    detail: 'INVALID_REQUEST', context: { invoiceId: 'inv-1' }, actionUrl: '/queue',
  });
  assert.equal(r.created, true);
  const [n] = await listNotifications(q, { clientId: 'acme' });
  assert.equal(n!.title, 'Square push failed');
  assert.equal(n!.severity, 'error');
  assert.equal(n!.actionUrl, '/queue');
  assert.deepEqual(n!.context, { invoiceId: 'inv-1' });
  assert.equal(n!.source, 'system');
});

test('dedupe: the same open alert does not pile up, but can fire again once resolved', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const input = { clientId: 'acme', type: 'push_failed', title: 'Square push failed', dedupeKey: 'push_failed:inv-1' };
  assert.equal((await raiseNotification(q, input)).created, true);
  assert.equal((await raiseNotification(q, input)).created, false); // suppressed while open
  assert.equal((await listNotifications(q, { clientId: 'acme' })).length, 1);

  const open = await listNotifications(q, { clientId: 'acme' });
  await resolveNotification(q, open[0]!.id, 'acme');
  assert.equal((await raiseNotification(q, input)).created, true); // resolved -> can recur
  assert.equal(await countOpenForClient(q, 'acme'), 1);
});

test('a studio cannot resolve another studio\'s notification', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await raiseNotification(q, { clientId: 'acme', type: 'x', title: 'Acme problem' });
  const [n] = await listNotifications(q, { clientId: 'acme' });
  assert.equal(await resolveNotification(q, n!.id, 'other'), false); // wrong tenant
  assert.equal(await countOpenForClient(q, 'acme'), 1);
  assert.equal(await resolveNotification(q, n!.id, 'acme'), true); // its own
  assert.equal(await countOpenForClient(q, 'acme'), 0);
});

test('audience separates studio problems from platform problems', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await raiseNotification(q, { clientId: 'acme', audience: 'client', type: 'new_vendor', title: 'New vendor' });
  await raiseNotification(q, { clientId: null, audience: 'admin', type: 'quota', title: 'SerpAPI quota low' });
  assert.equal((await listNotifications(q, { audience: 'client' })).length, 1);
  const admin = await listNotifications(q, { audience: 'admin' });
  assert.equal(admin.length, 1);
  assert.equal(admin[0]!.clientId, null); // platform-level
  assert.equal((await listNotifications(q, {})).length, 2); // admin view sees everything
});

test('user reports ride the same pipeline as system alerts', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await raiseNotification(q, {
    clientId: 'acme', audience: 'admin', source: 'user', type: 'user_report',
    title: 'Prices look wrong', context: { page: '/catalog' },
  });
  const [n] = await listNotifications(q, { audience: 'admin' });
  assert.equal(n!.source, 'user');
  assert.equal(n!.type, 'user_report');
});

test('tenantHealth rolls up open counts per studio, busiest first', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await raiseNotification(q, { clientId: 'acme', type: 'a', title: 'one', dedupeKey: 'a' });
  await raiseNotification(q, { clientId: 'acme', type: 'b', title: 'two', dedupeKey: 'b' });
  const health = await tenantHealth(q);
  assert.equal(health[0]!.clientId, 'acme');
  assert.equal(health[0]!.open, 2);
  assert.equal(health.find((h) => h.clientId === 'other')!.open, 0);
});

test('escalateStaleAlerts re-raises a stale client alert to admin, exactly once', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  // one stale (8h old) and one fresh (1h old), both open client push_failed
  await db.query(
    `insert into notifications (client_id, audience, source, type, severity, title, detail, context, action_url, created_at) values
      ('acme','client','system','push_failed','error','Old fail','boom','{"invoiceId":"inv-old"}'::jsonb,'/invoices/inv-old/review', now() - interval '8 hours'),
      ('acme','client','system','push_failed','error','New fail','boom','{"invoiceId":"inv-new"}'::jsonb,'/invoices/inv-new/review', now() - interval '1 hour')`,
  );
  const sends: Array<{ to: string[]; subject: string; text: string }> = [];
  const ops = { send: async (m: { to: string[]; subject: string; text: string }) => { sends.push(m); return {}; } };
  const env = { ADMIN_EMAILS: 'admin@punctum.app' } as unknown as NodeJS.ProcessEnv;

  const r1 = await escalateStaleAlerts(q, ops, { olderThanMs: 6 * 3600 * 1000 }, env);
  assert.equal(r1.escalated.length, 1); // only the stale one crossed the window

  const adminAlerts = await listNotifications(q, { audience: 'admin' });
  assert.equal(adminAlerts.length, 1);
  assert.equal(adminAlerts[0]!.type, 'escalated_push_failed');
  assert.match(adminAlerts[0]!.actionUrl, /inv-old/);
  assert.ok(sends.some((s) => s.to.includes('admin@punctum.app')), 'admin was emailed');

  // idempotent: the original is stamped escalated_at, so a second sweep does nothing
  const r2 = await escalateStaleAlerts(q, ops, { olderThanMs: 6 * 3600 * 1000 }, env);
  assert.equal(r2.escalated.length, 0);
  assert.equal((await listNotifications(q, { audience: 'admin' })).length, 1);
});

test('escalateStaleAlerts ignores resolved alerts and non-escalatable types', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.query(
    `insert into notifications (client_id, audience, source, type, severity, title, context, created_at, resolved_at) values
      ('acme','client','system','push_failed','error','Already handled','{}'::jsonb, now() - interval '2 days', now())`,
  );
  await db.query(
    `insert into notifications (client_id, audience, source, type, severity, title, context, created_at) values
      ('acme','client','system','new_vendor','info','A new vendor','{}'::jsonb, now() - interval '2 days')`,
  );
  const r = await escalateStaleAlerts(q, undefined, { olderThanMs: 6 * 3600 * 1000 });
  assert.equal(r.escalated.length, 0);
  assert.equal((await listNotifications(q, { audience: 'admin' })).length, 0);
});

test('isAdminEmail reads ADMIN_EMAILS and is case/space tolerant', () => {
  const env = { ADMIN_EMAILS: 'boss@x.com, other@y.com' } as unknown as NodeJS.ProcessEnv;
  assert.equal(isAdminEmail('BOSS@x.com', env), true);
  assert.equal(isAdminEmail('nope@x.com', env), false);
  assert.equal(isAdminEmail(null, env), false);
  assert.equal(isAdminEmail('boss@x.com', {} as NodeJS.ProcessEnv), false); // unset => nobody is admin
});
