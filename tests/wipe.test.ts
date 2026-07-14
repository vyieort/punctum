// Sandbox catalog wipe: item filtering, mapping clear, and the production guard. PGlite + fake ops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { Queryable } from '../src/jobs/pg-rows.js';
import { wipeSandboxCatalog, type WipeOps } from '../src/jobs/wipe.js';

const mig = (f: string): string => readFileSync(new URL(`../db/migrations/${f}`, import.meta.url), 'utf8');

async function seeded(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(mig('0001_init.sql'));
  await db.exec(`insert into clients (id,name) values ('RE','Ritual Evolution')`);
  await db.exec(`insert into catalog_mapping (client_id, vendor, vendor_sku, square_item_id, square_variation_id, item_name, variation_name, status)
    values ('RE','BVLA','SKU-1','I1','V1','Ring','Y14K','PENDING'),
           ('RE','BVLA','SKU-2','I2','V2','Ring','R14K','PENDING')`);
  await db.exec(`insert into invoices (id, client_id, vendor, status) values ('00000000-0000-0000-0000-0000000000aa','RE','BVLA','done')`);
  await db.exec(`insert into invoice_lines (invoice_id, line_no, is_product) values ('00000000-0000-0000-0000-0000000000aa', 1, true)`);
  return db;
}

function fakeOps(
  env: string,
  items: Array<{ id?: string; item_data?: { product_type?: string } }>,
): { ops: WipeOps; deleted: string[] } {
  const deleted: string[] = [];
  const ops: WipeOps = {
    env,
    listItems: async () => items,
    deleteItems: async (ids) => {
      deleted.push(...ids);
      return ids.length;
    },
  };
  return { ops, deleted };
}

test('wipe deletes regular items, skips appointment items, clears mappings', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, deleted } = fakeOps('sandbox', [
    { id: 'ITEM_A', item_data: { product_type: 'REGULAR' } },
    { id: 'ITEM_B', item_data: {} }, // no product_type -> treated as regular
    { id: 'SVC', item_data: { product_type: 'APPOINTMENTS_SERVICE' } }, // skipped
  ]);
  const r = await wipeSandboxCatalog(q, 'RE', { ops });
  assert.equal(r.itemsFound, 3);
  assert.equal(r.itemsDeleted, 2);
  assert.deepEqual(deleted.sort(), ['ITEM_A', 'ITEM_B']);
  assert.equal(r.mappingsCleared, 2);
  assert.equal(r.invoicesCleared, 1);

  const left = await db.query<{ n: number }>(`select count(*)::int as n from catalog_mapping where client_id='RE'`);
  assert.equal(left.rows[0]!.n, 0);
  const inv = await db.query<{ n: number }>(`select count(*)::int as n from invoices where client_id='RE'`);
  assert.equal(inv.rows[0]!.n, 0); // queue cleared too
  const lines = await db.query<{ n: number }>(`select count(*)::int as n from invoice_lines`);
  assert.equal(lines.rows[0]!.n, 0); // lines cascaded

  // clearInvoices:false leaves the queue intact
  const db2 = await seeded();
  const { ops: ops2 } = fakeOps('sandbox', []);
  const r2 = await wipeSandboxCatalog(db2 as unknown as Queryable, 'RE', { ops: ops2, clearInvoices: false });
  assert.equal(r2.invoicesCleared, 0);
  const kept = await db2.query<{ n: number }>(`select count(*)::int as n from invoices where client_id='RE'`);
  assert.equal(kept.rows[0]!.n, 1);
});

test('wipe refuses to run against production and touches nothing', async () => {
  const db = await seeded();
  const q = db as unknown as Queryable;
  const { ops, deleted } = fakeOps('production', [{ id: 'ITEM_A' }]);
  await assert.rejects(() => wipeSandboxCatalog(q, 'RE', { ops }), /sandbox-only/);
  assert.equal(deleted.length, 0);
  const left = await db.query<{ n: number }>(`select count(*)::int as n from catalog_mapping where client_id='RE'`);
  assert.equal(left.rows[0]!.n, 2); // mappings untouched
});
