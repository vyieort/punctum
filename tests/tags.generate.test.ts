// Job-wrapper tests: filter/group/update semantics of Make modules 1, 2, 4, 5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPendingRows,
  groupByCatalogId,
  computeRowUpdates,
  planTagJobs,
  runTagGeneration,
  type MappingRow,
  type RowUpdate,
} from '../src/jobs/tags.generate.js';

const rows: MappingRow[] = [
  { rowNumber: 2, vendor: 'Anatometal', catalogId: 'A1', itemName: '14G Straight Barbell', variationName: '', status: 'PENDING', tags: '' },
  { rowNumber: 3, vendor: 'Anatometal', catalogId: 'A1', itemName: '14G Straight Barbell', variationName: 'Titanium', status: 'pending', tags: '' },
  { rowNumber: 4, vendor: 'X', catalogId: '', itemName: 'orphan (no catalog id)', variationName: '', status: 'PENDING', tags: '' },
  { rowNumber: 5, vendor: 'Y', catalogId: 'B2', itemName: 'already done', variationName: '', status: 'TAGGED', tags: 'OLD' },
  { rowNumber: 6, vendor: 'NeoMetal', catalogId: 'C3', itemName: '16G Threadless Labret', variationName: '', status: 'Pending', tags: '' },
];

test('filterPendingRows: keeps PENDING (case-insensitive) with a non-empty catalog id', () => {
  const kept = filterPendingRows(rows).map((r) => r.rowNumber);
  assert.deepEqual(kept, [2, 3, 6]); // 4 has no catalog id, 5 is TAGGED
});

test('groupByCatalogId: preserves first-seen order and groups shared ids', () => {
  const groups = groupByCatalogId(filterPendingRows(rows));
  assert.deepEqual(groups.map((g) => g.catalogId), ['A1', 'C3']);
  assert.equal(groups[0].rows.length, 2);
});

test('planTagJobs: one job per catalog id with tagger output', () => {
  const jobs = planTagJobs(rows);
  assert.equal(jobs.length, 2);
  const a1 = jobs.find((j) => j.catalogId === 'A1')!;
  // ANA + 14g + BBL, Titanium -> TI, then threading inference (14g) -> TD.
  assert.equal(a1.result.tags, 'ANA 14g BBL TI TD');
});

test('computeRowUpdates: writes TAGGED + group tags to every pending row in the group', () => {
  const updates: RowUpdate[] = computeRowUpdates(rows);
  assert.equal(updates.length, 3); // rows 2, 3, 6
  const a1 = updates.filter((u) => u.rowNumber === 2 || u.rowNumber === 3);
  assert.ok(a1.every((u) => u.status === 'TAGGED' && u.tags === 'ANA 14g BBL TI TD'));
  assert.ok(!updates.some((u) => u.rowNumber === 4 || u.rowNumber === 5));
});

test('runTagGeneration: pulls from source and writes to sink', async () => {
  const written: RowUpdate[] = [];
  const summary = await runTagGeneration(
    { listPendingRows: async () => rows },
    { applyUpdates: async (u) => { written.push(...u); } },
  );
  assert.equal(summary.groupsProcessed, 2);
  assert.equal(summary.rowsUpdated, 3);
  assert.equal(written.length, 3);
});
