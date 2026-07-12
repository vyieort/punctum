// Postgres-backed RowSource / RowSink for the tag-generation job.
//
// Reads PENDING `catalog_mapping` rows and writes TAGGED + tags back — the same
// filter/update semantics as Make scenario 5330172 modules 1, 4, and 5, now against a
// real table. The adapter depends only on a structural `Queryable`, so it works with a
// node-postgres Pool in production and with PGlite in tests — no hard `pg` dependency here.

import type { RowSource, RowSink, MappingRow, RowUpdate } from './tags.generate.js';

/** Minimal query surface shared by node-postgres `Pool` and PGlite. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const PENDING_SELECT = `
  select seq, vendor, square_item_id, item_name, variation_name, status, tags
    from catalog_mapping
   where client_id = $1
     and status = 'PENDING'
     and coalesce(square_item_id, '') <> ''
   order by square_item_id, seq
   limit $2
`;

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Module 1: PENDING rows with a non-empty catalog id, grouped-stable by (item, seq). */
export class PgRowSource implements RowSource {
  constructor(
    private readonly db: Queryable,
    private readonly clientId: string,
  ) {}

  async listPendingRows(limit = 1000): Promise<MappingRow[]> {
    const { rows } = await this.db.query(PENDING_SELECT, [this.clientId, limit]);
    return rows.map((r) => ({
      rowNumber: Number(r.seq),
      vendor: str(r.vendor),
      catalogId: str(r.square_item_id),
      itemName: str(r.item_name),
      variationName: str(r.variation_name),
      status: str(r.status),
      tags: str(r.tags),
    }));
  }
}

/**
 * Modules 4–5: write TAGGED + tags back to the pending rows. All rows in a catalog group
 * share one tag string, so updates are batched by tag value into one statement each. The
 * `status = 'PENDING'` guard makes re-runs safe (already-tagged rows are untouched).
 */
export class PgRowSink implements RowSink {
  constructor(
    private readonly db: Queryable,
    private readonly clientId: string,
  ) {}

  async applyUpdates(updates: RowUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    const seqsByTags = new Map<string, number[]>();
    for (const u of updates) {
      const seqs = seqsByTags.get(u.tags) ?? [];
      seqs.push(u.rowNumber);
      seqsByTags.set(u.tags, seqs);
    }
    for (const [tags, seqs] of seqsByTags) {
      await this.db.query(
        `update catalog_mapping
            set status = 'TAGGED', tags = $1
          where client_id = $2 and seq = any($3::bigint[]) and status = 'PENDING'`,
        [tags, this.clientId, seqs],
      );
    }
  }
}
