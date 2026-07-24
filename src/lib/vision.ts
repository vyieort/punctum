// Claude Vision image scorer. Ported from Sc3 (5330175) modules 5-7.
//
// Shows Vision the candidate thumbnails and asks which best matches the product. A match only
// counts when confidence >= 5 — that threshold is the accuracy gate that keeps wrong images
// out of the catalog (a weak match becomes NO_IMAGE, not a bad photo).

import { anthropicText, type AnthropicOptions } from './anthropic.js';
import type { ImageCandidate } from './serpapi.js';

// Image-match model (separate task from invoice text). Override with VISION_MODEL to roll back.
export const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-5';
export const VISION_MAX_TOKENS = 200;
export const MIN_CONFIDENCE = 5;

export interface VisionScore {
  match: number; // 1..N, or 0 for none
  confidence: number; // 1..10
  reason: string;
}

export interface VisionResult extends VisionScore {
  action: 'ENRICHED' | 'NO_IMAGE';
  imageUrl: string; // pushUrl of the chosen candidate, '' when none
  thumbUrl: string; // gstatic thumbnail of the chosen candidate (reliable image fallback)
}

const LBAR_RE = /nostril nail|l-?bar|nose stud|nose bone|nostril screw/i;
const LBAR_HINT =
  '\n\nNOTE: an L-bar / nostril nail is a small NOSE stud with an L-shaped or open-hook post (it can look like a tiny open hoop). It is nose jewelry, not a finger ring — match it to nostril nails / L-shaped nose studs; do NOT reject these as "rings".';

/** Build the Vision message content: candidate thumbnails followed by the scoring prompt. */
export function buildVisionMessage(productInfo: string, candidates: ImageCandidate[]): unknown[] {
  const content: unknown[] = candidates.map((c) => ({
    type: 'image',
    source: { type: 'url', url: c.thumb },
  }));
  const hint = LBAR_RE.test(productInfo) ? LBAR_HINT : '';
  const text =
    `${productInfo}\n\n` +
    `Above are candidate images numbered 1-${candidates.length}. Which image best matches this product? ` +
    `Consider shape, setting type, stone, and metal color.${hint}\n\n` +
    `Return ONLY valid JSON: {"match": <1-${candidates.length} or 0 if none>, "confidence": <1-10>, "reason": "brief explanation"}`;
  content.push({ type: 'text', text });
  return content;
}

export function parseVisionScore(text: string): VisionScore {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const json = start !== -1 && end > start ? text.slice(start, end + 1) : text;
  const p = JSON.parse(json) as Partial<VisionScore>;
  return {
    match: Number(p.match ?? 0) || 0,
    confidence: Number(p.confidence ?? 0) || 0,
    reason: String(p.reason ?? ''),
  };
}

/** Ask Vision to pick the best candidate; returns ENRICHED (with imageUrl) or NO_IMAGE. */
export async function scoreImages(
  productInfo: string,
  candidates: ImageCandidate[],
  opts: AnthropicOptions = {},
): Promise<VisionResult> {
  if (candidates.length === 0) {
    return { match: 0, confidence: 0, reason: 'no candidates', action: 'NO_IMAGE', imageUrl: '', thumbUrl: '' };
  }
  const text = await anthropicText(
    { system: '', model: VISION_MODEL, maxTokens: VISION_MAX_TOKENS, messages: [{ role: 'user', content: buildVisionMessage(productInfo, candidates) }] },
    opts,
  );
  const score = parseVisionScore(text);
  const chosen = score.match >= 1 && score.match <= candidates.length ? candidates[score.match - 1] : undefined;
  const rawUrl = chosen?.pushUrl ?? '';
  const action: 'ENRICHED' | 'NO_IMAGE' =
    score.match > 0 && score.confidence >= MIN_CONFIDENCE && rawUrl ? 'ENRICHED' : 'NO_IMAGE';
  return {
    ...score,
    action,
    imageUrl: action === 'ENRICHED' ? rawUrl : '',
    thumbUrl: action === 'ENRICHED' ? (chosen?.thumb ?? '') : '',
  };
}
