// Email-to-Punctum ingestion: recipient/sender parsing, Postmark adapter, and routing an inbound
// message to a studio (sender-match primary, token-address fallback) + queueing PDF attachments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import {
  parseInboundToken, parsePostmarkInbound, ensureInboundToken, resolveClientBySenderEmail,
  ingestInboundEmail, type IngestOps,
} from '../src/lib/inbound-email.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

test('parseInboundToken handles plain and plus-addressed recipients', () => {
  assert.equal(parseInboundToken('abc123@invoices.punctum.app'), 'abc123');
  assert.equal(parseInboundToken('invoices+abc123@x.com'), 'abc123');
  assert.equal(parseInboundToken('  ABC123@X.COM '), 'abc123');
});

test('parsePostmarkInbound maps sender, recipients, and base64 attachments', () => {
  const m = parsePostmarkInbound({
    FromFull: { Email: 'chari@studio.com' },
    ToFull: [{ Email: 'invoices@punctum.app' }],
    Attachments: [{ Name: 'inv.pdf', ContentType: 'application/pdf', Content: 'QkFTRTY0' }],
  });
  assert.equal(m.sender, 'chari@studio.com');
  assert.deepEqual(m.recipients, ['invoices@punctum.app']);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0]!.contentBase64, 'QkFTRTY0');
});

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0011_client_members.sql'));
  await db.exec(mig('0017_inbound_email_token.sql'));
  await db.exec(`insert into clients (id,name,contact_email) values ('danforth-butchery','Danforth Butchery','owner@danforth.com')`);
  await db.exec(`insert into client_config (client_id, inbound_token) values ('danforth-butchery','tok_abc')`);
  await db.exec(`insert into client_members (user_id, client_id, email) values ('11111111-1111-1111-1111-111111111111','danforth-butchery','chari@studio.com')`);
  return db;
}

function fakeQueue() {
  const calls: Array<{ clientId: string; filename?: string }> = [];
  const ops: IngestOps = {
    queue: async (clientId, input) => { calls.push({ clientId, filename: input.filename }); return { invoiceId: 'inv' + (calls.length) }; },
  };
  return { ops, calls };
}
const pdf = (name: string) => ({ filename: name, contentType: 'application/pdf', contentBase64: 'JVBERi0=' });

test('ensureInboundToken returns the existing token; sender resolves via member + contact email', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  assert.equal(await ensureInboundToken(q, 'danforth-butchery'), 'tok_abc');
  assert.equal(await resolveClientBySenderEmail(q, 'CHARI@studio.com'), 'danforth-butchery'); // member, case-insensitive
  assert.equal(await resolveClientBySenderEmail(q, 'owner@danforth.com'), 'danforth-butchery'); // contact_email
  assert.equal(await resolveClientBySenderEmail(q, 'stranger@nope.com'), null);
});

test('ingestInboundEmail routes by sender and queues each PDF (skips non-PDF)', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, calls } = fakeQueue();
  const r = await ingestInboundEmail(q, {
    sender: 'chari@studio.com',
    recipients: ['invoices@punctum.app'],
    attachments: [pdf('a.pdf'), { filename: 'note.txt', contentType: 'text/plain', contentBase64: 'eA==' }, pdf('b.pdf')],
  }, { ops });
  assert.equal(r.ok, true);
  assert.equal(r.route, 'sender');
  assert.equal(r.clientId, 'danforth-butchery');
  assert.equal(r.queued, 2);
  assert.equal(r.skipped, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.clientId, 'danforth-butchery');
});

test('ingestInboundEmail falls back to the token address when the sender is unknown', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeQueue();
  const r = await ingestInboundEmail(q, {
    sender: 'vendor@bvla.com',
    recipients: ['tok_abc@invoices.punctum.app'],
    attachments: [pdf('a.pdf')],
  }, { ops });
  assert.equal(r.ok, true);
  assert.equal(r.route, 'address');
  assert.equal(r.queued, 1);
});

test('ingestInboundEmail rejects an unknown sender + recipient without queueing', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, calls } = fakeQueue();
  const r = await ingestInboundEmail(q, {
    sender: 'nobody@nowhere.com',
    recipients: ['nope@invoices.punctum.app'],
    attachments: [pdf('a.pdf')],
  }, { ops });
  assert.equal(r.ok, false);
  assert.equal(r.queued, 0);
  assert.equal(calls.length, 0);
});

test('ingestInboundEmail matches the sender but reports no-PDF when there are none', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops } = fakeQueue();
  const r = await ingestInboundEmail(q, {
    sender: 'chari@studio.com',
    recipients: [],
    attachments: [{ filename: 'x.txt', contentType: 'text/plain', contentBase64: 'eA==' }],
  }, { ops });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no PDF attachment');
  assert.equal(r.clientId, 'danforth-butchery');
});
