// Invoice extraction parser.
//
// Port of the Make Sc1 bridge module 13 (`code:ExecuteCode`). Takes the raw text of
// Claude's invoice-extraction response, pulls the JSON out of it (tolerating a ```json
// fence or leading prose), parses it, and filters the line items down to real products
// (`is_product`). Throws loudly on malformed input rather than returning a silent empty
// success — a bad extraction should fail the run, not quietly import nothing.
//
// The product/non-product decision itself is made upstream by the extraction model
// (see EXTRACTION_PROMPT); this step only applies it. Compose with fillSkus() from
// ./sku to fill blank SKUs, exactly as Sc1 chains module 13 -> module 32.
//
// Behavior is proven identical to the live Make module in tests/parse.test.ts.

export interface ExtractedLineItem {
  sku: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  is_product: boolean;
  gems: string;
  notes: string;
  back_order: string | null;
  // Raw parsed JSON — the model may include extra fields; carry them through untyped.
  [key: string]: unknown;
}

export interface ParsedInvoice {
  error: string;
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total: number;
  product_count: number;
  products: ExtractedLineItem[];
}

/**
 * Pull the JSON out of the model's response even when it writes reasoning/prose BEFORE
 * the JSON, or wraps the JSON in a ```json ... ``` fence anywhere in the text.
 */
export function extractJson(raw: unknown): string {
  let text = String(raw == null ? '' : raw).trim();
  // 1) Prefer a fenced code block anywhere (```json ... ``` first, then any ``` ... ```)
  const fence = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (fence) text = fence[1] ?? '';
  // 2) Fall back to the first "{" ... last "}" (handles leading prose with no fence)
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s !== -1 && e !== -1 && e > s) text = text.slice(s, e + 1);
  return text.trim();
}

export function parseExtraction(claudeResponse: string): ParsedInvoice {
  let parsed: {
    line_items?: ExtractedLineItem[];
    vendor_name?: string;
    invoice_number?: string;
    invoice_date?: string;
    invoice_total?: number;
  };
  try {
    parsed = JSON.parse(extractJson(claudeResponse));
  } catch (e) {
    // Do NOT return a silent empty "success" — surface the failure so the run errors.
    throw new Error(
      'Sc1 parse failed: ' + (e as Error).message + ' | starts: ' + String(claudeResponse || '').slice(0, 200),
    );
  }

  if (!parsed.line_items) {
    throw new Error(
      'Sc1 parse: missing line_items for invoice ' + (parsed.invoice_number || '(unknown)'),
    );
  }

  const products = parsed.line_items.filter((i) => i.is_product);
  return {
    error: '',
    vendor_name: parsed.vendor_name || '',
    invoice_number: parsed.invoice_number || '',
    invoice_date: parsed.invoice_date || '',
    invoice_total: parsed.invoice_total || 0,
    product_count: products.length,
    products,
  };
}

export interface InvoiceExtraction {
  vendor_name: string;
  invoice_number: string;
  invoice_date: string;
  invoice_total: number;
  line_items: ExtractedLineItem[];
}

/**
 * Parse the extraction into ALL line items (products AND non-products), for the pipeline.
 *
 * Unlike parseExtraction — the faithful Sc1 module-13 port, which drops non-products at
 * parse time — this keeps every line so the review page can surface a real product the
 * model wrongly flagged is_product:false. The is_product filter therefore moves downstream
 * to the import step, where non-products are excluded from the Square push.
 */
export function parseInvoiceLines(claudeResponse: string): InvoiceExtraction {
  let parsed: {
    line_items?: ExtractedLineItem[];
    vendor_name?: string;
    invoice_number?: string;
    invoice_date?: string;
    invoice_total?: number;
  };
  try {
    parsed = JSON.parse(extractJson(claudeResponse));
  } catch (e) {
    throw new Error(
      'Punctum parse failed: ' + (e as Error).message + ' | starts: ' + String(claudeResponse || '').slice(0, 200),
    );
  }
  if (!parsed.line_items) {
    throw new Error('Punctum parse: missing line_items for invoice ' + (parsed.invoice_number || '(unknown)'));
  }
  return {
    vendor_name: parsed.vendor_name || '',
    invoice_number: parsed.invoice_number || '',
    invoice_date: parsed.invoice_date || '',
    invoice_total: parsed.invoice_total || 0,
    line_items: parsed.line_items,
  };
}
