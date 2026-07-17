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
import { ingestInvoice, queueInvoice, requeueErrored } from './jobs/intake.js';
import { startWorker } from './jobs/worker.js';
import { getQueueRows, renderQueuePage, bulkApproveInvoices } from './review/queue.js';
import { listLocations, getItemImageUrl } from './lib/square-client.js';
import { previewInvoiceImport } from './jobs/import-preview.js';
import { provisionCategories } from './jobs/provision-categories.js';
import { runComparison } from './jobs/compare.js';
import { runImport, recoverStuckImports } from './jobs/import.js';
import { wipeSandboxCatalog } from './jobs/wipe.js';
import { parseSquareLibraryXlsx } from './lib/library-import.js';
import { seedLibrary } from './jobs/library-seed.js';
import { syncLibraryItemIds } from './jobs/library-sync.js';
import { enrichImages } from './jobs/enrich-images.js';
import { getCatalogRows, renderCatalogPage, getCandidates, setVariationImage, clearVariationImage, setItemImageFromRow, uploadVariationImage, uploadItemImage, clearItemImageForItem } from './review/catalog.js';
import { getItemDetail, renderItemPage, getVariationDetail, renderVariationPage } from './review/item-detail.js';
import { applyEdits, getEditPatterns, getCategoryPaths, clearEdits, type RowEdit } from './review/catalog-edit.js';
import { renderPatternsPage } from './review/patterns-page.js';
import { syncCategoryPaths } from './jobs/category-sync.js';
import { getClientSettings, setAutoEnrichImages, savePricingRules } from './lib/client-settings.js';
import { loadPricingRules } from './jobs/import-preview.js';
import { renderSettingsPage } from './review/settings-page.js';
import { randomUUID } from 'node:crypto';
import { oauthConfigFromEnv, squareAuthorizeUrl, exchangeCode } from './auth/square-oauth.js';
import { saveSquareAccount, getSquareConnection, loadSquareConfig } from './lib/square-account.js';
import { passwordLogin, refreshSession, signUp } from './auth/gotrue.js';
import { provisionTenant } from './auth/provision.js';
import { getUser, getSession, verifyAccessToken, ACCESS_COOKIE, REFRESH_COOKIE } from './auth/session.js';
import { resolveClientForUser, parseCookies } from './auth/tenant.js';
import { renderOnboardingPage } from './review/onboarding.js';

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

