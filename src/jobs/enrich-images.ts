// Image enrichment (the async "Enrich" phase) — folds Sc3 (find) + Sc4 (attach) into one job.
//
// For each freshly-imported catalog row (status PENDING with a Square variation), build the
// per-vendor query, search SerpAPI, let Vision pick the best match, and — when confident —
// download the image and attach it to the Square variation. Rows that already have an image
// are skipped (never overwrite), rows with no confident match become NO_IMAGE (so they aren't
// retried forever). Everything is injected so the whole flow is unit-testable without network.

import type { Queryable } from './pg-rows.js';
import {
  squareConfigFromEnv,
  getVariationImageIds,
  downloadImage,
  attachVariationImage,
  type SquareConfig,
} from '../lib/square-client.js';
import { searchImages, type ImageCandidate } from '../lib/serpapi.js';
import { scoreImages, type VisionResult } from '../lib/vision.js';
import { buildImageQuery } from '../lib/image-query.js';

export interface EnrichOps {
  search(query: string): Promise<ImageCandidate[]>;
  score(productInfo: string, candidates: ImageCandidate[]): Promise<VisionResult>;
  variationImageIds(variationId: string): Promise<string[]>;
  download(url: string): Promise<{ bytes: Buffer; contentType: string }>;
  attach(opts: { variationId: string; itemName: string; bytes: Buffer; contentType?: string }): Promise<{ imageId: string; url: string }>;
}

export function liveEnrichOps(cfg: SquareConfig): EnrichOps {
  return {
    search: (q) => searchImages(q),
    score: (info, cands) => scoreImages(info, cands),
    variationImageIds: (vid) => getVariationImageIds(cfg, vid),
    download: (url) => downloadImage(url),
    attach: (o) => attachVariationImage(cfg, o),
  };
}

export interface EnrichOptions {
  ops?: EnrichOps;
  limit?: number;
}

export interface EnrichResult {
  processed: number;
  enriched: number;
  noImage: number;
  skipped: number; // already had an image
  errors: Array<{ sku: string; error: string }>;
}

interface MappingRow {
  seq: string;
  vendor: string | null;
  vendor_sku: string | null;
  square_variation_id: string;
  item_name: string | null;
  variation_name: string | null;
  item_description: string | null;
  gems: string | null;
  rejected_image_urls: string | null;
}

export async function enrichImages(db: Queryable, clientId: string, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const ops = opts.ops ?? liveEnrichOps(squareConfigFromEnv());
  const limit = opts.limit ?? 20;

  const { rows } = await db.query(
    `select seq, vendor, vendor_sku, square_variation_id, item_name, variation_name, item_description, gems,
            rejected_image_urls
       from catalog_mapping
      where client_id = $1 and status = 'PENDING' and coalesce(square_variation_id, '') <> ''
      order by seq
      limit $2`,
    [clientId, limit],
  );

  const result: EnrichResult = { processed: 0, enriched: 0, noImage: 0, skipped: 0, errors: [] };

  for (const raw of rows) {
    const r = raw as unknown as MappingRow;
    result.processed++;
    try {
      // Never overwrite an image that's already there (also short-circuits reorder re-runs).
      const existing = await ops.variationImageIds(r.square_variation_id);
      if (existing.length > 0) {
        await setStatus(db, clientId, r.seq, 'ENRICHED');
        result.skipped++;
        continue;
      }

      const { query, productInfo } = buildImageQuery({
        vendor: r.vendor ?? '',
        itemName: r.item_name ?? '',
        variationName: r.variation_name ?? '',
        description: r.item_description ?? '',
        gems: r.gems ?? '',
        sku: r.vendor_sku ?? '',
      });

      const candidates = await ops.search(query);
      // Skip any image the reviewer already rejected for this variation.
      const rejected = new Set(
        (r.rejected_image_urls ?? '')
          .split('\n')
          .map((u) => u.trim())
          .filter(Boolean),
      );
      const usable = rejected.size ? candidates.filter((c) => !rejected.has(c.pushUrl)) : candidates;
      const scored = await ops.score(productInfo, usable);

      if (scored.action === 'ENRICHED' && scored.imageUrl) {
        const { bytes, contentType } = await ops.download(scored.imageUrl);
        const attached = await ops.attach({ variationId: r.square_variation_id, itemName: r.item_name ?? '', bytes, contentType });
        await db.query(
          `update catalog_mapping set status = 'ENRICHED', image_url = $3, square_image_id = $4, updated_at = now()
             where client_id = $1 and seq = $2`,
          [clientId, r.seq, scored.imageUrl, attached.imageId],
        );
        result.enriched++;
      } else {
        await setStatus(db, clientId, r.seq, 'NO_IMAGE');
        result.noImage++;
      }
    } catch (e) {
      result.errors.push({ sku: r.vendor_sku ?? '', error: (e as Error).message });
    }
  }

  return result;
}

async function setStatus(db: Queryable, clientId: string, seq: string, status: string): Promise<void> {
  await db.query(`update catalog_mapping set status = $3, updated_at = now() where client_id = $1 and seq = $2`, [
    clientId,
    seq,
    status,
  ]);
}
