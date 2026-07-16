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
  maxRetries?: number; // 429/503 retries (default 5)
  retryBaseMs?: number; // backoff base (default 500)
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
  const maxRetries = cfg.maxRetries ?? 5;
  const retryBaseMs = cfg.retryBaseMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch(base + path, {
      method: opts.method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'square-version': cfg.version ?? '2026-01-22',
        'content-type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    // Retry on 429 (rate limit / "Catalog locked by prior request") and 503, honoring Retry-After.
    // All our writes carry idempotency keys, so a retry is a safe no-op on Square's side.
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const ra = Number(res.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, retryBaseMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(`Square ${res.status} ${path}: ${JSON.stringify(json.errors ?? json).slice(0, 400)}`);
    }
    return json;
  }
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

/** Fetch a single catalog object (with its current version, needed for a safe edit-upsert). */
export async function getCatalogObject(cfg: SquareConfig, id: string): Promise<any> {
  const j = await squareRequest(cfg, `/v2/catalog/object/${encodeURIComponent(id)}`, { method: 'GET' });
  return j.object;
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

/** Delete a catalog object (e.g. an IMAGE) by id. Ignores a 404 (already gone). */
export async function deleteCatalogObject(cfg: SquareConfig, id: string): Promise<void> {
  try {
    await squareRequest(cfg, `/v2/catalog/object/${id}`, { method: 'DELETE' });
  } catch (e) {
    if (!/ 404 /.test((e as Error).message)) throw e;
  }
}

/** Existing image ids on a variation — used to skip enrichment when one is already set. */
export async function getVariationImageIds(cfg: SquareConfig, variationId: string): Promise<string[]> {
  const j = await squareRequest(cfg, `/v2/catalog/object/${variationId}`, { method: 'GET' });
  return j.object?.item_variation_data?.image_ids ?? [];
}

/** Existing image ids on an item (its grid/primary image). */
export async function getItemImageIds(cfg: SquareConfig, itemId: string): Promise<string[]> {
  const j = await squareRequest(cfg, `/v2/catalog/object/${itemId}`, { method: 'GET' });
  return j.object?.item_data?.image_ids ?? [];
}

/**
 * Point an item's primary (grid) image at an existing IMAGE object — reuses the variation's
 * image, no re-upload. Read-modify-write of the full item so variations are preserved.
 */
export async function setItemImage(cfg: SquareConfig, itemId: string, imageId: string): Promise<void> {
  const got = await squareRequest(cfg, `/v2/catalog/object/${itemId}`, { method: 'GET' });
  const obj = got.object;
  if (!obj) throw new Error(`item ${itemId} not found`);
  obj.item_data = obj.item_data ?? {};
  obj.item_data.image_ids = [imageId];
  await squareRequest(cfg, '/v2/catalog/object', {
    method: 'POST',
    body: { idempotency_key: `${itemId}-itemimg-${Date.now()}`, object: obj },
  });
}

/** Content types Square accepts for a catalog image. */
const ALLOWED_IMAGE_TYPE = /^image\/(jpeg|pjpeg|png|x-png|gif)/i;
export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPE.test(contentType);
}

/** Small stable hash (djb2) for building a per-image idempotency key. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
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
  opts: { variationId: string; itemName: string; bytes: Buffer; contentType?: string; fileName?: string; sourceUrl?: string },
): Promise<{ imageId: string; url: string }> {
  const base = cfg.baseUrl ?? BASE_URLS[cfg.env];
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const request = JSON.stringify({
    // Key is per-image (hash of the source URL) so a retry with a different image doesn't
    // collide with a prior failed attempt's key.
    idempotency_key: `${opts.variationId}-${opts.sourceUrl ? shortHash(opts.sourceUrl) : 'img'}`,
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