// Batch upload: pick many PDFs, queue each fast (compress + store), then work the /queue list.
const BATCH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Batch upload invoices</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:3rem auto;max-width:620px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  .drop{border:1px dashed #bbb;border-radius:8px;padding:2rem;text-align:center;background:#fafafa}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em} ul{color:#444;font-size:14px} a{color:#166534}
</style></head>
<body>
  <h2>Batch upload invoices</h2>
  <p>Pick several vendor PDFs. They're queued and extracted in the <strong>background</strong> — you can close this tab and come back to the queue as each is ready to review.</p>
  <div class="drop">
    <input type="file" id="f" accept="application/pdf" multiple>
    <div><button id="go" onclick="up()">Queue all</button></div>
  </div>
  <div id="status"></div>
  <ul id="list"></ul>
<script>
async function up(){
  var el=document.getElementById('f'), s=document.getElementById('status'), list=document.getElementById('list'), b=document.getElementById('go');
  if(!el.files||!el.files.length){ s.textContent='Pick some PDFs first.'; return; }
  b.disabled=true;
  var files=Array.prototype.slice.call(el.files), done=0;
  for(var i=0;i<files.length;i++){
    var file=files[i];
    var li=document.createElement('li'); li.textContent=file.name+' — queuing…'; list.appendChild(li);
    try{
      var buf=await file.arrayBuffer();
      var res=await fetch('/invoices/queue?filename='+encodeURIComponent(file.name),{method:'POST',headers:{'content-type':'application/pdf'},body:buf});
      var j=await res.json();
      if(res.ok){ done++; li.textContent=file.name+' — queued ✓'; }
      else { li.textContent=file.name+' — error: '+(j.error||res.status); }
    }catch(e){ li.textContent=file.name+' — error: '+e.message; }
    s.textContent='Queued '+done+'/'+files.length+'…';
  }
  s.innerHTML='Done — '+done+' queued and processing in the background. <a href="/queue">Open the review queue →</a>';
  b.disabled=false;
}
</script>
</body></html>`;

// Onboarding: a client uploads their current Square Item Library export (.xlsx). We parse it and
// seed catalog_mapping so future invoices reorder-match the existing catalog. Client-agnostic.
const LIBRARY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import existing library</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:3rem auto;max-width:640px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  ol{color:#555;font-size:14px;line-height:1.5}
  .drop{border:1px dashed #bbb;border-radius:8px;padding:2rem;text-align:center;background:#fafafa}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em} a{color:#166534}
  pre{margin-top:1rem;background:#0f1729;color:#dbe4ff;padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px;max-height:50vh}
</style></head>
<body>
  <h2>Import existing library</h2>
  <p>Seed Punctum from your current Square catalog so future invoices restock the right items instead of creating duplicates.</p>
  <ol>
    <li>In Square: <strong>Items &amp; Orders &rarr; Items &rarr; Actions &rarr; Export Library</strong>.</li>
    <li>Upload the <strong>.xlsx</strong> here. Items already in Square keep their catalog IDs; blank SKUs get a generated one.</li>
  </ol>
  <div class="drop">
    <input type="file" id="f" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
    <div><button id="go" onclick="up()">Import library</button></div>
  </div>
  <div id="status"></div>
  <pre id="out" hidden></pre>

  <h2 style="margin-top:2rem">Link to Square</h2>
  <p>After importing, match each seeded item to its live Square catalog id so reorders can add new variations to the existing item. Safe to run again any time.</p>
  <button id="sync" onclick="sync()">Link to Square catalog</button>
  <div id="syncstatus" style="margin-top:1rem;color:#333;min-height:1.2em"></div>
<script>
async function up(){
  var el=document.getElementById('f'), s=document.getElementById('status'), o=document.getElementById('out'), b=document.getElementById('go');
  if(!el.files||!el.files[0]){ s.textContent='Pick your Square library .xlsx first.'; return; }
  var f=el.files[0]; b.disabled=true; o.hidden=true; s.textContent='Reading '+f.name+' and seeding…';
  try{
    var buf=await f.arrayBuffer();
    var res=await fetch('/library/import?filename='+encodeURIComponent(f.name),{method:'POST',headers:{'content-type':'application/octet-stream'},body:buf});
    var j=await res.json();
    if(res.ok){
      s.innerHTML='Done — '+j.seeded+' items seeded ('+j.inserted+' new, '+j.updated+' updated); '+j.generatedSkus+' SKUs generated. Now click “Link to Square catalog” below.';
      o.hidden=false; o.textContent=JSON.stringify(j,null,2);
    } else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
async function sync(){
  var b=document.getElementById('sync'), s=document.getElementById('syncstatus');
  b.disabled=true; s.textContent='Listing the Square catalog and matching…';
  try{
    var res=await fetch('/library/sync',{method:'POST'});
    var j=await res.json();
    if(res.ok){ s.innerHTML='Linked '+j.updated+' of '+j.needing+' items to Square. <a href="/queue">Open the queue →</a>'; }
    else { s.textContent='Error: '+(j.error||res.status); }
  }catch(e){ s.textContent='Error: '+e.message; }
  b.disabled=false;
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
    var res=await fetch('/jobs/categories/provision',{method:'POST'});
    var j=await res.json();
    if(res.ok){ s.textContent='Done — created '+j.created+' categories. Re-run the preview to see your own category IDs.'; }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
</script>
</body></html>`;

// A/B compare page: upload a PDF, run both pipelines, show the classification diff.
const COMPARE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare pipelines (A/B)</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:820px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em}
  pre{margin-top:1rem;background:#0f1729;color:#dbe4ff;padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.45;max-height:70vh}
</style></head>
<body>
  <h2>Compare pipelines (A/B)</h2>
  <p>Runs <strong>both</strong> the current two-pass and the merged one-pass on one invoice PDF and diffs the classification — no writes. It makes three AI calls, so give it up to ~90 seconds.</p>
  <input type="file" id="f" accept="application/pdf">
  <div><button id="go" onclick="run()">Run comparison</button></div>
  <div id="status"></div>
  <pre id="out"></pre>
<script>
async function run(){
  var el=document.getElementById('f'), s=document.getElementById('status'), b=document.getElementById('go'), o=document.getElementById('out');
  if(!el.files||!el.files[0]){ s.textContent='Pick a PDF first.'; return; }
  var f=el.files[0]; b.disabled=true; o.textContent=''; s.textContent='Running both pipelines on '+f.name+' — up to ~90s…';
  try{
    var buf=await f.arrayBuffer();
    var res=await fetch('/compare?filename='+encodeURIComponent(f.name),{method:'POST',headers:{'content-type':'application/pdf'},body:buf});
    var j=await res.json();
    if(res.ok){ s.textContent='Done — '+j.criticalAgree+'/'+j.matched+' agree on catalog output, '+j.criticalDiffer+' differ ('+j.unmatched.twoPassOnly.length+'/'+j.unmatched.onePassOnly.length+' unmatched).'; o.textContent=JSON.stringify(j,null,2); }
    else { s.textContent='Error: '+(j.error||res.status); }
  }catch(e){ s.textContent='Error: '+e.message; }
  b.disabled=false;
}
</script>
</body></html>`;

// Deliberate trigger to push an approved invoice into Square (reads ?invoice=<id>).
const IMPORT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Push to Square</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:680px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  .warn{background:#fff8e1;border:1px solid #f2d98a;border-radius:6px;padding:.6rem .8rem;font-size:14px;color:#7a5b00}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em}
  pre{margin-top:1rem;background:#0f1729;color:#dbe4ff;padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px;max-height:60vh}
</style></head>
<body>
  <h2>Push invoice to Square</h2>
  <p>Creates or restocks this approved invoice's items in the connected Square sandbox, receives inventory, and records the SKU&rarr;Square mapping.</p>
  <div class="warn">This writes <strong>live</strong> to your Square sandbox.</div>
  <button id="go" onclick="run()">Push to Square</button>
  <div id="status"></div>
  <pre id="out"></pre>
<script>
async function run(){
  var invoice=new URLSearchParams(location.search).get('invoice');
  var s=document.getElementById('status');
  if(!invoice){ s.textContent='Add ?invoice=<id> to the URL first.'; return; }
  if(!confirm('Push this invoice to the Square sandbox? Creates/restocks items + inventory.')) return;
  var b=document.getElementById('go'), o=document.getElementById('out');
  b.disabled=true; s.textContent='Pushing to Square…';
  try{
    var res=await fetch('/jobs/import/run?invoice='+encodeURIComponent(invoice),{method:'POST'});
    var j=await res.json();
    if(res.ok){ s.textContent='Done — '+j.itemsCreated+' items created, '+j.variationsAdded+' variations added, '+j.variationsRestocked+' restocked, '+j.inventoryAdjusted+' inventory changes.'; o.textContent=JSON.stringify(j,null,2); }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
</script>
</body></html>`;

// Image enrichment: find a matching photo (SerpAPI + Vision) and attach it to each freshly
// imported variation. Slow, so it runs a bounded batch per click.
const IMAGES_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrich images</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:680px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  label{font-size:14px;color:#333}
  input[type=number]{width:5rem;font:inherit;padding:.2rem .4rem}
  .warn{background:#fff8e1;border:1px solid #f2d98a;border-radius:6px;padding:.6rem .8rem;font-size:14px;color:#7a5b00}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em}
  pre{margin-top:1rem;background:#0f1729;color:#dbe4ff;padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px;max-height:60vh}
</style></head>
<body>
  <h2>Enrich images</h2>
  <p>Finds a matching product photo for each newly imported variation (SerpAPI search &rarr; Claude Vision pick) and attaches it to the Square <strong>sandbox</strong> item. Variations that already have an image are skipped.</p>
  <div class="warn">Each item costs a SerpAPI + a Vision call. It runs in small safe chunks automatically until it reaches your number (or nothing's left) — no single request times out.</div>
  <p><label>How many to enrich this run: <input type="number" id="limit" value="50" min="1" max="1000"></label></p>
  <button id="go" onclick="run(false)">Enrich next batch</button>
  <button id="goall" onclick="run(true)" style="margin-left:.5rem;border-color:#2563eb;background:#2563eb">Enrich all remaining</button>
  <div id="status"></div>
  <pre id="out"></pre>
<script>
async function run(all){
  var b=document.getElementById('go'), ba=document.getElementById('goall'), s=document.getElementById('status'), o=document.getElementById('out');
  var target=all ? 1e9 : (parseInt(document.getElementById('limit').value,10)||10);
  var CHUNK=8; // keep each request well under the gateway timeout
  var tot={processed:0,enriched:0,noImage:0,skipped:0};
  b.disabled=true; ba.disabled=true;
  while(tot.processed<target){
    var lim=Math.min(CHUNK, target-tot.processed);
    s.textContent='Enriching… '+tot.enriched+' matched, '+tot.noImage+' no-match ('+tot.processed+(all?'':'/'+target)+')';
    var res, txt, j, attempt=0;
    while(true){
      try{ res=await fetch('/jobs/images/run?limit='+lim,{method:'POST'}); txt=await res.text(); break; }
      catch(e){
        attempt++;
        if(attempt>3){ s.textContent='Stopped: '+e.message+'. Finished items are saved — click to continue.'; b.disabled=false; ba.disabled=false; return; }
        s.textContent='Connection hiccup (e.g. a deploy) — retrying '+attempt+'/3… '+tot.processed+' done so far.';
        await new Promise(function(r){ setTimeout(r, attempt*3000); });
      }
    }
    try{ j=JSON.parse(txt); }catch(_){ s.textContent='Stopped: a batch hit the server timeout. Finished items are saved — click to continue.'; b.disabled=false; ba.disabled=false; return; }
    if(!res.ok){ s.textContent='Error: '+(j.error||res.status); b.disabled=false; ba.disabled=false; return; }
    if(j.disabled){ s.innerHTML='Auto-enrich is turned <strong>off</strong> for this studio. Turn it on in <a href="/settings">Settings</a>, or add photos manually.'; b.disabled=false; ba.disabled=false; return; }
    tot.processed+=j.processed; tot.enriched+=j.enriched; tot.noImage+=j.noImage; tot.skipped+=j.skipped;
    o.textContent=JSON.stringify(tot,null,2);
    if(j.processed===0){ s.textContent='All done — nothing left to enrich.'; b.disabled=false; ba.disabled=false; return; }
  }
  s.textContent='Done — '+tot.enriched+' matched, '+tot.noImage+' no-match, '+tot.skipped+' skipped ('+tot.processed+' processed).';
  b.disabled=false; ba.disabled=false;
}
</script>
</body></html>`;

// Danger button: wipe every item from the Square sandbox for a clean test re-run. Sandbox-only.
const WIPE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wipe sandbox catalog</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2rem auto;max-width:680px;color:#1a1a1a;padding:0 1rem}
  h2{margin:0 0 .5rem} p{color:#555}
  .warn{background:#fef2f2;border:1px solid #f3b4b4;border-radius:6px;padding:.6rem .8rem;font-size:14px;color:#991b1b}
  label{display:block;margin-top:1rem;font-size:14px}
  button{margin-top:1rem;padding:.6rem 1.2rem;border:1px solid #b91c1c;background:#b91c1c;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5;cursor:default}
  #status{margin-top:1rem;color:#333;min-height:1.2em}
  pre{margin-top:1rem;background:#0f1729;color:#dbe4ff;padding:1rem;border-radius:8px;overflow:auto;font-size:12.5px;max-height:60vh}
</style></head>
<body>
  <h2>Wipe sandbox catalog</h2>
  <p>Full clean slate for the connected Square <strong>sandbox</strong>: deletes <strong>all catalog items</strong> (with variations + inventory), clears Punctum's SKU&rarr;Square mapping, and empties the <strong>invoice queue</strong> (so <a href="/queue">/queue</a> starts fresh). Categories are left intact; booking/appointment items are skipped.</p>
  <div class="warn">Destructive and <strong>sandbox-only</strong> — it refuses to run if the connected Square account is production.</div>
  <label><input type="checkbox" id="ack"> I understand this deletes every item in the sandbox.</label>
  <button id="go" disabled onclick="run()">Wipe sandbox</button>
  <div id="status"></div>
  <pre id="out"></pre>
<script>
document.getElementById('ack').addEventListener('change',function(e){document.getElementById('go').disabled=!e.target.checked;});
async function run(){
  if(!confirm('Delete ALL items in the Square sandbox? This cannot be undone.')) return;
  var b=document.getElementById('go'), s=document.getElementById('status'), o=document.getElementById('out');
  b.disabled=true; s.textContent='Wiping sandbox catalog…';
  try{
    var res=await fetch('/jobs/sandbox/wipe',{method:'POST'});
    var j=await res.json();
    if(res.ok){ s.textContent='Done — deleted '+j.itemsDeleted+' of '+j.itemsFound+' items, cleared '+j.mappingsCleared+' mappings, '+j.invoicesCleared+' invoices ('+j.env+').'; o.textContent=JSON.stringify(j,null,2); }
    else { s.textContent='Error: '+(j.error||res.status); b.disabled=false; }
  }catch(e){ s.textContent='Error: '+e.message; b.disabled=false; }
}
</script>
</body></html>`;

// Home / links index — one bookmarkable page listing every Punctum page. Rendered per-session so
// the signed-in user + their tenant show up top, and this stays the living index as we build.
const escHome = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const renderHome = (sess: { email: string | null; clientId: string }): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:2.5rem auto;max-width:720px;color:#1a1a1a;padding:0 1.25rem}
  h1{margin:0 0 .25rem} .tag{color:#666;margin:0 0 1.75rem;font-size:14px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin:1.6rem 0 .5rem;border-bottom:1px solid #eee;padding-bottom:.3rem}
  h2.danger{color:#b91c1c}
  ul{list-style:none;margin:0;padding:0}
  li{padding:.5rem 0;border-bottom:1px solid #f3f4f6}
  a{color:#166534;font-weight:600;text-decoration:none;font-size:15px} a:hover{text-decoration:underline}
  .d{color:#555;font-size:13px;margin-top:2px}
  code{background:#f3f4f6;padding:.05rem .3rem;border-radius:4px;font-size:12px}
  .userbar{display:flex;justify-content:space-between;align-items:center;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:.5rem .8rem;font-size:13px;color:#374151;margin-bottom:1.25rem}
  .userbar a{color:#b91c1c;font-weight:600;font-size:13px}
</style></head>
<body>
  <div class="userbar"><span>Signed in as <strong>${escHome(sess.email ?? 'you')}</strong> &middot; tenant <code>${escHome(sess.clientId)}</code></span><a href="/logout">Log out</a></div>
  <h1>Punctum</h1>
  <p class="tag">Invoice &rarr; Square catalog automation</p>

  <h2>Invoices</h2>
  <ul>
    <li><a href="/invoices/batch">Batch upload</a><div class="d">Drop a stack of PDFs &mdash; they queue and extract in the background.</div></li>
    <li><a href="/invoices/new">Single upload</a><div class="d">Upload one invoice and go straight to its review page.</div></li>
    <li><a href="/queue">Review queue</a><div class="d">Every invoice by status; review &amp; approve as each becomes ready.</div></li>
  </ul>

  <h2>Catalog &amp; images</h2>
  <ul>
    <li><a href="/catalog">Catalog review &amp; edit</a><div class="d">Every variation &mdash; preview/replace images, and inline-edit name, price, category &amp; description, then push to Square.</div></li>
    <li><a href="/catalog/edits">Corrections &amp; patterns</a><div class="d">Recurring hand-edits surfaced as import-rule fixes (so the same fix isn't needed every invoice).</div></li>
    <li><a href="/jobs/images/run">Enrich images</a><div class="d">Find &amp; attach product photos to newly imported items (SerpAPI + Vision).</div></li>
  </ul>

  <h2>Setup &amp; checks</h2>
  <ul>
    <li><a href="/library/import">Import existing library</a><div class="d">Seed Punctum from a Square library export so reorders restock instead of duplicating (run once per client).</div></li>
    <li><a href="/jobs/categories/provision">Provision categories</a><div class="d">Create the category tree in the Square sandbox (run once on an empty sandbox).</div></li>
    <li><a href="/square/verify">Square connection check</a><div class="d">Confirm the Square token + location reach the sandbox.</div></li>
    <li><a href="/compare">Compare pipelines (A/B)</a><div class="d">Diff two-pass vs one-pass extraction on a PDF &mdash; no writes.</div></li>
  </ul>

  <h2>Advanced</h2>
  <ul>
    <li><a href="/jobs/import/run">Manual import / retry</a><div class="d">Re-push an approved invoice to Square &mdash; needs <code>?invoice=&lt;id&gt;</code>.</div></li>
  </ul>

  <h2>Account</h2>
  <ul>
    <li><a href="/settings">Settings</a><div class="d">Studio preferences &mdash; e.g. turn off image auto-enrichment if you supply your own photos.</div></li>
    <li><a href="/logout">Log out</a><div class="d">End your session and return to the sign-in page.</div></li>
    <li><a href="/whoami">Session info</a><div class="d">Your user id and current tenant (JSON).</div></li>
  </ul>

  <h2 class="danger">Danger zone</h2>
  <ul>
    <li><a href="/jobs/sandbox/wipe">Wipe sandbox</a><div class="d">Full clean slate: delete all catalog items + clear the invoice queue (sandbox-only).</div></li>
  </ul>
</body></html>`;

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#1a1a1a}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:2rem;width:320px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{margin:0 0 .25rem;font-size:22px} p{color:#6b7280;font-size:13px;margin:0 0 1.25rem}
  label{display:block;font-size:13px;color:#374151;margin:.6rem 0 .2rem}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.5rem .6rem;border:1px solid #d1d5db;border-radius:6px}
  button{width:100%;margin-top:1rem;padding:.6rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5}
  #err{color:#b91c1c;font-size:13px;min-height:1.2em;margin-top:.6rem}
</style></head>
<body>
  <form class="card" onsubmit="return signin(event)">
    <h1>Punctum</h1>
    <p>Sign in to your studio.</p>
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password" required>
    <button id="go" type="submit">Sign in</button>
    <div id="err"></div>
    <p style="margin:.9rem 0 0;font-size:13px;color:#6b7280;text-align:center">New studio? <a href="/signup" style="color:#166534;font-weight:600;text-decoration:none">Create an account</a></p>
  </form>
<script>
async function signin(e){
  e.preventDefault();
  var b=document.getElementById('go'), err=document.getElementById('err');
  b.disabled=true; err.textContent='';
  try{
    var res=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});
    var j=await res.json();
    if(res.ok){ location.href='/'; } else { err.textContent=j.error||'Sign in failed'; b.disabled=false; }
  }catch(ex){ err.textContent=ex.message; b.disabled=false; }
  return false;
}
</script>
</body></html>`;

const SIGNUP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create account &middot; Punctum</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#1a1a1a}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:2rem;width:320px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  h1{margin:0 0 .25rem;font-size:22px} p.sub{color:#6b7280;font-size:13px;margin:0 0 1.25rem}
  label{display:block;font-size:13px;color:#374151;margin:.6rem 0 .2rem}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.5rem .6rem;border:1px solid #d1d5db;border-radius:6px}
  button{width:100%;margin-top:1rem;padding:.6rem;border:1px solid #166534;background:#166534;color:#fff;border-radius:6px;cursor:pointer;font:inherit}
  button:disabled{opacity:.5}
  #err{color:#b91c1c;font-size:13px;min-height:1.2em;margin-top:.6rem}
  #ok{display:none;color:#166534;font-size:13px;margin-top:.6rem}
  .alt{margin:.9rem 0 0;font-size:13px;color:#6b7280;text-align:center}
  .alt a{color:#166534;font-weight:600;text-decoration:none}
</style></head>
<body>
  <form class="card" onsubmit="return signup(event)">
    <h1>Create your studio</h1>
    <p class="sub">Start turning vendor invoices into Square catalog updates.</p>
    <label for="studio">Studio name</label>
    <input id="studio" type="text" autocomplete="organization" required>
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="new-password" minlength="6" required>
    <button id="go" type="submit">Create account</button>
    <div id="err"></div>
    <div id="ok"></div>
    <p class="alt">Already have an account? <a href="/login">Sign in</a></p>
  </form>
<script>
async function signup(e){
  e.preventDefault();
  var b=document.getElementById('go'), err=document.getElementById('err'), ok=document.getElementById('ok');
  b.disabled=true; err.textContent=''; ok.style.display='none';
  try{
    var res=await fetch('/signup',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({studioName:document.getElementById('studio').value,email:document.getElementById('email').value,password:document.getElementById('pw').value})});
    var j=await res.json();
    if(res.ok){
      if(j.pending){ ok.textContent='Check your email to confirm your account, then sign in.'; ok.style.display='block'; b.disabled=false; }
      else { location.href=j.next||'/onboarding'; }
    } else { err.textContent=j.error||'Sign up failed'; b.disabled=false; }
  }catch(ex){ err.textContent=ex.message; b.disabled=false; }
  return false;
}
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', service: 'punctum' });
    return;
  }

  // --- Auth (Supabase). Login/logout are public; other routes get session-gated in a later step. ---
  if (url.pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    try {
      const raw = await readBodyBuffer(req);
      const { email, password } = JSON.parse(raw.toString('utf8') || '{}') as { email?: string; password?: string };
      if (!email || !password) {
        sendJson(res, 400, { error: 'email and password required' });
        return;
      }
      const t = await passwordLogin(email, password);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': [
          `${ACCESS_COOKIE}=${t.accessToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${t.expiresIn}`,
          `${REFRESH_COOKIE}=${t.refreshToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=2592000`,
        ],
      });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      sendJson(res, 401, { error: (err as Error).message });
    }
    return;
  }
  // Self-serve signup: create the Supabase user, provision a fresh tenant, and (when the project
  // auto-confirms) start a session and send them into onboarding.
  if (url.pathname === '/signup' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SIGNUP_PAGE);
    return;
  }
  if (url.pathname === '/signup' && req.method === 'POST') {
    try {
      const raw = await readBodyBuffer(req);
      const { email, password, studioName } = JSON.parse(raw.toString('utf8') || '{}') as {
        email?: string; password?: string; studioName?: string;
      };
      if (!email || !password || !studioName) {
        sendJson(res, 400, { error: 'studio name, email and password are required' });
        return;
      }
      const result = await signUp(email, password);
      if (!result.userId) {
        sendJson(res, 502, { error: 'sign up did not return a user' });
        return;
      }
      await provisionTenant(getPool() as unknown as Queryable, { userId: result.userId, studioName, email });
      if (result.tokens) {
        const t = result.tokens;
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': [
            `${ACCESS_COOKIE}=${t.accessToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${t.expiresIn}`,
            `${REFRESH_COOKIE}=${t.refreshToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=2592000`,
          ],
        });
        res.end(JSON.stringify({ ok: true, next: '/onboarding' }));
      } else {
        // Email confirmation is on: the tenant is provisioned, but there's no session until confirm.
        sendJson(res, 200, { ok: true, pending: true });
      }
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }
  if (url.pathname === '/logout') {
    res.writeHead(302, {
      location: '/login',
      'set-cookie': [
        `${ACCESS_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0`,
        `${REFRESH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=0`,
      ],
    });
    res.end();
    return;
  }
  // Who am I: verify the session cookie and show the user id + resolved tenant (or null). Handy for
  // seeding the first client_members row (grab your user id here after signing in).
  if (url.pathname === '/whoami' && req.method === 'GET') {
    try {
      const user = await getUser(req);
      if (!user) {
        sendJson(res, 200, { authenticated: false });
        return;
      }
      const clientId = await resolveClientForUser(getPool() as unknown as Queryable, user.userId);
      sendJson(res, 200, { authenticated: true, userId: user.userId, email: user.email, clientId });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // ---- Auth gate: everything below requires a signed-in session; scope is the user's tenant. ----
  const authDb = getPool() as unknown as Queryable;
  let session: Awaited<ReturnType<typeof getSession>> = await getSession(req, authDb).catch(() => null);
  // Access token expired but a refresh token is present -> silently rotate and set fresh cookies,
  // so sessions don't drop every ~hour.
  if (!session) {
    const refresh = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (refresh) {
      try {
        const t = await refreshSession(refresh);
        const user = await verifyAccessToken(t.accessToken);
        const clientId = user.userId ? await resolveClientForUser(authDb, user.userId) : null;
        if (clientId) {
          res.setHeader('set-cookie', [
            `${ACCESS_COOKIE}=${t.accessToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${t.expiresIn}`,
            `${REFRESH_COOKIE}=${t.refreshToken}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=2592000`,
          ]);
          session = { user, clientId };
        }
      } catch {
        /* refresh failed -> fall through to login */
      }
    }
  }
  if (!session) {
    if ((req.method ?? 'GET') === 'GET') {
      res.writeHead(302, { location: '/login' });
      res.end();
    } else {
      sendJson(res, 401, { error: 'not authenticated' });
    }
    return;
  }
  const authedClient = session.clientId; // replaces the old ?client=RE param (can't be spoofed)

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
    const client = authedClient;
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

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHome({ email: session.user.email, clientId: authedClient }));
    return;
  }

  // Onboarding wizard: derives its steps from live tenant state, so it's resumable.
  if (url.pathname === '/onboarding' && req.method === 'GET') {
    try {
      const db = getPool() as unknown as Queryable;
      const [conn, settings, cnt] = await Promise.all([
        getSquareConnection(db, authedClient),
        getClientSettings(db, authedClient),
        db.query(`select count(*)::int as n from catalog_mapping where client_id = $1`, [authedClient]),
      ]);
      const catalogCount = Number((cnt.rows[0] as { n: number } | undefined)?.n ?? 0);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderOnboardingPage({
        email: session.user.email, clientId: authedClient,
        squareConnected: conn.connected, catalogCount, pricingReviewed: settings.pricingReviewed,
      }));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Import dry-run: show exactly what an approved invoice WOULD push to Square (no writes).
  if (url.pathname === '/jobs/import/preview') {
    const invoiceId = url.searchParams.get('invoice');
    const client = authedClient;
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

  // Push an approved invoice to Square: GET serves the button, POST runs it (live writes).
  if (url.pathname === '/jobs/import/run') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(IMPORT_PAGE);
      return;
    }
    if (req.method === 'POST') {
      const invoiceId = url.searchParams.get('invoice');
      if (!invoiceId) {
        sendJson(res, 400, { error: "missing required query param: 'invoice'" });
        return;
      }
      try {
        const result = await runImport(getPool() as unknown as Queryable, invoiceId);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
  }

  // Catalog review: GET renders the catalog with inline matched images; POST rejects a bad one.
  if (url.pathname === '/catalog' && req.method === 'GET') {
    const client = authedClient;
    try {
      const pool = getPool() as unknown as Queryable;
      const [rows, categoryPaths] = await Promise.all([getCatalogRows(pool, client), getCategoryPaths(pool, client)]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderCatalogPage(rows, categoryPaths));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Per-client settings (auto-enrich toggle).
  if (url.pathname === '/settings' && req.method === 'GET') {
    try {
      const pool = getPool() as unknown as Queryable;
      const [s, pricing, conn] = await Promise.all([
        getClientSettings(pool, authedClient),
        loadPricingRules(pool, authedClient),
        getSquareConnection(pool, authedClient),
      ]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderSettingsPage(s, pricing, conn, url.searchParams.get('square')));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  if (url.pathname === '/settings' && req.method === 'POST') {
    try {
      const pool = getPool() as unknown as Queryable;
      const raw = await readBodyBuffer(req);
      const body = JSON.parse(raw.toString('utf8') || '{}') as {
        autoEnrichImages?: boolean;
        pricing?: {
          rules?: Array<{ metals?: unknown; vendors?: unknown; multiplier?: unknown }>;
          default?: number;
          roundTo?: number;
          exempt?: unknown;
        };
      };
      await setAutoEnrichImages(pool, authedClient, body.autoEnrichImages !== false);
      if (body.pricing) {
        const cur = await loadPricingRules(pool, authedClient);
        const p = body.pricing;
        const cleanList = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
        // Keep only well-formed rules (at least one condition + a positive multiplier).
        const rules = (Array.isArray(p.rules) ? p.rules : [])
          .map((r) => ({ metals: cleanList(r.metals), vendors: cleanList(r.vendors), multiplier: Number(r.multiplier) }))
          .filter((r) => (r.metals.length > 0 || r.vendors.length > 0) && Number.isFinite(r.multiplier) && r.multiplier > 0);
        const def = Number(p.default);
        const defaultMult = Number.isFinite(def) && def > 0 ? def : cur.default_multiplier ?? cur.multipliers.default;
        const roundTo = Number(p.roundTo);
        const next = {
          ...cur,
          multipliers: { gold: cur.multipliers?.gold ?? defaultMult, default: defaultMult },
          rounding: { op: 'ceil' as const, to_cents: Number.isFinite(roundTo) && roundTo > 0 ? Math.round(roundTo) : cur.rounding.to_cents },
          rules,
          default_multiplier: defaultMult,
          exempt_categories: cleanList(p.exempt),
        };
        await savePricingRules(pool, authedClient, next);
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Square OAuth: start -> set a CSRF state cookie and redirect the studio to Square to authorize.
  if (url.pathname === '/oauth/square/start' && req.method === 'GET') {
    try {
      const cfg = oauthConfigFromEnv();
      const state = randomUUID();
      res.writeHead(302, {
        location: squareAuthorizeUrl(cfg, state),
        'set-cookie': `sq_state=${state}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=600`,
      });
      res.end();
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Square OAuth: callback -> verify state, exchange code, read the merchant's location, store it.
  if (url.pathname === '/oauth/square/callback' && req.method === 'GET') {
    try {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const cookies = parseCookies(req.headers.cookie);
      if (!code || !state || state !== cookies.sq_state) {
        res.writeHead(302, { location: '/settings?square=error' });
        res.end();
        return;
      }
      const cfg = oauthConfigFromEnv();
      const tokens = await exchangeCode(cfg, code);
      let locationId: string | null = null;
      try {
        const locs = await listLocations({ token: tokens.accessToken, env: cfg.env, locationId: '' });
        locationId = locs[0]?.id ?? null;
      } catch {
        /* connect still succeeds; location can be re-synced later */
      }
      await saveSquareAccount(getPool() as unknown as Queryable, authedClient, cfg.env, tokens, locationId);
      res.writeHead(302, { location: '/settings?square=connected', 'set-cookie': 'sq_state=; Path=/; Max-Age=0' });
      res.end();
    } catch {
      res.writeHead(302, { location: '/settings?square=error' });
      res.end();
    }
    return;
  }

  // Learning-loop report: recurring corrections that point at import-rule fixes.
  if (url.pathname === '/catalog/edits' && req.method === 'GET') {
    const client = authedClient;
    try {
      const report = await getEditPatterns(getPool() as unknown as Queryable, client);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPatternsPage(report));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Backfill category_path from the live Square catalog (populate the grid's category defaults).
  if (url.pathname === '/catalog/sync-categories' && req.method === 'POST') {
    const client = authedClient;
    try {
      sendJson(res, 200, await syncCategoryPaths(getPool() as unknown as Queryable, client));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Reset the correction log (advisory only — clears test edits from the patterns report).
  if (url.pathname === '/catalog/edits/clear' && req.method === 'POST') {
    const client = authedClient;
    try {
      sendJson(res, 200, await clearEdits(getPool() as unknown as Queryable, client));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Batch item edits: push changed fields to Square, log corrections, update the mapping.
  if (url.pathname === '/catalog/edits' && req.method === 'POST') {
    const client = authedClient;
    try {
      const raw = await readBodyBuffer(req);
      const parsed = JSON.parse(raw.toString('utf8') || '{}') as { edits?: RowEdit[] };
      const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
      const result = await applyEdits(getPool() as unknown as Queryable, client, edits);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Review-alternatives: read the stored candidate pool for a variation.
  if (url.pathname === '/catalog/candidates' && req.method === 'GET') {
    const client = authedClient;
    const seq = url.searchParams.get('seq');
    if (!seq) {
      sendJson(res, 400, { error: "missing required query param: 'seq'" });
      return;
    }
    try {
      sendJson(res, 200, await getCandidates(getPool() as unknown as Queryable, client, seq));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Replace a variation's image with a chosen candidate.
  if (url.pathname === '/catalog/set-image' && req.method === 'POST') {
    const client = authedClient;
    const seq = url.searchParams.get('seq');
    const imageUrl = url.searchParams.get('url');
    const thumbUrl = url.searchParams.get('thumb') ?? '';
    if (!seq || !imageUrl) {
      sendJson(res, 400, { error: "missing required query params: 'seq' and 'url'" });
      return;
    }
    try {
      const result = await setVariationImage(getPool() as unknown as Queryable, client, seq, imageUrl, thumbUrl);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }
  // Promote a variation's image to its item's primary (grid) image.
  if (url.pathname === '/catalog/set-item-image' && req.method === 'POST') {
    const client = authedClient;
    const seq = url.searchParams.get('seq');
    if (!seq) {
      sendJson(res, 400, { error: "missing required query param: 'seq'" });
      return;
    }
    try {
      const result = await setItemImageFromRow(getPool() as unknown as Queryable, client, seq);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Upload the studio's own photo (raw image bytes) to a variation; ?setItem=1 also promotes it.
  if (url.pathname === '/catalog/upload-image' && req.method === 'POST') {
    const client = authedClient;
    const seq = url.searchParams.get('seq');
    if (!seq) {
      sendJson(res, 400, { error: "missing required query param: 'seq'" });
      return;
    }
    try {
      const bytes = await readBodyBuffer(req);
      const contentType = req.headers['content-type'] ?? 'application/octet-stream';
      const result = await uploadVariationImage(
        getPool() as unknown as Queryable,
        client,
        seq,
        { bytes, contentType },
        { setItem: url.searchParams.get('setItem') === '1' },
      );
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Upload the studio's own photo as the ITEM's primary (grid) image (item detail page).
  if (url.pathname === '/catalog/upload-item-image' && req.method === 'POST') {
    const client = authedClient;
    const itemId = url.searchParams.get('item');
    if (!itemId) {
      sendJson(res, 400, { error: "missing required query param: 'item'" });
      return;
    }
    try {
      const bytes = await readBodyBuffer(req);
      const contentType = req.headers['content-type'] ?? 'application/octet-stream';
      const result = await uploadItemImage(getPool() as unknown as Queryable, client, itemId, { bytes, contentType });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Clear the item's own primary image (item detail page).
  if (url.pathname === '/catalog/clear-item-image' && req.method === 'POST') {
    const client = authedClient;
    const itemId = url.searchParams.get('item');
    if (!itemId) {
      sendJson(res, 400, { error: "missing required query param: 'item'" });
      return;
    }
    try {
      const result = await clearItemImageForItem(getPool() as unknown as Queryable, client, itemId);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Item detail page: one product, its variations, and per-variation photo upload.
  const itemParts = url.pathname.split('/').filter(Boolean);
  if (itemParts[0] === 'items' && itemParts.length === 2 && req.method === 'GET') {
    try {
      const itemId = decodeURIComponent(itemParts[1]!);
      const item = await getItemDetail(getPool() as unknown as Queryable, authedClient, itemId);
      if (!item) {
        sendJson(res, 404, { error: 'item not found' });
        return;
      }
      // The item's true primary image (may be an item-only upload not tied to any variation).
      // Best-effort: a Square hiccup just falls back to the variation-derived hero in the renderer.
      let itemImageUrl = '';
      try {
        const cfg = await loadSquareConfig(getPool() as unknown as Queryable, authedClient);
        itemImageUrl = await getItemImageUrl(cfg, itemId);
      } catch {
        /* fall back to variation-derived hero */
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderItemPage(item, itemImageUrl));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Variation detail page: one SKU — variation-level fields + photo controls.
  if (itemParts[0] === 'variations' && itemParts.length === 2 && req.method === 'GET') {
    try {
      const v = await getVariationDetail(getPool() as unknown as Queryable, authedClient, decodeURIComponent(itemParts[1]!));
      if (!v) {
        sendJson(res, 404, { error: 'variation not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderVariationPage(v));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Clear a variation's image (none of the candidates fit).
  if (url.pathname === '/catalog/clear-image' && req.method === 'POST') {
    const client = authedClient;
    const seq = url.searchParams.get('seq');
    if (!seq) {
      sendJson(res, 400, { error: "missing required query param: 'seq'" });
      return;
    }
    try {
      const result = await clearVariationImage(getPool() as unknown as Queryable, client, seq);
      sendJson(res, result.ok ? 200 : 404, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Image enrichment: GET serves the button, POST runs a bounded batch (SerpAPI + Vision + attach).
  if (url.pathname === '/jobs/images/run') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(IMAGES_PAGE);
      return;
    }
    if (req.method === 'POST') {
      const client = authedClient;
      const limit = Number(url.searchParams.get('limit')) || 10;
      try {
        const result = await enrichImages(getPool() as unknown as Queryable, client, { limit });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
  }

  // Wipe the Square sandbox catalog for a clean re-run: GET serves the button, POST does it.
  if (url.pathname === '/jobs/sandbox/wipe') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(WIPE_PAGE);
      return;
    }
    if (req.method === 'POST') {
      const client = authedClient;
      try {
        const result = await wipeSandboxCatalog(getPool() as unknown as Queryable, client);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
  }

  // A/B: GET /compare serves the page; POST /compare runs both pipelines and diffs them.
  if (url.pathname === '/compare') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(COMPARE_PAGE);
      return;
    }
    if (req.method === 'POST') {
      try {
        const pdf = await readBodyBuffer(req);
        if (pdf.length === 0) {
          sendJson(res, 400, { error: 'empty upload' });
          return;
        }
        const filename = url.searchParams.get('filename') ?? undefined;
        const result = await runComparison(pdf.toString('base64'));
        sendJson(res, 200, { file: filename, ...result });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }
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
      const client = authedClient;
      try {
        const cfg = await loadSquareConfig(getPool() as unknown as Queryable, client);
        const result = await provisionCategories(cfg, getPool() as unknown as Queryable, client);
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
      const cfg = await loadSquareConfig(getPool() as unknown as Queryable, authedClient);
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
      const client = authedClient;
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

  // Batch upload: GET /invoices/batch serves the multi-file form; POST /invoices/queue queues one.
  if (url.pathname === '/invoices/batch' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(BATCH_PAGE);
    return;
  }
  if (url.pathname === '/invoices/queue' && req.method === 'POST') {
    try {
      const pdf = await readBodyBuffer(req);
      if (pdf.length === 0) {
        sendJson(res, 400, { error: 'empty upload' });
        return;
      }
      const client = authedClient;
      const filename = url.searchParams.get('filename') ?? undefined;
      const result = await queueInvoice(getPool() as unknown as Queryable, client, {
        pdfBase64: pdf.toString('base64'),
        filename,
      });
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Onboarding: GET serves the upload form; POST parses a Square library .xlsx and seeds mappings.
  if (url.pathname === '/library/import' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LIBRARY_PAGE);
    return;
  }
  if (url.pathname === '/library/import' && req.method === 'POST') {
    try {
      const buf = await readBodyBuffer(req);
      if (buf.length === 0) {
        sendJson(res, 400, { error: 'empty upload' });
        return;
      }
      const client = authedClient;
      const rows = parseSquareLibraryXlsx(buf);
      if (rows.length === 0) {
        sendJson(res, 400, { error: 'no rows found — is this a Square Item Library export?' });
        return;
      }
      const result = await seedLibrary(getPool() as unknown as Queryable, client, rows);
      sendJson(res, 200, { parsed: rows.length, ...result });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Backfill square_item_id on seeded rows by matching against the live Square catalog.
  if (url.pathname === '/library/sync' && req.method === 'POST') {
    const client = authedClient;
    try {
      const result = await syncLibraryItemIds(getPool() as unknown as Queryable, client);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Re-queue every errored invoice that still has its PDF (worker retries them).
  if (url.pathname === '/queue/retry' && req.method === 'POST') {
    const client = authedClient;
    try {
      const result = await requeueErrored(getPool() as unknown as Queryable, client);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Bulk approve: flip selected in_review invoices to importing and fire their pushes. runImport is
  // serialized (withImportLock), so N approvals push one-at-a-time — no concurrent "catalog locked".
  if (url.pathname === '/queue/approve' && req.method === 'POST') {
    const client = authedClient;
    try {
      const raw = await readBodyBuffer(req);
      const { ids } = JSON.parse(raw.toString('utf8') || '{}') as { ids?: string[] };
      const list = Array.isArray(ids) ? ids : [];
      const pool = getPool() as unknown as Queryable;
      const { approvedIds, skipped } = await bulkApproveInvoices(pool, client, list);
      for (const id of approvedIds) void runImport(pool, id).catch(() => {}); // serialized in runImport
      sendJson(res, 200, { approved: approvedIds.length, skipped });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Review queue: every invoice with its status + a Review link once ready.
  if (url.pathname === '/queue' && req.method === 'GET') {
    const client = authedClient;
    try {
      const rows = await getQueueRows(getPool() as unknown as Queryable, client);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderQueuePage(rows));
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // Read-only review UI over invoice_lines: /invoices/:id/{review,approve,reject}
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'invoices' && parts.length === 3) {
    const [, invoiceId, action] = parts;

    // Tenant ownership guard: an invoice is only reachable by its own tenant (else 404, so a bad
    // id or another studio's id looks identical). Invalid uuid -> caught -> 404.
    let owned = false;
    try {
      const own = await authDb.query(`select 1 from invoices where id = $1 and client_id = $2`, [invoiceId, authedClient]);
      owned = own.rows.length > 0;
    } catch {
      owned = false;
    }
    if (!owned) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Serve the stored source PDF for the review panel.
    if (action === 'pdf' && req.method === 'GET') {
      try {
        const pool = getPool() as unknown as Queryable;
        const q = await pool.query(`select encode(pdf_bytes, 'base64') as pdf_b64 from invoices where id = $1`, [invoiceId]);
        const b64 = (q.rows[0] as { pdf_b64: string | null } | undefined)?.pdf_b64;
        if (!b64) {
          sendJson(res, 404, { error: 'no pdf for this invoice' });
          return;
        }
        const bytes = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-length': String(bytes.length),
          'content-disposition': 'inline',
          'cache-control': 'private, max-age=300',
        });
        res.end(bytes);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return;
    }

    try {
      const pool = getPool() as unknown as Queryable;
      // On approve, the review page POSTs the line ids the operator excluded from the push.
      let excludedLineIds: string[] | undefined;
      if ((req.method ?? 'GET') === 'POST' && action === 'approve') {
        try {
          const raw = await readBodyBuffer(req);
          const b = JSON.parse(raw.toString('utf8') || '{}') as { excluded?: string[] };
          excludedLineIds = Array.isArray(b.excluded) ? b.excluded : [];
        } catch {
          excludedLineIds = [];
        }
      }
      const result = await handleReview(
        pool,
        req.method ?? 'GET',
        invoiceId,
        action,
        async (id) => {
          // Mark 'importing' synchronously so the redirect shows it, then push to Square in the
          // BACKGROUND — the operator is redirected immediately and can move on while it runs.
          // The import is idempotent; on failure the invoice lands 'error' (retry from import page).
          await pool.query(`update invoices set status = 'importing', updated_at = now() where id = $1`, [id]);
          void runImport(pool, id).catch(() => {});
        },
        excludedLineIds,
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
  // Background worker drains the batch-upload queue (only when a DB is configured).
  if (process.env.DATABASE_URL) {
    try {
      startWorker(getPool() as unknown as Queryable);
      console.log('batch worker started');
      // Re-run any Square push orphaned by a restart mid-import (invoice stuck 'importing').
      void recoverStuckImports(getPool() as unknown as Queryable)
        .then((r) => {
          if (r.recovered.length) console.log(`recovered ${r.recovered.length} stuck import(s)`);
        })
        .catch(() => {});
    } catch (err) {
      console.error('batch worker failed to start:', (err as Error).message);
    }
  }
});
