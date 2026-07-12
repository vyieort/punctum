// Review page tests against real Postgres via PGlite: read → render → edit → approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { getInvoiceForReview } from '../src/review/store.js';
import { renderReviewPage } from '../src/review/render.js';
import { handleReview } from '../src/review/handler.js';

const schema = readFileSync(new URL('../db/migrations/0001_init.sql', import.meta.url), 'utf8');
const INV = '00000000-0000-0000-0000-000000000001';

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(schema);
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into invoices (id, client_id, vendor, invoice_number, invoice_date, total, status)
    values ('${INV}','RE','BVLA','INV-DEMO-001','2026-07-11',412.50,'in_review')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, description, quantity, wholesale, gems, notes, is_product)
    values ('${INV}',1,'18G Muse Seam Ring',1,147.50,'1.5mm White CZ (1)','Orientation: Conch;',true),
           ('${INV}',2,'Shipping',1,12.00,'','',false)`);
  return db;
}

test('getInvoiceForReview returns the invoice and its lines in order', async () => {
  const db = await seeded();
  const data = await getInvoiceForReview(db as unknown as Queryable, INV);
  assert.ok(data);
  assert.equal(data!.invoice.vendor, 'BVLA');
  assert.equal(data!.lines.length, 2);
  assert.equal(data!.lines[0].description, '18G Muse Seam Ring');
  assert.equal(data!.lines[1].is_product, false);
});

test('renderReviewPage shows the lines and an approve action', async () => {
  const db = await seeded();
  const data = await getInvoiceForReview(db as unknown as Queryable, INV);
  const out = renderReviewPage(data!);
  assert.match(out, /18G Muse Seam Ring/);
  assert.match(out, /\/invoices\/[^/]+\/approve/);
  assert.match(out, /Approve invoice/);
});

test('handleReview: GET renders, POST save persists edits, POST approve flips status', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const l0 = (await getInvoiceForReview(q, INV))!.lines[0].id;

  const get = await handleReview(q, 'GET', INV, 'review', '');
  assert.equal(get.status, 200);
  assert.match(get.body, /Muse Seam Ring/);

  const form = `description_${l0}=Edited%20Name&quantity_${l0}=3&wholesale_${l0}=150&gems_${l0}=&notes_${l0}=&sku_${l0}=X1&is_product_${l0}=on`;
  const save = await handleReview(q, 'POST', INV, 'save', form);
  assert.equal(save.status, 303);
  const afterSave = await getInvoiceForReview(q, INV);
  const edited = afterSave!.lines.find((l) => l.id === l0)!;
  assert.equal(edited.description, 'Edited Name');
  assert.equal(edited.quantity, '3');
  assert.equal(edited.synthetic_sku, 'X1');
  assert.equal(edited.review_status, 'edited');
  // the other line was NOT in the form, so it must be untouched
  assert.equal(afterSave!.lines.find((l) => l.id !== l0)!.description, 'Shipping');

  const appr = await handleReview(q, 'POST', INV, 'approve', form);
  assert.equal(appr.status, 303);
  assert.equal((await getInvoiceForReview(q, INV))!.invoice.status, 'approved');

  const missing = await handleReview(q, 'GET', '11111111-1111-1111-1111-111111111111', 'review', '');
  assert.equal(missing.status, 404);
});
