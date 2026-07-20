// Postmark outbound + the notification email channel. Injected fetch/send — never hits the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { sendEmail, isMailerConfigured } from '../src/lib/mailer.js';
import {
  raiseNotification, raiseAndDeliver, listNotifications, recipientsFor, formatNotificationEmail,
} from '../src/lib/notifications.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

function captureFetch() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as { headers: Record<string, string>; body: string };
    calls.push({ url: String(url), headers: i.headers, body: JSON.parse(i.body) });
    return { ok: true, status: 200, json: async () => ({ MessageID: 'msg-1' }) };
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const CFG = { token: 'tok', from: 'alerts@punctum.app', replyTo: 'support@punctum.app' };

test('sendEmail posts to Postmark with the token header, stream, and reply-to', async () => {
  const { calls, fetchImpl } = captureFetch();
  const r = await sendEmail({ to: ['a@b.co', 'c@d.co'], subject: 'Hi', text: 'Body' }, { ...CFG, fetchImpl });
  assert.equal(r.messageId, 'msg-1');
  const c = calls[0]!;
  assert.equal(c.url, 'https://api.postmarkapp.com/email');
  assert.equal(c.headers['X-Postmark-Server-Token'], 'tok');
  assert.equal(c.body.To, 'a@b.co, c@d.co');
  assert.equal(c.body.From, 'alerts@punctum.app');
  assert.equal(c.body.ReplyTo, 'support@punctum.app'); // replies reach a human
  assert.equal(c.body.MessageStream, 'outbound');
});

test('sendEmail surfaces a Postmark error message', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 422, json: async () => ({ Message: 'Sender signature not confirmed' }) })) as unknown as typeof globalThis.fetch;
  await assert.rejects(sendEmail({ to: 'a@b.co', subject: 's', text: 't' }, { ...CFG, fetchImpl }), /Sender signature not confirmed/);
});

test('isMailerConfigured gates on token + from', () => {
  assert.equal(isMailerConfigured({ POSTMARK_SERVER_TOKEN: 't', ALERT_FROM_EMAIL: 'a@b.co' } as NodeJS.ProcessEnv), true);
  assert.equal(isMailerConfigured({ POSTMARK_SERVER_TOKEN: 't' } as NodeJS.ProcessEnv), false);
  assert.equal(isMailerConfigured({} as NodeJS.ProcessEnv), false);
});

test('formatNotificationEmail carries the fix-it link, absolute', () => {
  const n = {
    id: 'i', clientId: 'acme', audience: 'client' as const, source: 'system' as const, type: 'push_failed',
    severity: 'error' as const, title: 'Square push failed', detail: 'INVALID_REQUEST',
    context: { invoiceId: 'inv-1' }, actionUrl: '/queue', createdAt: '', resolvedAt: null,
  };
  const { subject, text } = formatNotificationEmail(n, 'https://app.example.com/');
  assert.equal(subject, '[Punctum] Square push failed');
  assert.match(text, /https:\/\/app\.example\.com\/queue/);
  assert.match(text, /INVALID_REQUEST/);
  assert.match(text, /inv-1/);
});

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0019_notifications.sql'));
  await db.exec(`insert into clients (id,name) values ('acme','Acme')`);
  await db.exec(`insert into client_config (client_id, notification_emails) values ('acme', '{owner@acme.co}')`);
  return db;
}

test('recipients: studio alerts go to the studio, admin alerts to ADMIN_EMAILS', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const base = { id: 'x', source: 'system' as const, type: 't', severity: 'warn' as const, title: 'T', detail: '', context: {}, actionUrl: '', createdAt: '', resolvedAt: null };
  const env = { ADMIN_EMAILS: 'boss@punctum.app' } as NodeJS.ProcessEnv;
  assert.deepEqual(await recipientsFor(q, { ...base, clientId: 'acme', audience: 'client' }, env), ['owner@acme.co']);
  assert.deepEqual(await recipientsFor(q, { ...base, clientId: null, audience: 'admin' }, env), ['boss@punctum.app']);
});

test('raiseAndDeliver emails a new alert, and does NOT re-email a deduped one', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const sent: Array<{ to: string[]; subject: string }> = [];
  const ops = { send: async (m: { to: string[]; subject: string; text: string }) => { sent.push(m); } };
  const input = { clientId: 'acme', type: 'push_failed', title: 'Square push failed', actionUrl: '/queue', dedupeKey: 'k1' };

  const first = await raiseAndDeliver(q, input, ops);
  assert.equal(first.created, true);
  assert.equal(first.delivered, true);
  assert.deepEqual(sent[0]!.to, ['owner@acme.co']);

  const second = await raiseAndDeliver(q, input, ops); // deduped while open
  assert.equal(second.created, false);
  assert.equal(second.delivered, false);
  assert.equal(sent.length, 1); // no second email

  const [n] = await listNotifications(q, { clientId: 'acme' });
  assert.ok(n);
});

test('a failing mailer never breaks the caller — the alert still records', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const ops = { send: async () => { throw new Error('Postmark down'); } };
  const r = await raiseAndDeliver(q, { clientId: 'acme', type: 'stuck', title: 'Invoice stuck' }, ops);
  assert.equal(r.created, true);
  assert.equal(r.delivered, false); // swallowed
  assert.equal((await listNotifications(q, { clientId: 'acme' })).length, 1);
});

test('no recipients configured -> records in-app, reports undelivered', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  await db.exec(`insert into clients (id,name) values ('nomail','No Mail')`);
  const ops = { send: async () => {} };
  const r = await raiseAndDeliver(q, { clientId: 'nomail', type: 'x', title: 'Y' }, ops);
  assert.equal(r.created, true);
  assert.equal(r.delivered, false);
});

test('raiseNotification alone never sends email', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const r = await raiseNotification(q, { clientId: 'acme', type: 'quiet', title: 'No email' });
  assert.equal(r.created, true);
});
