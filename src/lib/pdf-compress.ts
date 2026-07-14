// Downsample oversized invoice PDFs before the AI call.
//
// Vendor invoices are often photographed/scanned at very high resolution (a NeoMetal scan
// runs ~20MB for 6 pages). Sent as base64 to the model, that payload is slow enough to blow
// the gateway timeout (a 502). Ghostscript's /ebook preset re-samples embedded images to
// ~150dpi — plenty to read line items — taking that 20MB down to ~1.3MB while leaving any
// text layer intact. If Ghostscript is missing or the result isn't smaller, we return the
// original untouched, so this can never make an upload fail.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/** Only bother compressing PDFs larger than this (bytes). Working invoices sit ~4MB. */
export const COMPRESS_THRESHOLD_BYTES = 5 * 1024 * 1024;

export interface CompressResult {
  base64: string;
  compressed: boolean;
  beforeBytes: number;
  afterBytes: number;
}

/** Approximate decoded byte length of a base64 string without allocating the buffer. */
function base64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Return a smaller base64 PDF when the input is large and Ghostscript is available; otherwise
 * return the input unchanged. Never throws — a compression failure falls back to the original.
 */
export async function maybeCompressPdf(base64: string): Promise<CompressResult> {
  const beforeBytes = base64Bytes(base64);
  if (beforeBytes <= COMPRESS_THRESHOLD_BYTES) {
    return { base64, compressed: false, beforeBytes, afterBytes: beforeBytes };
  }

  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'punctum-pdf-'));
    const inPath = join(dir, 'in.pdf');
    const outPath = join(dir, 'out.pdf');
    await writeFile(inPath, Buffer.from(base64, 'base64'));
    await execFileP(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dPDFSETTINGS=/ebook',
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        `-sOutputFile=${outPath}`,
        inPath,
      ],
      { timeout: 120_000 },
    );
    const out = await readFile(outPath);
    if (out.length > 0 && out.length < beforeBytes) {
      return { base64: out.toString('base64'), compressed: true, beforeBytes, afterBytes: out.length };
    }
    return { base64, compressed: false, beforeBytes, afterBytes: beforeBytes };
  } catch {
    return { base64, compressed: false, beforeBytes, afterBytes: beforeBytes };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
