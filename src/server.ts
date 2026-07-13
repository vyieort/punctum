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
import { handleReview } from './review/handler.js';
import { ingestInvoice } from './jobs/intake.js';
import { squareConfigFromEnv, listLocations } from './lib/square-client.js';
import { previewInvoiceImport } from './jobs/import-preview.js';
import { provisionCategories } from './jobs/provision-categories.js';

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

function readBodyBuffer(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal upload page: reads a chosen PDF and POSTs its bytes to /invoices/upload,
// then redirects to the review page for the newly-created invoice.
const UPLOAD_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload invoice</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:3rem auto;max-width:560px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 1rem} input,button{font:inherit}
  .drop{border:1px dashed #bbb;border-radius:8px;padding:2rem;text-align:center;background:#fafafa}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#555;min-height:1.2em}
</style></head>
<body>
  <h2>Upload a vendor invoice</h2>
  <div class="drop">
    <input type="file" id="f" accept="application/pdf">
    <div><button id="go" onclick="up()">Extract &amp; review</button></div>
  </div>
  <div id="status"></div>
<script>
async function up(){
  var el=document.getElementById('f'); var s=document.getElementById('status'); var b=document.getElementById('go');
  if(!el.files||!el.files[0]){ s.textContent='Pick a PDF first.'; return; }
  var file=el.files[0]; b.disabled=true; s.textContent='Extracting '+file.name+' — this can take a minute…';
  try{
    var buf=await file.arrayBuffer();
    var res=await fetch('/invoices/upload?filename='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':'application/pdf'},body:buf});
    var j=await res.json();
    if(res.ok && j.reviewUrl){ s.textContent='Done — opening review…'; location.href=j.reviewUrl; }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(err){ s.textContent='Error: '+err.message; b.disabled=false; }
}
</script>
</body></html>`;

// One-click page to trigger category provisioning (POSTs to itself).
const PROVISION_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provision categories</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:3rem auto;max-width:600px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  .warn{background:#fff8e1;border:1px solid #f2d98a;border-radius:6px;padding:.6rem .8rem;font-size:14px;color:#7a5b00}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em}
</style></head>
<body>
  <h2>Provision category tree</h2>
  <p>Creates the full category hierarchy (48 categories) in the connected Square <strong>sandbox</strong> and re-seeds the category map with the new IDs.</p>
  <div class="warn">Run this <strong>once</strong> against an empty sandbox — running it again creates duplicate categories.</div>
  <button id="go" onclick="run()">Provision categories</button>
  <div id="status"></div>
<script>
async function run(){
  if(!confirm('Create ~48 categories in the Square sandbox? Run this only once.')) return;
  var b=document.getElementById('go'), s=document.getElementById('status');
  b.disabled=true; s.textContent='Provisioning — creating categories in Square…';
  try{
    var res=await fetch('/jobs/categories/provision?client=RE',{method:'POST'});
    var j=await res.json();
    if(res.ok){ s.textContent='Done — created '+j.created+' categories. Re-run the preview to see your own category IDs.'; }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
</script>
</body></html>`;

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
        'GET /invoices/new': 'upload a vendor invoice PDF -> extract -> review',
        'GET /invoices/:id/review': 'read-only review + approve/reject',
      },
    });
    return;
  }

  // Import dry-run: show exactly what an approved invoice WOULD push to Square (no writes).
  if (url.pathname === '/jobs/import/preview') {
    const invoiceId = url.searchParams.get('invoice');
    const client = url.searchParams.get('client') ?? 'RE';
    if (!invoiceId) {
      sendJson(res, 400, { error: "missing required query param: 'invoice'" });
      return;
    }
    try {
      const preview = await previewInvoiceImport(getPool() as unknown as Queryable, client, invoiceId);
      sendJson(res, 200, preview);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // One-time: create the category tree in the (sandbox) Square account + re-seed category_map.
  // GET serves a one-click page; POST does the work (writes to Square). Run once.
  if (url.pathname === '/jobs/categories/provision') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PROVISION_PAGE);
      return;
    }
    if (req.method === 'POST') {
      const client = url.searchParams.get('client') ?? 'RE';
      try {
        const result = await provisionCategories(squareConfigFromEnv(), getPool() as unknown as Queryable, client);
        sendJson(res, 200, { client, created: result.created });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
  }

  // Read-only credential check: confirm the Square token + host reach the sandbox.
  if (url.pathname === '/square/verify' && req.method === 'GET') {
    try {
      const cfg = squareConfigFromEnv();
      const locations = await listLocations(cfg);
      const configuredLocationValid = locations.some((l) => l.id === cfg.locationId);
      sendJson(res, 200, {
        env: cfg.env,
        configuredLocationId: cfg.locationId,
        configuredLocationValid,
        locations,
      });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Upload intake: GET /invoices/new serves the form; POST /invoices/upload runs W1.
  if (url.pathname === '/invoices/new' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(UPLOAD_PAGE);
    return;
  }
  if (url.pathname === '/invoices/upload' && req.method === 'POST') {
    try {
      const pdf = await readBodyBuffer(req);
      if (pdf.length === 0) {
        sendJson(res, 400, { error: 'empty upload' });
        return;
      }
      const client = url.searchParams.get('client') ?? 'RE';
      const filename = url.searchParams.get('filename') ?? undefined;
      const result = await ingestInvoice(getPool() as unknown as Queryable, client, {
        pdfBase64: pdf.toString('base64'),
        filename,
      });
      sendJson(res, 200, { reviewUrl: `/invoices/${result.invoiceId}/review`, ...result });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Read-only review UI over invoice_lines: /invoices/:id/{review,approve,reject}
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'invoices' && parts.length === 3) {
    const [, invoiceId, action] = parts;
    try {
      const result = await handleReview(
        getPool() as unknown as Queryable,
        req.method ?? 'GET',
        invoiceId,
        action,
      );
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`punctum listening on :${PORT}`);
});
