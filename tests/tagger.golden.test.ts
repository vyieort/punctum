// Golden parity test.
//
// tests/golden/groups.json is the frozen regression suite: every catalog group from the
// 6.10 production mapping backup whose ported output EXACTLY matched the tags the live
// Make code wrote (194 groups). Ambiguous groups (multiple distinct tag strings for one
// catalog ID) and membership-drift mismatches are excluded — see docs/DECISIONS.md.
//
// Regenerate with: npm run tags:parity  (requires the derived _source-rows.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateTags, type TagInputRow } from '../src/lib/tagger.js';

interface GoldenGroup {
  catalogId: string;
  itemName: string;
  vendor: string;
  expectedTags: string;
  rows: TagInputRow[];
}

const golden: GoldenGroup[] = JSON.parse(
  readFileSync(new URL('./golden/groups.json', import.meta.url), 'utf8'),
);

test('golden corpus is present and sizable', () => {
  assert.ok(golden.length >= 190, `expected >= 190 golden groups, got ${golden.length}`);
});

for (const g of golden) {
  test(`golden ${g.catalogId} — ${g.itemName}`, () => {
    assert.equal(generateTags(g.rows).tags, g.expectedTags);
  });
}
