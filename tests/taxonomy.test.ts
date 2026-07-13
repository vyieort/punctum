// Category taxonomy tree derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allCategoryPaths, categoryTree } from '../src/lib/taxonomy.js';

test('allCategoryPaths includes every leaf and all ancestors, deduped', () => {
  const paths = allCategoryPaths();
  const set = new Set(paths);
  assert.equal(set.size, paths.length); // no duplicates
  assert.ok(set.has('Threadless')); // top-level ancestor
  assert.ok(set.has('Threadless > Threadless Ends')); // mid ancestor
  assert.ok(set.has('Threadless > Threadless Ends > Bezel-Set')); // leaf
  assert.ok(set.has('Vendors')); // vendor parent (only exists as an ancestor)
  assert.ok(set.has('Vendors > BVLA'));
  assert.ok(set.has('Diagnostic > Flag For Review'));
});

test('categoryTree is sorted parents-first, with name = leaf segment', () => {
  const tree = categoryTree();
  const seen = new Set<string>();
  for (const node of tree) {
    if (node.parentPath) assert.ok(seen.has(node.parentPath), `parent ${node.parentPath} must precede ${node.path}`);
    seen.add(node.path);
    assert.equal(node.name, node.path.split(' > ').pop());
  }
  const top = tree.find((n) => n.path === 'Threadless')!;
  assert.equal(top.depth, 0);
  assert.equal(top.parentPath, null);
});
