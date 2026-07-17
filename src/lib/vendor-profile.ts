// Shared vendor parsing profiles (#42 engine). A vendor's accumulated hints — keyed by vendor, not
// client — get rendered into a prompt fragment and injected into the extraction call, so extraction
// improves as studios confirm/correct invoices. This is how vendor knowledge moves out of the one
// hardcoded extraction prompt and into data that any client's onboarding can grow.

import type { Queryable } from '../jobs/pg-rows.js';

export interface VendorExample {
  before?: string; // the raw invoice line (or the model's reading)
  after?: string; // the corrected reading
  note?: string;
}

export interface VendorProfile {
  vendorKey: string;
  displayName: string;
  guidance: string;
  examples: VendorExample[];
  sampleCount: number;
  status: string;
}

/** Normalize a vendor name to its shared key (lowercase slug), e.g. "People's Jewelry" -> "people-s-jewelry". */
export function normalizeVendorKey(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function parseExamples(raw: unknown): VendorExample[] {
  const val = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(val) ? (val as VendorExample[]) : [];
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

export async function getVendorProfile(db: Queryable, vendorName: string): Promise<VendorProfile | null> {
  const key = normalizeVendorKey(vendorName);
  if (!key) return null;
  const { rows } = await db.query(
    `select vendor_key, display_name, guidance, examples, sample_count, status
       from vendor_profiles where vendor_key = $1`,
    [key],
  );
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    vendorKey: String(r.vendor_key),
    displayName: String(r.display_name ?? ''),
    guidance: String(r.guidance ?? ''),
    examples: parseExamples(r.examples),
    sampleCount: Number(r.sample_count ?? 0),
    status: String(r.status ?? 'active'),
  };
}

/** Create or refine a vendor profile. Merges guidance/examples when provided; only touches fields
 *  passed in. `incSample` bumps the count (one more invoice confirmed for this vendor). */
export async function upsertVendorProfile(
  db: Queryable,
  input: { vendorName: string; displayName?: string; guidance?: string; examples?: VendorExample[]; incSample?: boolean; status?: string },
): Promise<VendorProfile> {
  const key = normalizeVendorKey(input.vendorName);
  if (!key) throw new Error('upsertVendorProfile: vendor name required');
  const display = input.displayName ?? input.vendorName;
  await db.query(
    `insert into vendor_profiles (vendor_key, display_name, guidance, examples, sample_count, status)
       values ($1, $2, coalesce($3, ''), coalesce($4::jsonb, '[]'::jsonb), $5, coalesce($6, 'active'))
     on conflict (vendor_key) do update set
       display_name = excluded.display_name,
       guidance     = coalesce($3, vendor_profiles.guidance),
       examples     = coalesce($4::jsonb, vendor_profiles.examples),
       sample_count = vendor_profiles.sample_count + $5,
       status       = coalesce($6, vendor_profiles.status),
       updated_at   = now()`,
    [
      key,
      display,
      input.guidance ?? null,
      input.examples ? JSON.stringify(input.examples) : null,
      input.incSample ? 1 : 0,
      input.status ?? null,
    ],
  );
  const p = await getVendorProfile(db, key);
  if (!p) throw new Error('upsertVendorProfile: profile vanished after write');
  return p;
}

/** Render a profile into a prompt fragment to inject into extraction; '' when there's nothing useful. */
export function renderVendorHints(profile: VendorProfile | null): string {
  if (!profile || profile.status === 'disabled') return '';
  const guidance = profile.guidance.trim();
  const examples = profile.examples.filter((e) => (e.before ?? '') || (e.after ?? ''));
  if (!guidance && examples.length === 0) return '';

  let out = `VENDOR-SPECIFIC GUIDANCE for ${profile.displayName} (learned from prior invoices — apply IN ADDITION to the general rules; if it conflicts, prefer the general rules):`;
  if (guidance) out += `\n${guidance}`;
  if (examples.length) {
    out +=
      `\nWorked examples (raw line => correct reading):\n` +
      examples.slice(0, 12).map((e) => `- ${e.before ?? ''} => ${e.after ?? ''}${e.note ? ` (${e.note})` : ''}`).join('\n');
  }
  return out;
}

/** Load + render a vendor's hint fragment in one call (or '' if no profile). */
export async function loadVendorHints(db: Queryable, vendorName: string): Promise<string> {
  return renderVendorHints(await getVendorProfile(db, vendorName));
}
