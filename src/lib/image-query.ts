// Build the SerpAPI image-search query + the productInfo block shown to Vision.
//
// Ported from Sc3 (scenario 5330175) module 3. Per-vendor query construction is what makes
// the image match land; the Vision step (with confidence >= 5) is the accuracy gate that
// rejects anything the query pulls in wrong, so the query only needs to be good, not perfect.

export interface ImageQueryInput {
  vendor: string;
  itemName: string; // may carry the [TAGS] suffix; stripped here
  variationName: string;
  description: string;
  gems: string;
  sku: string;
}

export interface ImageQuery {
  query: string;
  productInfo: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const stripTagSuffix = (name: string): string => name.replace(/\s*\[.*\]\s*$/, '').trim();
const stripGaugePrefix = (name: string): string => name.replace(/^\d+\s*g(a)?\s+/i, '').trim();

const stripThreading = (t: string): string =>
  t
    .replace(/\b(internally |externally )?threadless\b/gi, '')
    .replace(/\b(internally |externally )?threaded\b/gi, '')
    .replace(/\bpush[- ]?fit\b/gi, '')
    .replace(/\bpin\b/gi, '');

// Drop trailing upcharge / parenthetical notes ("(+$40 gem upcharge)", "- upcharge ...").
const stripUpcharge = (d: string): string =>
  collapse(
    d
      .replace(/\(([^)]*upcharge[^)]*)\)/gi, '')
      .replace(/[-–]\s*[^-–]*upcharge.*$/gi, '')
      .replace(/\+\s*\$?\d+(\.\d+)?.*$/g, ''),
  );

// Full names ("rose gold"), RG/WG/YG, and BVLA color codes (R14K / W18K / Y14K) -> gold color.
// Deliberately does NOT treat a bare "white"/"yellow" as a metal (those are usually gem colors).
function metalColor(v: string): string {
  const t = v.toLowerCase();
  if (/\brose gold\b/.test(t) || /\brg\b/.test(t) || /\br[g]?\d{2}k\b/.test(t)) return 'rose gold';
  if (/\bwhite gold\b/.test(t) || /\bwg\b/.test(t) || /\bw[g]?\d{2}k\b/.test(t)) return 'white gold';
  if (/\byellow gold\b/.test(t) || /\byg\b/.test(t) || /\by[g]?\d{2}k\b/.test(t)) return 'yellow gold';
  return '';
}

// Strip size, metal tokens, orientation codes and filler from a variation name to leave the gem.
function gemFrom(v: string): string {
  return collapse(
    v
      .replace(/\d+(\.\d+)?\s*mm/gi, '')
      .replace(/\d+\/\d+["″]?/g, '')
      .replace(/\b\d\d?k\b/gi, '')
      .replace(/\b(rg|wg|yg)\d?\d?k?\b/gi, '')
      .replace(/\b(rose|white|yellow) gold\b/gi, '')
      .replace(/\btitanium|niobium|gold|steel\b/gi, '')
      .replace(/\[(nvl|hlx|sep|nip|conch|helix)\]/gi, '')
      .replace(/\b(nvl|hlx)\b/gi, ''),
  );
}

// NeoMetal setting phrase from the item name (keyword map, else cleaned item name).
function neoSetting(itemName: string): string {
  const t = itemName.toLowerCase();
  if (t.includes('cabochon')) return 'bezel cabochon';
  if (t.includes('bezel')) return 'bezel gem';
  if (t.includes('prong')) return 'prong set';
  if (t.includes('flower')) return 'flower';
  if (t.includes('trinity')) return 'trinity';
  if (t.includes('labret')) return 'labret post';
  if (t.includes('disk') || t.includes('disc')) return 'disk end';
  if (t.includes('ball')) return 'ball end';
  if (t.includes('chevron')) return 'chevron';
  if (t.includes('spear')) return 'spear';
  if (t.includes('barbell')) return 'barbell';
  return collapse(stripGaugePrefix(stripThreading(itemName)));
}

export function buildImageQuery(input: ImageQueryInput): ImageQuery {
  const vendor = (input.vendor || '').trim();
  const itemName = stripTagSuffix(input.itemName || '');
  const variationName = (input.variationName || '').trim();
  const description = (input.description || '').trim();
  const gems = (input.gems || '').trim();
  const sku = (input.sku || '').trim();
  const v = vendor.toLowerCase();

  let query: string;
  if (v.includes('bvla')) {
    const base = collapse((description.split(' - ')[0] || itemName).replace(/^\d+\s*g\s+/i, ''));
    const metal = metalColor(variationName);
    const gem = gemFrom(variationName);
    query = collapse(`bvla ${base} ${metal} ${gem}`);
  } else if (v.includes('neometal')) {
    const setting = neoSetting(itemName);
    const stone = collapse((gems || variationName).replace(/^\d+(\.\d+)?\s*mm\s+/i, ''));
    query = stone ? `NeoMetal ${setting} ${stone} titanium threadless` : `NeoMetal ${setting} titanium`;
  } else if (v.includes('anatometal')) {
    let desc = stripUpcharge(description) || collapse(`${itemName} ${variationName}`);
    if (desc.length > 60) {
      const parts = desc.split(',');
      desc = parts[0]!.trim() + (parts[1] ? ' ' + parts[1].trim() : '');
    }
    query = `Anatometal ${desc}`;
  } else if (v.includes('quetzalli')) {
    const designName = (description.split(' - ')[0] || itemName).trim();
    const stone = gemFrom(variationName);
    query = collapse(`Quetzalli ${designName} ${stone} threadless end gold`);
  } else if (v.includes('people') || v === 'pj') {
    let pj = stripUpcharge(stripThreading(description || `${itemName} ${variationName}`));
    if (pj.length > 60) pj = pj.substring(0, 60);
    query = collapse(`People's Jewelry ${pj} titanium`);
  } else {
    query = collapse(`${vendor} ${stripGaugePrefix(itemName)} ${variationName}`);
  }
  query = collapse(query);

  let productInfo = `Vendor: ${vendor}`;
  productInfo += `\nItem: ${itemName}`;
  productInfo += `\nVariation: ${variationName}`;
  if (description) productInfo += `\nDescription: ${description}`;
  if (gems) productInfo += `\nGems: ${gems}`;
  if (sku) productInfo += `\nSKU: ${sku}`;

  return { query, productInfo };
}
