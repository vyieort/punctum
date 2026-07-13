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

export async function batchChangeInventory(cfg: SquareConfig, body: unknown): Promise<any> {
  return squareRequest(cfg, '/v2/inventory/changes/batch-create', { method: 'POST', body });
}
