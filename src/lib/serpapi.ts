// SerpAPI google_images search + candidate selection. Ported from Sc3 (5330175) module 5.
//
// Vision is shown the gstatic `thumbnail` (always https + hotlink-friendly + cheap); the URL
// we later push to Square is the full-res `original`, falling back to the thumbnail when the
// original is missing, a .webp (Square rejects webp), or on a hotlink-blocking domain.

export interface ImageCandidate {
  thumb: string; // shown to Vision
  pushUrl: string; // downloaded + uploaded to Square if chosen
  domain: string;
}

export interface SerpApiOptions {
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
}

const BLOCKED = ['ebay', 'tiffany', 'pinimg', 'redd', 'etsystatic', 'amazon', 'squarespace-cdn', 'jtv'];
const LAST_RESORT = ['diablobodyjewelry.com'];
const HOTLINK_BLOCKED = ['bvla.com', 'instagram.com', 'fbsbx.com', 'banter.com', 'edgesuite.net'];

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchList(list: string[], url: string, domain: string): boolean {
  const u = (url || '').toLowerCase();
  return list.some((d) => domain.includes(d) || u.includes(d));
}

function pushUrlFor(orig: string, thumb: string, domain: string): string {
  let url: string;
  if (!orig) url = thumb;
  else if (orig.toLowerCase().includes('.webp')) url = thumb;
  else if (matchList(HOTLINK_BLOCKED, orig, domain)) url = thumb;
  else url = orig;
  return (url || '').replace(/^http:\/\//i, 'https://');
}

interface SerpImageResult {
  original?: string;
  thumbnail?: string;
  link?: string;
  source?: string;
}

/** Filter + order candidates: junk domains dropped, top 6 by relevance + 1 last-resort. */
export function selectCandidates(imagesResults: SerpImageResult[]): ImageCandidate[] {
  const good: ImageCandidate[] = [];
  const lastResort: ImageCandidate[] = [];
  for (const r of imagesResults ?? []) {
    const orig = r.original ?? '';
    const thumb = r.thumbnail ?? '';
    if (!thumb && !orig) continue;
    const domain = domainOf(orig || thumb || r.link || '');
    if (matchList(BLOCKED, orig || thumb, domain)) continue;
    const cand: ImageCandidate = { thumb: thumb || orig, pushUrl: pushUrlFor(orig, thumb, domain), domain };
    if (matchList(LAST_RESORT, orig || thumb, domain)) lastResort.push(cand);
    else good.push(cand);
  }
  return good.length ? good.slice(0, 6).concat(lastResort.slice(0, 1)) : lastResort.slice(0, 5);
}

/** Run a google_images search and return filtered candidates (empty on no results). */
export async function searchImages(query: string, opts: SerpApiOptions = {}): Promise<ImageCandidate[]> {
  const apiKey = opts.apiKey ?? process.env.SERP_API_KEY;
  if (!apiKey) throw new Error('SERP_API_KEY is not set');
  const base = opts.baseUrl ?? 'https://serpapi.com/search.json';
  const params = new URLSearchParams({
    engine: 'google_images',
    q: query,
    safe: 'off',
    api_key: apiKey,
    location: 'United States',
  });
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(`${base}?${params.toString()}`);
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  const body = (await res.json()) as { images_results?: SerpImageResult[] };
  return selectCandidates(body.images_results ?? []);
}
