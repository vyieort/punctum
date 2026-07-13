// Anthropic Messages API helper (dependency-free, injectable fetch).
//
// One shared `anthropicText` call used by both invoice extraction (PDF -> line items) and
// classification (line items -> structured catalog fields). Thin and injectable so the
// jobs that consume it can be unit-tested with a fake fetch, no live API required.

import { EXTRACTION_PROMPT, EXTRACTION_USER_TEXT, EXTRACTION_MODEL, EXTRACTION_MAX_TOKENS } from './prompt.js';

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

/** POST /v1/messages and return the concatenated text of the reply. */
export async function anthropicText(
  req: { system: string; model: string; maxTokens: number; messages: unknown[] },
  opts: AnthropicOptions = {},
): Promise<string> {
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
    body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }),
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

export interface ExtractOptions extends AnthropicOptions {
  model?: string;
  maxTokens?: number;
}

/** Send a base64-encoded PDF to Claude and return the raw extraction text (Sc1 module 2). */
export async function extractInvoiceText(pdfBase64: string, opts: ExtractOptions = {}): Promise<string> {
  return anthropicText(
    {
      system: EXTRACTION_PROMPT,
      model: opts.model ?? EXTRACTION_MODEL,
      maxTokens: opts.maxTokens ?? EXTRACTION_MAX_TOKENS,
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
    },
    opts,
  );
}
