// Batch item editing + the learning loop.
//
// applyEdits takes the grid's per-row changes, pushes each changed field to Square, logs every
// change to catalog_edits (the correction signal), and updates catalog_mapping. Edits are pushed
// with a get-modify-upsert: we fetch the live object, change only the edited field, and upsert the
// whole thing back — so image_ids, variations, and everything else are preserved untouched (the
// never-overwrite-images rule holds for free). Rows are processed sequentially with a fresh fetch
// each time, so two variations of one item can be edited without a version conflict.
//
// The point of the log is that recurring corrections (same vendor, same category move) reveal an
// import rule that should be fixed at the source — see getEditPatterns.

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../jobs/pg-rows.js';
import { squareConfigFromEnv, getCatalogObject, upsertCatalogObject, type SquareConfig } from '../lib/square-client.js';
import { loadCategoryMap } from '../jobs/import-preview.js';

export interface RowEdit {
  seq: string;
  retailPrice?: string; // dollars, as typed
  categoryPath?: string;
  itemName?: string; // base name (no tag suffix)
  description?: string;
}

export interface EditPushOps {
  getObject(id: string): Promise<any>;
  upsert(body: unknown): Promise<any>;
}

export interface ApplyEditsResult {
  rowsChanged: number;
  fieldsChanged: number;
  pushed: number; // Square upserts issued
  errors: Array<{ seq: string; error: string }>;
}

export function liveEditPushOps(cfg: SquareConfig): EditPushOps {
  return {
    getObject: (id) => getCatalogObject(cfg, id),
    upsert: (body) => upsertCatalogObject(cfg, body),
  };
}

const dollarsToCents = (s: string): number | null => {
  const n = Math.round(parseFloat(String(s).replace(/[$,]/g, '')) * 100);
  return Number.isFinite(n) ? n : null;
};
const centsToStr = (c: number): string => (c / 100).toFixed(2);
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A name edit "diverges" when it changes the actual words, not just spacing/case/punctuation. */
export function nameDiverges(oldBase: string, newBase: string): boolean {
  return alnum(oldBase) !== alnum(newBase);
}

interface MapRow {
  seq: string;
  square_item_id: string | null;
  square_variation_id: string | null;
  vendor: string | null;
  vendor_sku: string | null;
  item_name: string | null; // stored WITH the [TAGS] suffix
  item_description: string | null;
  retail_price: string | null;
  category_path: string | null;
}

const stripSuffix = (name: string): string => name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
const suffixOf = (name: string): string => {
  const m = name.match(/\s*(\[[^\]]*\])\s*$/);
  return m ? ' ' + m[1] : '';
};

