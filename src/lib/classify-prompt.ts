// Classification system prompt — verbatim from live Sc2 module 56 (scenario 5330168,
// model claude-sonnet-4-6). This is the second Claude pass: it takes extracted invoice
// lines and classifies each into the structured fields (product_type, setting, gauge,
// item_name, variation_name, metal, …) that drive grouping, pricing, and categorization.
//
// Loaded from a .txt sidecar because the prompt is full of backticks and quotes that don't
// survive a TS string literal cleanly. The only edit from the source: the BVLA-ring
// variation_name examples, which the Make blueprint had double-escaped (the model literally
// saw `5/16\"`), are written with a clean `"` here — the obviously intended form.

import { readFileSync } from 'node:fs';

export const CLASSIFY_PROMPT = readFileSync(new URL('./classify-prompt.txt', import.meta.url), 'utf8');

export const CLASSIFY_MODEL = 'claude-sonnet-4-6';
export const CLASSIFY_MAX_TOKENS = 32768;

// The classifier is fed one pipe-delimited row per line item:
//   vendor|sku|description|qty|price|gems|notes
// with straight quotes replaced by ″ in the free-text fields (so inch marks don't break
// the model's JSON). The user turn is CLASSIFY_USER_PREFIX + the joined rows.
export const CLASSIFY_USER_PREFIX = 'Parse these invoice line items:\n';
