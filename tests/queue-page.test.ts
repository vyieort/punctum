// Review queue page: row loading + render (Review link, conditional auto-refresh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getQueueRows, renderQueuePage, bulkApproveInvoices } from '../src/review/queue.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(mig('0006_status_queued.sql'));
  await db.exec(mig('0007_status_processing.sql'));
  await db.exec(mig('0008_invoice_queue_cols.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  return db;
}

test('getQueueRows returns invoices with line counts', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (client_id, vendor, invoice_number, status, filename) values
    ('RE','BVLA','INV-1','in_review','bvla.pdf'),
    ('RE',null,null,'queued','anato.pdf')`);
  const inv = (await db.query<{ id: string }>(`select id from invoices where invoice_number='INV-1'`)).rows[0]!.id;
  await db.query(`insert into invoice_lines (invoice_id, line_no, is_product) values ($1, 1, true)`, [inv]);

  const rows = await getQueueRows(db as unknown as Queryable, 'RE');
  assert.equal(rows.length, 2);
  const ready = rows.find((r) => r.status === 'in_review')!;
  assert.equal(ready.vendor, 'BVLA');
  assert.equal(ready.lineCount, '1');
});

test('renderQueuePage: Review link when ready, auto-refresh while items are queued', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (client_id, vendor, invoice_number, status, filename) values
    ('RE','BVLA','INV-1','in_review','bvla.pdf'),
    ('RE',null,null,'queued','anato.pdf')`);
  const html = renderQueuePage(await getQueueRows(db as unknown as Queryable, 'RE'));
  assert.match(html, /\/review">Review/); // ready row gets a Review link
  assert.match(html, /http-equiv="refresh"/); // still working -> refresh on
  assert.match(html, /Queued/);
  assert.match(html, /Ready to review/);
});

test('no auto-refresh once nothing is queued or processing', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (client_id, vendor, invoice_number, status) values ('RE','BVLA','INV-1','done')`);
  const html = renderQueuePage(await getQueueRows(db as unknown as Queryable, 'RE'));
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test('renderQueuePage shows bulk-approve controls + checkboxes only on in_review rows', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (client_id, vendor, invoice_number, status) values
    ('RE','BVLA','R1','in_review'), ('RE','NEO','D1','done')`);
  const html = renderQueuePage(await getQueueRows(db as unknown as Queryable, 'RE'));
  assert.match(html, /id="approvebtn"/); // bulk approve button present (there's an in_review row)
  assert.equal((html.match(/class="qchk"/g) ?? []).length, 1); // only the in_review row is selectable
});

test("bulkApproveInvoices flips only this tenant's in_review invoices to importing", async () => {
  const db = await seeded();
  await db.exec(`insert into clients (id,name) values ('CX','Client X')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000a1','RE','BVLA','in_review'),
    ('00000000-0000-0000-0000-0000000000a2','RE','NEO','done'),
    ('00000000-0000-0000-0000-0000000000a3','CX','BVLA','in_review')`);
  const r = await bulkApproveInvoices(db as unknown as Queryable, 'RE', [
    '00000000-0000-0000-0000-0000000000a1', // RE in_review -> approved
    '00000000-0000-0000-0000-0000000000a2', // RE done -> skipped
    '00000000-0000-0000-0000-0000000000a3', // CX (other tenant) -> skipped
    'not-a-uuid', // malformed -> skipped, not thrown
  ]);
  assert.deepEqual(r.approvedIds, ['00000000-0000-0000-0000-0000000000a1']);
  assert.equal(r.skipped, 3);
  const st = (await db.query<{ status: string }>(`select status from invoices where id='00000000-0000-0000-0000-0000000000a1'`)).rows[0]!.status;
  assert.equal(st, 'importing');
  const cx = (await db.query<{ status: string }>(`select status from invoices where id='00000000-0000-0000-0000-0000000000a3'`)).rows[0]!.status;
  assert.equal(cx, 'in_review'); // other tenant untouched
});
