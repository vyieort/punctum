// Failed inbound emails: admin alert + sender bounce (both best-effort, deduped alert).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import type { InboundMessage, IngestInboundResult } from '../src/lib/inbound-email.js';
import { notifyInboundFailure, isBounceableSender } from '../src/lib/inbound-followup.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0019_notifications.sql'));
  return db;
}

const ENV = { ADMIN_EMAILS: 'admin@punctum.app' } as unknown as NodeJS.ProcessEnv;

function recorder(): { ops: { send: (m: { to: string[]; subject: string; text: string }) => Promise<unknown> }; sends: Array<{ to: string[]; subject: string; text: string }> } {
  const sends: Array<{ to: string[]; subject: string; text: string }> = [];
  return { sends, ops: { send: async (m) => { sends.push(m); return {}; } } };
}

const pdfMsg: InboundMessage = {
  sender: 'vendor@acme.com',
  recipients: ['invoices@in.getpunctum.com'],
  attachments: [{ filename: 'inv.pdf', contentType: 'application/pdf', contentBase64: 'x' }],
};

test('unroutable email raises an admin alert AND bounces the sender', async () => {
  const db = await seeded();
  const { ops, sends } = recorder();
  const result: IngestInboundResult = { ok: false, reason: 'sender not registered to any studio', queued: 0, skipped: 0, invoiceIds: [] };

  const out = await notifyInboundFailure(db as unknown as Queryable, pdfMsg, result, ops, ENV);
  assert.deepEqual(out, { alerted: true, bounced: true });

  const rows = (await db.query<{ type: string; audience: string }>(`select type, audience from notifications`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.type, 'inbound_unrouted');
  assert.equal(rows[0]!.audience, 'admin');

  const bounce = sends.find((s) => s.to.includes('vendor@acme.com'));
  assert.ok(bounce, 'sender got a bounce');
  assert.match(bounce!.subject, /couldn't process/i);
  assert.ok(sends.some((s) => s.to.includes('admin@punctum.app')), 'admin got the alert email');
});

test('registered sender with no PDF: no-PDF alert + a resend-with-PDF bounce', async () => {
  const db = await seeded();
  const { ops, sends } = recorder();
  const msg: InboundMessage = { ...pdfMsg, attachments: [{ filename: 'note.txt', contentType: 'text/plain', contentBase64: 'x' }] };
  const result: IngestInboundResult = { ok: false, reason: 'no PDF attachment', clientId: 'RE', route: 'sender', queued: 0, skipped: 1, invoiceIds: [] };

  const out = await notifyInboundFailure(db as unknown as Queryable, msg, result, ops, ENV);
  assert.deepEqual(out, { alerted: true, bounced: true });

  const type = (await db.query<{ type: string }>(`select type from notifications`)).rows[0]!.type;
  assert.equal(type, 'inbound_no_pdf');
  const bounce = sends.find((s) => s.to.includes('vendor@acme.com'));
  assert.match(bounce!.subject, /find an invoice pdf/i);
});

test('automated sender (mailer-daemon) is alerted but NOT bounced (no mail loop)', async () => {
  const db = await seeded();
  const { ops, sends } = recorder();
  const msg: InboundMessage = { ...pdfMsg, sender: 'mailer-daemon@acme.com' };
  const result: IngestInboundResult = { ok: false, reason: 'sender not registered to any studio', queued: 0, skipped: 0, invoiceIds: [] };

  const out = await notifyInboundFailure(db as unknown as Queryable, msg, result, ops, ENV);
  assert.equal(out.alerted, true);
  assert.equal(out.bounced, false);
  assert.ok(!sends.some((s) => s.to.includes('mailer-daemon@acme.com')));
});

test('a successful ingest is a no-op (no alert, no bounce)', async () => {
  const db = await seeded();
  const { ops, sends } = recorder();
  const result: IngestInboundResult = { ok: true, clientId: 'RE', route: 'sender', queued: 1, skipped: 0, invoiceIds: ['x'] };

  const out = await notifyInboundFailure(db as unknown as Queryable, pdfMsg, result, ops, ENV);
  assert.deepEqual(out, { alerted: false, bounced: false });
  assert.equal(sends.length, 0);
  assert.equal((await db.query(`select id from notifications`)).rows.length, 0);
});

test('a repeat forwarder is deduped: one admin alert, but bounced each time', async () => {
  const db = await seeded();
  const { ops } = recorder();
  const result: IngestInboundResult = { ok: false, reason: 'sender not registered to any studio', queued: 0, skipped: 0, invoiceIds: [] };

  const first = await notifyInboundFailure(db as unknown as Queryable, pdfMsg, result, ops, ENV);
  const second = await notifyInboundFailure(db as unknown as Queryable, pdfMsg, result, ops, ENV);
  assert.equal(first.alerted, true);
  assert.equal(second.alerted, false); // deduped while the first is still open
  assert.equal(second.bounced, true); // but the sender still hears back
  assert.equal((await db.query(`select id from notifications`)).rows.length, 1);
});

test('isBounceableSender rejects empty, malformed, and automated addresses', () => {
  assert.equal(isBounceableSender('vendor@acme.com'), true);
  assert.equal(isBounceableSender('noreply@acme.com'), false);
  assert.equal(isBounceableSender('no-reply+tag@acme.com'), false);
  assert.equal(isBounceableSender('postmaster@acme.com'), false);
  assert.equal(isBounceableSender(''), false);
  assert.equal(isBounceableSender('not-an-email'), false);
});
