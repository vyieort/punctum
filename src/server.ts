// Punctum HTTP service.
//
// A thin, dependency-free wrapper around the tagger so the service has a long-running
// process for Railway to host. Endpoints:
//   GET /health  -> liveness probe
//   GET /tags    -> run the tagger over a single catalog group built from query params
//   GET /        -> usage
//
// Listens on process.env.PORT (Railway injects it), defaulting to 3000 for local runs.

import { createServer } from 'node:http';
import { generateTags, type TagInputRow } from './lib/tagger.js';
import { getPool } from './db/pool.js';
import { runTagsJob, type Queryable } from './jobs/pg-rows.js';

const PORT = Number(process.env.PORT) || 3000;

/** Build a one-catalog group from query params and run the tagger. */
function tagsFromQuery(url: URL) {
  const vendor = url.searchParams.get('vendor') ?? '';
  const item = url.searchParams.get('item') ?? '';
  // Variations may be repeated (?variation=a&variation=b) or comma-joined (?variations=a,b).
  const variations = [
    ...url.searchParams.getAll('variation'),
    ...(url.searchParams.get('variations')?.split(',') ?? []),
  ]
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

  const rows: TagInputRow[] = (variations.length ? variations : ['']).map((v, i) => ({
    vendor,
    itemName: item,
    variationName: v,
    catalogId: 'DEMO',
    rowNumber: i + 1,
  }));

  return generateTags(rows);
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'punctum' });
    return;
  }

  if (url.pathname === '/tags') {
    const item = url.searchParams.get('item');
    if (!item) {
      sendJson(res, 400, { error: "missing required query param: 'item'" });
      return;
    }
    sendJson(res, 200, tagsFromQuery(url));
    return;
  }

  if (url.pathname === '/jobs/tags/run') {
    const client = url.searchParams.get('client') ?? 'RE';
    try {
      const summary = await runTagsJob(getPool() as unknown as Queryable, client);
      sendJson(res, 200, {
        client,
        groupsProcessed: summary.groupsProcessed,
        rowsUpdated: summary.rowsUpdated,
      });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  if (url.pathname === '/') {
    sendJson(res, 200, {
      service: 'punctum',
      version: process.env.npm_package_version ?? 'dev',
      endpoints: {
        'GET /health': 'liveness probe',
        'GET /tags':
          '/tags?vendor=BVLA&item=20g Seam Ring&variation=RG14K&variation=WG14K&variation=YG14K',
        'POST /jobs/tags/run': '/jobs/tags/run?client=RE — tags PENDING catalog_mapping rows',
      },
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`punctum listening on :${PORT}`);
});
