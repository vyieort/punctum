// Single-pass extract+classify: one Claude call on the PDF returns line items already
// carrying their catalog classification. Same output shape as the two-pass classifier, so
// the compare runner can diff them directly.

import { anthropicText, type AnthropicOptions } from './anthropic.js';
import { MERGED_PROMPT, MERGED_MODEL, MERGED_MAX_TOKENS } from './merged-prompt.js';
import { parseClassifierItems, type ClassifiedItem } from './classify.js';

export async function extractAndClassify(pdfBase64: string, opts: AnthropicOptions = {}): Promise<ClassifiedItem[]> {
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
  return parseClassifierItems(text);
}
