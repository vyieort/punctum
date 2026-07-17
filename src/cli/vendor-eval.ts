// Vendor-profile eval harness (#42): run one real invoice PDF through extraction TWICE — once with
// no vendor hints (baseline) and once with a vendor's profile injected — and diff the two, so you
// can see exactly what a profile changes on a KNOWN vendor before trusting it on new ones.
//
// Needs ANTHROPIC_API_KEY (real model call, ×2). Hints come from a file OR a stored vendor profile.
//
//   npm run vendor:eval -- --pdf ./invoice.pdf --hints-file ./anatometal.hints.txt
//   npm run vendor:eval -- --pdf ./invoice.pdf --vendor "Anatometal"        (uses the DB profile)
//   npm run vendor:eval -- --pdf ./invoice.pdf --hints-file ./h.txt --out ./evalout

import { readFileSync, writeFileSync } from 'node:fs';
import { extractAndClassify } from '../lib/merged.js';
import { diffExtractions, formatExtractionDiff } from '../lib/extraction-diff.js';
import { loadVendorHints } from '../lib/vendor-profile.js';
import type { Queryable } from '../jobs/pg-rows.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const pdfPath = arg('--pdf');
  if (!pdfPath) throw new Error('usage: --pdf <path> [--hints-file <path> | --vendor <name>] [--out <dir>]');
  const hintsFile = arg('--hints-file');
  const vendor = arg('--vendor');
  const outDir = arg('--out') ?? '.';

  let hints = '';
  if (hintsFile) {
    hints = readFileSync(hintsFile, 'utf8');
  } else if (vendor) {
    const { getPool } = await import('../db/pool.js'); // only touch the DB when a stored profile is asked for
    hints = await loadVendorHints(getPool() as unknown as Queryable, vendor);
    if (!hints) throw new Error(`no stored profile for vendor "${vendor}" (or it has no guidance yet)`);
  } else {
    throw new Error('provide --hints-file <path> or --vendor <name>');
  }

  const pdfB64 = readFileSync(pdfPath).toString('base64');
  process.stderr.write(`Extracting baseline (no hints)…\n`);
  const baseline = await extractAndClassify(pdfB64);
  process.stderr.write(`Extracting with vendor hints (${hints.trim().length} chars)…\n`);
  const hinted = await extractAndClassify(pdfB64, {}, hints);

  const diff = diffExtractions(baseline, hinted);
  process.stdout.write('\n' + formatExtractionDiff(diff) + '\n');

  writeFileSync(`${outDir}/eval-baseline.json`, JSON.stringify(baseline, null, 2));
  writeFileSync(`${outDir}/eval-hinted.json`, JSON.stringify(hinted, null, 2));
  process.stderr.write(`\nWrote eval-baseline.json + eval-hinted.json to ${outDir}\n`);
}

main().catch((e) => {
  process.stderr.write(`vendor-eval failed: ${(e as Error).message}\n`);
  process.exit(1);
});
