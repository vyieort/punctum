// Single-pass extract+classify: one Claude call on the PDF returns the invoice metadata
// AND line items already carrying their catalog classification. This is the intake path
// once the merge is adopted — the second (classification) AI call goes away.

import { anthropicText, type AnthropicOptions } from './anthropic.js';
import { MERGED_PROMPT, MERGED_MODEL, MERGED_MAX_TOKENS } from './merged-prompt.js';
import type { ClassifiedItem } from './classify.js';

export interface MergedInvoice {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total: number;
  items: ClassifiedItem[];
}

/** Parse the merged output: {vendor_name, invoice_number, ..., items:[...]}. Throws on bad JSON. */
export function parseMergedInvoice(text: string): MergedInvoice {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const jsonStr = start !== -1 && end > start ? text.slice(start, end + 1) : text;
  let parsed: {
    vendor_name?: string;
    invoice_number?: string;
    invoice_date?: string;
    invoice_total?: number;
    items?: ClassifiedItem[];
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error('Merged parse failed: ' + (err as Error).message + ' | starts: ' + String(text).slice(0, 200));
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error('Merged parse: missing items[] in merged output');
  }
  return {
    vendor_name: parsed.vendor_name || '',
    invoice_number: parsed.invoice_number || '',
    invoice_date: parsed.invoice_date || '',
    invoice_total: parsed.invoice_total || 0,
    items: parsed.items,
  };
}

export async function extractAndClassify(pdfBase64: string, opts: AnthropicOptions = {}): Promise<MergedInvoice> {
  const text = await anthropicText(
    {
      system: MERGED_PROMPT,
      model: MERGED_MODEL,
      maxTokens: MERGED_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: 'Extract and classify all line items from this invoice.' },
          ],
        },
      ],
    },
    opts,
  );
  return parseMergedInvoice(text);
}
