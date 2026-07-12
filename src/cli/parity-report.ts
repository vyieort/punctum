// Parity report: rebuild each catalog group from the frozen mapping-sheet backup,
// run the ported tagger, and compare to the tags the LIVE Make code wrote (column K).
//
//   input : tests/golden/_source-rows.json  (derived from the 6.10 xlsx; not committed)
//   output: tests/golden/groups.json         (exact-match groups = the golden suite)
//           tests/golden/_parity-report.json  (full triage detail; not committed)
//
// Run: npm run tags:parity
//
// Expected parity is < 100%: some catalog IDs carry multiple distinct tag strings
// (group membership grew over time; the known Sc3 tag-overwrite bug degraded a few —
// see memory project_tag_overwrite_bug). Those are excluded as ambiguous. Single-tag
// groups that still mismatch are reported with a token diff so a human can triage.

import { readFileSync, writeFileSync } from 'node:fs';
import { generateTags, type TagInputRow } from '../lib/tagger.js';

interface SourceRow {
  rowNumber: number;
  vendor: string;
  catalogId: string;
  itemName: string;
  variationName: string;
  status: string;
  tags: string;
}

interface GoldenGroup {
  catalogId: string;
  itemName: string;
  vendor: string;
  expectedTags: string;
  rows: TagInputRow[];
}

interface Mismatch {
  catalogId: string;
  itemName: string;
  expected: string;
  actual: string;
  missing: string[]; // in expected, not produced
  extra: string[]; // produced, not in expected
  sameSet: boolean; // same tokens, different order -> would be a real port bug
  variationCount: number;
}

const srcUrl = new URL('../../tests/golden/_source-rows.json', import.meta.url);
const goldenUrl = new URL('../../tests/golden/groups.json', import.meta.url);
const reportUrl = new URL('../../tests/golden/_parity-report.json', import.meta.url);

const rows: SourceRow[] = JSON.parse(readFileSync(srcUrl, 'utf8'));

// Group by catalog ID, preserving first-seen (sheet) order.
const order: string[] = [];
const byId = new Map<string, SourceRow[]>();
for (const r of rows) {
  if (!byId.has(r.catalogId)) {
    byId.set(r.catalogId, []);
    order.push(r.catalogId);
  }
  byId.get(r.catalogId)!.push(r);
}

const golden: GoldenGroup[] = [];
const mismatches: Mismatch[] = [];
const ambiguous: Array<{ catalogId: string; itemName: string; distinctTags: string[] }> = [];

for (const id of order) {
  const groupRows = byId.get(id)!;
  const distinctTags = Array.from(new Set(groupRows.map((r) => r.tags).filter((t) => t !== '')));

  if (distinctTags.length !== 1) {
    ambiguous.push({
      catalogId: id,
      itemName: groupRows[0].itemName,
      distinctTags,
    });
    continue;
  }

  const expected = distinctTags[0];
  const input: TagInputRow[] = groupRows.map((r) => ({
    vendor: r.vendor,
    itemName: r.itemName,
    variationName: r.variationName,
    catalogId: r.catalogId,
    rowNumber: r.rowNumber,
  }));
  const actual = generateTags(input).tags;

  if (actual === expected) {
    golden.push({
      catalogId: id,
      itemName: groupRows[0].itemName,
      vendor: groupRows[0].vendor,
      expectedTags: expected,
      rows: input,
    });
  } else {
    const expSet = new Set(expected.split(' ').filter(Boolean));
    const actSet = new Set(actual.split(' ').filter(Boolean));
    const missing = [...expSet].filter((x) => !actSet.has(x));
    const extra = [...actSet].filter((x) => !expSet.has(x));
    mismatches.push({
      catalogId: id,
      itemName: groupRows[0].itemName,
      expected,
      actual,
      missing,
      extra,
      sameSet: missing.length === 0 && extra.length === 0,
      variationCount: groupRows.length,
    });
  }
}

const totalGroups = order.length;
const singleTagGroups = totalGroups - ambiguous.length;
const exact = golden.length;
const orderOnly = mismatches.filter((m) => m.sameSet);

// Deterministic ordering for a stable committed fixture.
golden.sort((a, b) => a.catalogId.localeCompare(b.catalogId));
writeFileSync(goldenUrl, JSON.stringify(golden, null, 2) + '\n');
writeFileSync(
  reportUrl,
  JSON.stringify({ mismatches, ambiguous, orderOnlyCount: orderOnly.length }, null, 2) + '\n',
);

const pct = (n: number, d: number) => (d === 0 ? '—' : ((100 * n) / d).toFixed(1) + '%');

console.log('=== Sc2.5 tagger parity report ===');
console.log(`total catalog groups        : ${totalGroups}`);
console.log(`ambiguous (>1 distinct tag) : ${ambiguous.length}  (excluded)`);
console.log(`single-tag groups           : ${singleTagGroups}`);
console.log(`  exact port matches        : ${exact}  (${pct(exact, singleTagGroups)} of single-tag)`);
console.log(`  mismatches                : ${mismatches.length}`);
console.log(`  of which order-only       : ${orderOnly.length}  (must be 0 — else port bug)`);
console.log(`golden suite written        : ${exact} groups -> tests/golden/groups.json`);

if (orderOnly.length > 0) {
  console.log('\n!! ORDER-ONLY MISMATCHES (same tags, wrong order — investigate) !!');
  for (const m of orderOnly.slice(0, 20)) {
    console.log(`  ${m.catalogId} ${m.itemName}`);
    console.log(`    expected: ${m.expected}`);
    console.log(`    actual  : ${m.actual}`);
  }
}

if (mismatches.length > 0) {
  console.log('\n--- sample set-difference mismatches (first 15) ---');
  for (const m of mismatches.filter((x) => !x.sameSet).slice(0, 15)) {
    console.log(`  ${m.catalogId} "${m.itemName}" (${m.variationCount} vars)`);
    console.log(`    expected: ${m.expected}`);
    console.log(`    actual  : ${m.actual}`);
    console.log(`    missing : [${m.missing.join(', ')}]  extra: [${m.extra.join(', ')}]`);
  }
}
