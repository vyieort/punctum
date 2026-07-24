// Merged single-pass prompt: extract AND classify in one Claude call.
//
// Composed at runtime from the two existing prompts (verbatim) so the A/B tests the real
// merge, not a paraphrase. A unifying wrapper resolves the one conflict — each source
// prompt defines its own output shape — by pinning ONE combined schema and telling the
// model to ignore the per-section output instructions.

import { EXTRACTION_PROMPT } from './prompt.js';
import { CLASSIFY_PROMPT } from './classify-prompt.js';

// Live single-pass extraction+classification model. Override with EXTRACT_MODEL to A/B or roll back
// (e.g. EXTRACT_MODEL=claude-sonnet-4-6) without a code change.
export const MERGED_MODEL = process.env.EXTRACT_MODEL || 'claude-sonnet-5';
export const MERGED_MAX_TOKENS = 32768;

export const MERGED_PROMPT = `You are a single-pass invoice extraction AND classification system for a body piercing jewelry shop. Read the invoice PDF and return ONE JSON object in which each line item carries BOTH its extracted invoice data AND its catalog classification.

IMPORTANT: the two rule sets below (PART 1 and PART 2) were originally two separate steps, each with its own "Output Format" / "return this structure" section. IGNORE those internal output-format instructions. Your ONLY output is the single combined schema defined here.

Return exactly: {"items": [ <one object per line item, in invoice order> ]}
Each item object must contain these fields:
{
  "vendor": "", "sku": "", "description": "", "qty": "", "price": "",
  "is_product": true, "back_order": "", "folds_into": "",
  "product_type": "", "thread_type": "", "setting": "", "stone_type": "", "stone_color": "",
  "metal": "", "gauge": "", "size": "", "diameter": "", "bar_length": "", "style_name": "",
  "is_complex": false, "finish": "", "ring_format": "", "ring_style": "", "barbell_format": "",
  "barbell_subtype": "", "item_name": "", "variation_name": "", "gems": "", "notes": "", "orientation": ""
}
Also include top-level "vendor_name", "invoice_number", "invoice_date", "invoice_total".

ADD-ON LINES ("folds_into"): some lines are not standalone products but upcharges on ANOTHER line — a gem or stone billed on its own line for a piece listed elsewhere, a gold-threading or gauge-conversion upcharge, an engraving or anodizing charge. For each such line: set "is_product" to false AND set "folds_into" to the SKU of the parent jewelry line it belongs to (or, if that line has no SKU, the parent line's exact "description"). Its price will be folded into that parent's cost. Use the invoice layout to attribute it — the parent is usually the nearest piece it modifies, even if gems are grouped in a separate section. For ORDER-LEVEL charges that belong to no single item (shipping, handling, insurance, freight, postage, tax, discounts): set "is_product" to false and leave "folds_into" empty. For normal standalone products, leave "folds_into" empty.

Apply BOTH rule sets to every line. PART 1 tells you how to read line items out of the invoice PDF — SKUs, prices, is_product, the gems/notes/back-order columns, and the vendor-specific gem handling (Anatometal accent-gem pairing, NeoMetal in-description gems). PART 2 tells you how to classify each line you read — product_type, setting, item_name, variation_name, orientation, and so on. Where PART 2 refers to "pipe-separated rows" as its input, treat that as the line items you extracted in PART 1. Where the two parts overlap (e.g. BVLA color codes, Anatometal gem pairing), they agree — follow them.

============================ PART 1 — EXTRACTION RULES ============================
${EXTRACTION_PROMPT}

============================ PART 2 — CLASSIFICATION RULES ============================
${CLASSIFY_PROMPT}

Return ONLY the JSON object described above. First character must be "{", last character must be "}". No markdown fences, no prose, no explanation.`;
