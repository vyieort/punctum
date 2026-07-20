// Notification core: raise (with dedupe), list/scope, resolve (tenant-scoped), tenant health,
// and admin identification. One pipeline for system alerts AND user reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import {
  raiseNotification, listNotifications, resolveNotification, countOpenForClient, tenantHealth, isAdminEmail,
} from '../src/lib/notifications.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0019_notifications.sql'));
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

test('isAdminEmail reads ADMIN_EMAILS and is case/space tolerant', () => {
  const env = { ADMIN_EMAILS: 'boss@x.com, other@y.com' } as unknown as NodeJS.ProcessEnv;
  assert.equal(isAdminEmail('BOSS@x.com', env), true);
  assert.equal(isAdminEmail('nope@x.com', env), false);
  assert.equal(isAdminEmail(null, env), false);
  assert.equal(isAdminEmail('boss@x.com', {} as NodeJS.ProcessEnv), false); // unset => nobody is admin
});
