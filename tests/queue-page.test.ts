// Review queue page: row loading + render (Review link, conditional auto-refresh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getQueueRows, renderQueuePage, bulkApproveInvoices, deleteQueuedInvoice, bulkDeleteInvoices } from '../src/review/queue.js';

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

test('deleteQueuedInvoice removes an un-pushed invoice and cascades its lines', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000b1','RE','BVLA','in_review')`);
  await db.query(`insert into invoice_lines (invoice_id, line_no, is_product) values ($1, 1, true)`, ['00000000-0000-0000-0000-0000000000b1']);

  const r = await deleteQueuedInvoice(db as unknown as Queryable, 'RE', '00000000-0000-0000-0000-0000000000b1');
  assert.deepEqual(r, { deleted: true });
  const gone = (await db.query(`select id from invoices where id='00000000-0000-0000-0000-0000000000b1'`)).rows.length;
  assert.equal(gone, 0);
  const lines = (await db.query(`select id from invoice_lines where invoice_id='00000000-0000-0000-0000-0000000000b1'`)).rows.length;
  assert.equal(lines, 0); // cascaded
});

test('deleteQueuedInvoice refuses mid-push and already-pushed invoices, and is tenant-scoped', async () => {
  const db = await seeded();
  await db.exec(`insert into clients (id,name) values ('CX','Client X')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000c1','RE','BVLA','importing'),
    ('00000000-0000-0000-0000-0000000000c2','RE','NEO','done'),
    ('00000000-0000-0000-0000-0000000000c3','CX','BVLA','in_review')`);

  const pushing = await deleteQueuedInvoice(db as unknown as Queryable, 'RE', '00000000-0000-0000-0000-0000000000c1');
  assert.equal(pushing.deleted, false);
  assert.match(pushing.reason!, /pushing/);

  const pushed = await deleteQueuedInvoice(db as unknown as Queryable, 'RE', '00000000-0000-0000-0000-0000000000c2');
  assert.equal(pushed.deleted, false);
  assert.match(pushed.reason!, /already pushed/);

  const otherTenant = await deleteQueuedInvoice(db as unknown as Queryable, 'RE', '00000000-0000-0000-0000-0000000000c3');
  assert.deepEqual(otherTenant, { deleted: false, reason: 'not found' }); // can't see another tenant's row

  // all three survive
  const n = (await db.query(`select id from invoices`)).rows.length;
  assert.equal(n, 3);
});

test('renderQueuePage: a checkbox on every deletable row + a Delete-selected toolbar button', async () => {
  const db = await seeded();
  await db.exec(`insert into invoices (client_id, vendor, invoice_number, status) values
    ('RE','BVLA','R1','in_review'), ('RE','ERR','E1','error'), ('RE','NEO','I1','importing'), ('RE','ANA','D1','done')`);
  const html = renderQueuePage(await getQueueRows(db as unknown as Queryable, 'RE'));
  // in_review + error are deletable (2); importing + done are not.
  assert.equal((html.match(/class="qchk"/g) ?? []).length, 2);
  assert.match(html, /id="deletebtn"/); // toolbar Delete-selected button present
  assert.match(html, /data-status="error"/); // error rows are now selectable (for delete)
  assert.doesNotMatch(html, /class="del"/); // no per-row delete buttons anymore
});

test('bulkDeleteInvoices deletes the deletable ids and skips mid-push/done/other-tenant', async () => {
  const db = await seeded();
  await db.exec(`insert into clients (id,name) values ('CX','Client X')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values
    ('00000000-0000-0000-0000-0000000000d1','RE','BVLA','in_review'),
    ('00000000-0000-0000-0000-0000000000d2','RE','ERR','error'),
    ('00000000-0000-0000-0000-0000000000d3','RE','NEO','importing'),
    ('00000000-0000-0000-0000-0000000000d4','CX','ANA','in_review')`);
  const r = await bulkDeleteInvoices(db as unknown as Queryable, 'RE', [
    '00000000-0000-0000-0000-0000000000d1', // RE in_review -> deleted
    '00000000-0000-0000-0000-0000000000d2', // RE error -> deleted
    '00000000-0000-0000-0000-0000000000d3', // RE importing -> skipped
    '00000000-0000-0000-0000-0000000000d4', // other tenant -> skipped
  ]);
  assert.deepEqual(r.deletedIds.sort(), ['00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2']);
  assert.equal(r.skipped, 2);
  const left = (await db.query(`select id from invoices order by id`)).rows.length;
  assert.equal(left, 2); // the importing RE row + the CX row survive
});
