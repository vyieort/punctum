// Sc2.5 tag-generation job.
//
// Implements the grouping/filter/update semantics of Make scenario 5330172's
// modules 1, 2, 4, and 5 around the pure tagger in src/lib/tagger.ts:
//
//   module 1 (filterRows)     -> filterPendingRows()   : J="PENDING" (ci) AND D nonempty
//   module 2 (TextAggregator) -> groupByCatalogId()    : groupBy D, preserve sheet order
//   module 3 (ExecuteCode)    -> generateTags()         : the ported tagger
//   module 4 (filterRows)     -> (rows sharing D that are PENDING)
//   module 5 (updateRow)      -> RowUpdate{ status:"TAGGED", tags } per row, onerror=Ignore
//
// I/O is abstracted behind RowSource/RowSink so Phase 0 can drive it from an in-memory
// array (and tests), and later phases can back it with Google Sheets or Postgres without
// touching the tagging logic.

import { generateTags, type TagInputRow, type TagResult } from '../lib/tagger.js';

/** A mapping-sheet row, superset of the tagger's input. */
export interface MappingRow {
  rowNumber: number;
  vendor: string; // col A
  catalogId: string; // col D
  itemName: string; // col G
  variationName: string; // col H
  status: string; // col J
  tags: string; // col K
}

/** One write-back produced by the job (module 5). */
export interface RowUpdate {
  rowNumber: number;
  status: 'TAGGED';
  tags: string;
}

/** Result of tagging a single catalog group. */
export interface TagJob {
  catalogId: string;
  result: TagResult;
  rows: MappingRow[];
}

export interface TagRunSummary {
  groupsProcessed: number;
  rowsUpdated: number;
  jobs: TagJob[];
  updates: RowUpdate[];
}

// Live-scenario limits (module 1 = 1000, module 4 = 100). Defaults mirror module 1.
const DEFAULT_PENDING_LIMIT = 1000;

function isPending(status: string): boolean {
  return (status || '').toLowerCase().trim() === 'pending';
}

/** Module 1: rows with status PENDING (case-insensitive) and a non-empty catalog ID. */
export function filterPendingRows(
  rows: MappingRow[],
  limit: number = DEFAULT_PENDING_LIMIT,
): MappingRow[] {
  const out: MappingRow[] = [];
  for (const r of rows) {
    if (isPending(r.status) && (r.catalogId || '').trim() !== '') {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Module 2: group rows by catalog ID, preserving first-seen (sheet) order. */
export function groupByCatalogId(rows: MappingRow[]): Array<{ catalogId: string; rows: MappingRow[] }> {
  const order: string[] = [];
  const byId = new Map<string, MappingRow[]>();
  for (const r of rows) {
    const id = (r.catalogId || '').trim();
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(r);
  }
  return order.map((id) => ({ catalogId: id, rows: byId.get(id)! }));
}

function toTagInput(rows: MappingRow[]): TagInputRow[] {
  return rows.map((r) => ({
    vendor: r.vendor,
    itemName: r.itemName,
    variationName: r.variationName,
    catalogId: r.catalogId,
    rowNumber: r.rowNumber,
  }));
}

/** Modules 1–3: filter to pending, group, and run the tagger per group. */
export function planTagJobs(
  rows: MappingRow[],
  limit: number = DEFAULT_PENDING_LIMIT,
): TagJob[] {
  const pending = filterPendingRows(rows, limit);
  const groups = groupByCatalogId(pending);
  return groups.map(({ catalogId, rows: groupRows }) => ({
    catalogId,
    rows: groupRows,
    result: generateTags(toTagInput(groupRows)),
  }));
}

/**
 * Modules 4–5: for every pending row in each group, emit a write-back setting
 * status=TAGGED and tags=<group tag string>. Groups whose tagger returned an error
 * are skipped (mirrors module 5's onerror=Ignore — nothing is written).
 */
export function computeRowUpdates(
  rows: MappingRow[],
  limit: number = DEFAULT_PENDING_LIMIT,
): RowUpdate[] {
  const updates: RowUpdate[] = [];
  for (const job of planTagJobs(rows, limit)) {
    if (job.result.error) continue;
    for (const r of job.rows) {
      updates.push({ rowNumber: r.rowNumber, status: 'TAGGED', tags: job.result.tags });
    }
  }
  return updates;
}

// --- I/O abstraction ----------------------------------------------------------

export interface RowSource {
  /** Module 1: fetch PENDING rows with a non-empty catalog ID. */
  listPendingRows(limit?: number): Promise<MappingRow[]>;
}

export interface RowSink {
  /** Module 5: persist the write-backs (status + tags). */
  applyUpdates(updates: RowUpdate[]): Promise<void>;
}

/** Orchestrate one run: pull pending rows, tag, and write results back. */
export async function runTagGeneration(
  source: RowSource,
  sink: RowSink,
  limit: number = DEFAULT_PENDING_LIMIT,
): Promise<TagRunSummary> {
  const rows = await source.listPendingRows(limit);
  const jobs = planTagJobs(rows, limit);
  const updates = computeRowUpdates(rows, limit);
  await sink.applyUpdates(updates);
  return {
    groupsProcessed: jobs.length,
    rowsUpdated: updates.length,
    jobs,
    updates,
  };
}
