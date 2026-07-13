// Invoice-line classification (Sc2 module 56).
//
// The second Claude pass: takes extracted line items and classifies each into the
// structured fields (product_type, setting, gauge, item_name, variation_name, metal, …)
// that drive grouping, pricing, and categorization. Input is one pipe-delimited row per
// line; output is {"items":[...]}.

import { anthropicText, type AnthropicOptions } from './anthropic.js';
import { CLASSIFY_PROMPT, CLASSIFY_MODEL, CLASSIFY_MAX_TOKENS, CLASSIFY_USER_PREFIX } from './classify-prompt.js';

export interface ClassifierLineInput {
  vendor: string;
  sku: string;
  description: string;
  qty: string | number;
  price: string | number;
  gems: string;
  notes: string;
}

export interface ClassifiedItem {
  vendor: string;
  sku: string;
  description: string;
  qty: string;
  price: string;
  product_type: string;
  thread_type: string;
  setting: string;
  stone_type: string;
  stone_color: string;
  metal: string;
  gauge: string;
  size: string;
  diameter: string;
  bar_length: string;
  style_name: string;
  is_complex: boolean;
  finish: string;
  ring_format: string;
  ring_style: string;
  barbell_format: string;
  barbell_subtype: string;
  item_name: string;
  variation_name: string;
  gems: string;
  notes: string;
  orientation: string;
  [key: string]: unknown;
}

// Straight quotes -> ″ in the free-text fields, matching Sc2 module 54, so inch marks
// don't break the model's JSON.
const q = (s: unknown): string => String(s ?? '').replace(/"/g, '″');

/** Build the pipe-delimited classifier input: vendor|sku|description|qty|price|gems|notes. */
export function buildClassifierInput(lines: ClassifierLineInput[]): string {
  return lines
    .map((l) => [l.vendor, l.sku, q(l.description), l.qty, l.price, q(l.gems), q(l.notes)].join('|'))
    .join('\n');
}

/**
 * Parse the classifier's {"items":[...]} output. More tolerant than Sc2 module 57 — pulls
 * the JSON object out even if the model pretty-prints or adds stray text — and throws
 * loudly rather than importing nothing.
 */
export function parseClassifierItems(text: string): ClassifiedItem[] {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  const jsonStr = s !== -1 && e > s ? text.slice(s, e + 1) : text;
  let parsed: { items?: ClassifiedItem[] };
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error('Classifier parse failed: ' + (err as Error).message + ' | starts: ' + String(text).slice(0, 200));
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error('Classifier parse: missing items[] in classifier output');
  }
  return parsed.items;
}

/** Classify a batch of invoice lines via Claude. */
export async function classifyLines(
  lines: ClassifierLineInput[],
  opts: AnthropicOptions = {},
): Promise<ClassifiedItem[]> {
  const text = await anthropicText(
    {
      system: CLASSIFY_PROMPT,
      model: CLASSIFY_MODEL,
      maxTokens: CLASSIFY_MAX_TOKENS,
      messages: [{ role: 'user', content: CLASSIFY_USER_PREFIX + buildClassifierInput(lines) }],
    },
    opts,
  );
  return parseClassifierItems(text);
}
