// Anthropic invoice extraction call.
//
// Thin, dependency-free port of Make Sc1 module 2: POST a base64 PDF to /v1/messages with
// the extraction prompt and return the model's text response (raw, unparsed — parse.ts
// turns it into structured data). Kept small and injectable so the writer that consumes it
// (jobs/intake.ts) can be unit-tested with a fake extractor, no live API required.

import {
  EXTRACTION_PROMPT,
  EXTRACTION_USER_TEXT,
  EXTRACTION_MODEL,
  EXTRACTION_MAX_TOKENS,
} from './prompt.js';

export interface ExtractOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

/** Send a base64-encoded PDF to Claude and return the concatenated text of its reply. */
export async function extractInvoiceText(pdfBase64: string, opts: ExtractOptions = {}): Promise<string> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';

  const res = await doFetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? EXTRACTION_MODEL,
      max_tokens: opts.maxTokens ?? EXTRACTION_MAX_TOKENS,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: EXTRACTION_USER_TEXT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as MessagesResponse;
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}
