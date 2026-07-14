// Minimal Square API client (dependency-free, injectable fetch).
//
// Targets the sandbox or production host based on config, and exposes just the calls the
// import needs: list locations (for credential verification), search an item by exact
// name, upsert a catalog object, and batch-change inventory. Payload bodies come from
// square.ts; this module only sends them.

export type SquareEnv = 'sandbox' | 'production';

const BASE_URLS: Record<SquareEnv, string> = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
};

export interface SquareConfig {
  token: string;
  env: SquareEnv;
  locationId: string;
  version?: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

/** Build config from environment variables (SQUARE_ACCESS_TOKEN / SQUARE_ENV / SQUARE_LOCATION_ID). */
export function squareConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SquareConfig {
  const token = env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error('SQUARE_ACCESS_TOKEN is not set');
  const environment: SquareEnv = env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
  return { token, env: environment, locationId: env.SQUARE_LOCATION_ID ?? '' };
}

export async function squareRequest(
  cfg: SquareConfig,
  path: string,
  opts: { method: string; body?: unknown },
): Promise<any> {
  const base = cfg.baseUrl ?? BASE_URLS[cfg.env];
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(base + path, {
    method: opts.method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      'square-version': cfg.version ?? '2026-01-22',
      'content-type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Square ${res.status} ${path}: ${JSON.stringify(json.errors ?? json).slice(0, 400)}`);
  }
  return json;
}

export async function listLocations(cfg: SquareConfig): Promise<Array<{ id: string; name: string }>> {
  const j = await squareRequest(cfg, '/v2/locations', { method: 'GET' });
  return (j.locations ?? []).map((l: { id: string; name: string }) => ({ id: l.id, name: l.name }));
}

/** Exact-name ITEM search (Sc2 module 5) — returns matching catalog ITEM objects. */
export async function searchItemByName(cfg: SquareConfig, name: string): Promise<any[]> {
  const j = await squareRequest(cfg, '/v2/catalog/search', {
    method: 'POST',
    body: { object_types: ['ITEM'], query: { exact_query: { attribute_name: 'name', attribute_value: name } } },
  });
  return j.objects ?? [];
}

export async function upsertCatalogObject(cfg: SquareConfig, body: unknown): Promise<any> {
  return squareRequest(cfg, '/v2/catalog/object', { method: 'POST', body });
}

/** Create a catalog CATEGORY (top-level, or nested under parentId). Returns its new id. */
export async function createCategory(
  cfg: SquareConfig,
  opts: { name: string; parentId?: string | null },
): Promise<string> {
  const category_data: Record<string, unknown> = { name: opts.name };
  if (opts.parentId) category_data.parent_category = { id: opts.parentId };
  else category_data.is_top_level = true;

  const j = await upsertCatalogObject(cfg, {
    idempotency_key: `cat-${opts.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: { type: 'CATEGORY', id: '#cat', category_data },
  });
  return (j.catalog_object?.id ?? j.id) as string;
}

export async function batchChangeInventory(cfg: SquareConfig, body: unknown): Promise<any> {
  return squareRequest(cfg, '/v2/inventory/changes/batch-create', { method: 'POST', body });
}

/** Existing image ids on a variation — used to skip enrichment when one is already set. */
export async function getVariationImageIds(cfg: SquareConfig, variationId: string): Promise<string[]> {
  const j = await squareRequest(cfg, `/v2/catalog/object/${variationId}`, { method: 'GET' });
  return j.object?.item_variation_data?.image_ids ?? [];
}

/** Fetch an image URL to bytes (for the multipart upload Square requires). */
export async function downloadImage(
  url: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetchImpl(url, { headers: { accept: 'image/jpeg, image/png, image/gif' } });
  if (!res.ok) throw new Error(`image download ${res.status} ${url.slice(0, 120)}`);
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}

/**
 * Attach an image to a catalog VARIATION via multipart POST /v2/catalog/images (Square requires
 * the raw bytes, not a URL). Returns the new image id + its Square-hosted URL.
 */
export async function attachVariationImage(
  cfg: SquareConfig,
  opts: { variationId: string; itemName: string; bytes: Buffer; contentType?: string; fileName?: string },
): Promise<{ imageId: string; url: string }> {
  const base = cfg.baseUrl ?? BASE_URLS[cfg.env];
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const request = JSON.stringify({
    idempotency_key: `${opts.variationId}-var-img`,
    image: { type: 'IMAGE', id: '#temp_image', image_data: { name: opts.itemName || 'Product Image', caption: '' } },
    object_id: opts.variationId,
  });
  const form = new FormData();
  form.append('request', request);
  const part = new Blob([opts.bytes as unknown as BlobPart], { type: opts.contentType ?? 'image/jpeg' });
  form.append('image_file', part, opts.fileName ?? 'image.jpg');

  // Note: no content-type header — fetch sets multipart/form-data + boundary from the FormData.
  const res = await doFetch(`${base}/v2/catalog/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', 'square-version': cfg.version ?? '2026-01-22' },
    body: form,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Square image ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  }
  return { imageId: json.image?.id ?? json.catalog_object?.id ?? '', url: json.image?.image_data?.url ?? '' };
}

/** List every catalog ITEM object (follows the cursor to the end). */
export async function listCatalogItems(cfg: SquareConfig): Promise<any[]> {
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const j = await squareRequest(cfg, `/v2/catalog/list?types=ITEM${q}`, { method: 'GET' });
    for (const o of j.objects ?? []) items.push(o);
    cursor = j.cursor;
  } while (cursor);
  return items;
}

/** Batch-delete catalog objects (and their child variations) by id, 200 at a time. */
export async function batchDeleteObjects(cfg: SquareConfig, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await squareRequest(cfg, '/v2/catalog/batch-delete', { method: 'POST', body: { object_ids: chunk } });
    deleted += chunk.length;
  }
  return deleted;
}