async function logEdit(
  db: Queryable,
  clientId: string,
  row: MapRow,
  field: string,
  oldValue: string,
  newValue: string,
  diverged = false,
): Promise<void> {
  await db.query(
    `insert into catalog_edits
       (client_id, square_item_id, square_variation_id, vendor_sku, field, old_value, new_value, vendor, diverged)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [clientId, row.square_item_id, row.square_variation_id, row.vendor_sku, field, oldValue, newValue, row.vendor, diverged],
  );
}

export async function applyEdits(
  db: Queryable,
  clientId: string,
  edits: RowEdit[],
  opts: { ops?: EditPushOps } = {},
): Promise<ApplyEditsResult> {
  const ops = opts.ops ?? liveEditPushOps(squareConfigFromEnv());
  const categoryMap = await loadCategoryMap(db, clientId); // path -> square_category_id
  const result: ApplyEditsResult = { rowsChanged: 0, fieldsChanged: 0, pushed: 0, errors: [] };

  for (const edit of edits) {
    try {
      const { rows } = await db.query(
        `select seq, square_item_id, square_variation_id, vendor, vendor_sku, item_name, item_description,
                retail_price::text as retail_price, category_path
           from catalog_mapping where client_id = $1 and seq = $2`,
        [clientId, edit.seq],
      );
      if (rows.length === 0) {
        result.errors.push({ seq: edit.seq, error: 'row not found' });
        continue;
      }
      const row = rows[0] as unknown as MapRow;
      let changed = 0;

      // --- Price (variation-level) ---
      if (edit.retailPrice !== undefined) {
        const cents = dollarsToCents(edit.retailPrice);
        const oldCents = row.retail_price ? dollarsToCents(row.retail_price) : null;
        if (cents === null) {
          result.errors.push({ seq: edit.seq, error: `bad price "${edit.retailPrice}"` });
        } else if (cents !== oldCents) {
          if (row.square_variation_id) {
            const obj = await ops.getObject(row.square_variation_id);
            obj.item_variation_data = obj.item_variation_data ?? {};
            obj.item_variation_data.pricing_type = 'FIXED_PRICING';
            obj.item_variation_data.price_money = { amount: cents, currency: 'USD' };
            await ops.upsert({ idempotency_key: randomUUID(), object: obj });
            result.pushed++;
          }
          await db.query(`update catalog_mapping set retail_price = $3, updated_at = now() where client_id = $1 and seq = $2`, [clientId, edit.seq, cents / 100]);
          await logEdit(db, clientId, row, 'retail_price', oldCents != null ? centsToStr(oldCents) : '', centsToStr(cents));
          changed++;
        }
      }

      // --- Item-level fields (name / description / category): one get-modify-upsert covers them. ---
      const wantName = edit.itemName !== undefined && stripSuffix(edit.itemName) !== stripSuffix(row.item_name ?? '');
      const wantDesc = edit.description !== undefined && edit.description !== (row.item_description ?? '');
      const wantCat = edit.categoryPath !== undefined && edit.categoryPath !== (row.category_path ?? '');

      if ((wantName || wantDesc || wantCat) && row.square_item_id) {
        const obj = await ops.getObject(row.square_item_id);
        obj.item_data = obj.item_data ?? {};

        if (wantName) {
          const newBase = stripSuffix(edit.itemName!);
          const curName = String(obj.item_data.name ?? row.item_name ?? '');
          obj.item_data.name = newBase + suffixOf(curName); // keep whatever [TAGS] suffix is live
        }
        if (wantDesc) {
          obj.item_data.description = edit.description!;
        }
        if (wantCat) {
          const newLeaf = categoryMap.get(edit.categoryPath!);
          if (!newLeaf) throw new Error(`unknown category "${edit.categoryPath}"`);
          const oldLeaf = obj.item_data.reporting_category?.id;
          const keep = (obj.item_data.categories ?? [])
            .map((c: { id?: string }) => c.id)
            .filter((id: string | undefined): id is string => Boolean(id) && id !== oldLeaf);
          obj.item_data.reporting_category = { id: newLeaf };
          obj.item_data.categories = [{ id: newLeaf }, ...keep.map((id: string) => ({ id }))];
        }

        await ops.upsert({ idempotency_key: randomUUID(), object: obj });
        result.pushed++;

        if (wantName) {
          const oldBase = stripSuffix(row.item_name ?? '');
          const newBase = stripSuffix(edit.itemName!);
          await db.query(`update catalog_mapping set item_name = $3, updated_at = now() where client_id = $1 and seq = $2`, [clientId, edit.seq, newBase + suffixOf(row.item_name ?? '')]);
          await logEdit(db, clientId, row, 'item_name', oldBase, newBase, nameDiverges(oldBase, newBase));
          changed++;
        }
        if (wantDesc) {
          await db.query(`update catalog_mapping set item_description = $3, updated_at = now() where client_id = $1 and seq = $2`, [clientId, edit.seq, edit.description!]);
          await logEdit(db, clientId, row, 'description', row.item_description ?? '', edit.description!);
          changed++;
        }
        if (wantCat) {
          await db.query(`update catalog_mapping set category_path = $3, updated_at = now() where client_id = $1 and seq = $2`, [clientId, edit.seq, edit.categoryPath!]);
          await logEdit(db, clientId, row, 'category', row.category_path ?? '', edit.categoryPath!);
          changed++;
        }
      }

      if (changed > 0) {
        result.rowsChanged++;
        result.fieldsChanged += changed;
      }
    } catch (e) {
      result.errors.push({ seq: edit.seq, error: (e as Error).message });
    }
  }

  return result;
}

/**
 * Wipe the correction log for a client. The log is advisory — it never auto-changes import logic,
 * it just feeds the patterns report — so clearing it after a testing session removes noisy/test
 * edits without any lasting effect. (The sandbox wipe clears it too.)
 */
export async function clearEdits(db: Queryable, clientId: string): Promise<{ cleared: number }> {
  const r = await db.query(`delete from catalog_edits where client_id = $1 returning id`, [clientId]);
  return { cleared: r.rows.length };
}

/** Distinct category paths (for the grid's category dropdown), sorted. */
export async function getCategoryPaths(db: Queryable, clientId: string): Promise<string[]> {
  const map = await loadCategoryMap(db, clientId);
  return [...map.keys()].sort();
}

// --- The learning loop: turn recurring corrections into import-rule fix candidates. ---

export interface EditPattern {
  vendor: string;
  from: string;
  to: string;
  count: number;
}

export interface EditPatternsReport {
  totalEdits: number;
  byField: Record<string, number>;
  categoryCandidates: EditPattern[]; // recurring category moves (>=2) -> fix category_map/classification at source
  recentNameDeviations: EditPattern[]; // name edits that departed from the convention
  nameOverridesByVendor: Array<{ vendor: string; count: number }>; // high counts -> revisit that vendor's naming rules
}

export async function getEditPatterns(db: Queryable, clientId: string): Promise<EditPatternsReport> {
  const rowsOf = async (sql: string): Promise<Array<Record<string, unknown>>> =>
    (await db.query(sql, [clientId])).rows as Array<Record<string, unknown>>;

  const total = (await db.query(`select count(*)::int as n from catalog_edits where client_id = $1`, [clientId]))
    .rows[0] as { n: number };

  const fieldRows = await rowsOf(`select field, count(*)::int as n from catalog_edits where client_id = $1 group by field`);
  const byField: Record<string, number> = {};
  for (const r of fieldRows) byField[String(r.field)] = Number(r.n);

  const cat = await rowsOf(
    `select coalesce(vendor,'') as vendor, coalesce(old_value,'') as old_value, coalesce(new_value,'') as new_value,
            count(*)::int as n
       from catalog_edits where client_id = $1 and field = 'category'
      group by vendor, old_value, new_value having count(*) >= 2 order by n desc, vendor`,
  );
  const categoryCandidates: EditPattern[] = cat.map((r) => ({
    vendor: String(r.vendor), from: String(r.old_value), to: String(r.new_value), count: Number(r.n),
  }));

  const names = await rowsOf(
    `select coalesce(vendor,'') as vendor, coalesce(old_value,'') as old_value, coalesce(new_value,'') as new_value
       from catalog_edits where client_id = $1 and field = 'item_name' and diverged = true
      order by edited_at desc limit 50`,
  );
  const recentNameDeviations: EditPattern[] = names.map((r) => ({
    vendor: String(r.vendor), from: String(r.old_value), to: String(r.new_value), count: 1,
  }));

  const nv = await rowsOf(
    `select coalesce(vendor,'(unknown)') as vendor, count(*)::int as n
       from catalog_edits where client_id = $1 and field = 'item_name' and diverged = true
      group by vendor order by n desc`,
  );
  const nameOverridesByVendor = nv.map((r) => ({ vendor: String(r.vendor), count: Number(r.n) }));

  return { totalEdits: total.n, byField, categoryCandidates, recentNameDeviations, nameOverridesByVendor };
}
