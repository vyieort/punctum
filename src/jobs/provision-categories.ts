// Provision a Square account (the dev sandbox) with the full category tree, then re-seed
// category_map with the new ids. One-time setup: run once against an empty sandbox. The
// category creator is injected so this is unit-testable without hitting Square.
//
// NOTE: not idempotent — re-running creates duplicate categories in Square. Run once; if
// you need to redo it, clear the sandbox catalog first.

import type { Queryable } from './pg-rows.js';
import { categoryTree } from '../lib/taxonomy.js';
import { createCategory, type SquareConfig } from '../lib/square-client.js';

export type CategoryCreator = (cfg: SquareConfig, opts: { name: string; parentId?: string | null }) => Promise<string>;

export interface ProvisionResult {
  created: number;
  mappings: Record<string, string>; // path -> new square_category_id
}

export async function provisionCategories(
  cfg: SquareConfig,
  db: Queryable,
  clientId: string,
  opts: { create?: CategoryCreator } = {},
): Promise<ProvisionResult> {
  const create = opts.create ?? createCategory;
  const tree = categoryTree(); // parents-first
  const idByPath = new Map<string, string>();

  for (const node of tree) {
    const parentId = node.parentPath ? (idByPath.get(node.parentPath) ?? null) : null;
    const id = await create(cfg, { name: node.name, parentId });
    idByPath.set(node.path, id);
  }

  // Re-seed category_map for this client (upsert path -> new id).
  for (const [path, id] of idByPath) {
    await db.query(
      `insert into category_map (client_id, path, square_category_id)
       values ($1, $2, $3)
       on conflict (client_id, path)
       do update set square_category_id = excluded.square_category_id, updated_at = now()`,
      [clientId, path, id],
    );
  }

  return { created: idByPath.size, mappings: Object.fromEntries(idByPath) };
}
