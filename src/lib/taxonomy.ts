// Category taxonomy tree.
//
// Derives the full set of categories Punctum needs — every leaf in CATEGORY_PATHS plus the
// vendor categories, plus every ancestor — as a parent-first node list. Used to provision a
// fresh Square account (e.g. the dev sandbox) with the whole category hierarchy and then
// re-seed category_map with the new ids.

import { CATEGORY_PATHS } from './categories.js';

export const VENDOR_CATEGORY_PATHS = [
  'Vendors > NeoMetal',
  'Vendors > Anatometal',
  'Vendors > BVLA',
  "Vendors > People's Jewelry",
  'Vendors > Quetzalli',
  'Vendors > Glasswear Studios',
  'Vendors > Stiletto Piercing Supply',
] as const;

const SEP = ' > ';

/** Every category path needed — each leaf plus all of its ancestors — deduped. */
export function allCategoryPaths(): string[] {
  const leaves = [...Object.values(CATEGORY_PATHS), ...VENDOR_CATEGORY_PATHS];
  const set = new Set<string>();
  for (const leaf of leaves) {
    const parts = leaf.split(SEP);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join(SEP));
  }
  return [...set];
}

export interface CategoryNode {
  path: string;
  name: string; // leaf segment — the Square category name
  parentPath: string | null;
  depth: number; // 0 = top level
}

/** The taxonomy as nodes, sorted parents-first so a provisioner always has the parent id. */
export function categoryTree(): CategoryNode[] {
  return allCategoryPaths()
    .map((path) => {
      const parts = path.split(SEP);
      return {
        path,
        name: parts[parts.length - 1]!,
        parentPath: parts.length > 1 ? parts.slice(0, -1).join(SEP) : null,
        depth: parts.length - 1,
      };
    })
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}
