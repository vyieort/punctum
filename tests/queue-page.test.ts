// Review queue page: row loading + render (Review link, conditional auto-refresh).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getQueueRows, renderQueuePage } from '../src/review/queue.js';

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
