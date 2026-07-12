// Synthetic SKU generator.
//
// Port of the Make Sc1 bridge `genSku` (module 32). Builds a synthetic SKU from a line
// item's description when the invoice provides none. The abbreviation maps are shared
// product knowledge (not per-client). Behavior is proven identical to the Make original
// in tests/sku.test.ts.

const VENDOR_PREFIX: Record<string, string> = {
  quetzalli: 'QTZ',
  'peoples jewelry': 'PJ',
  "people's jewelry": 'PJ',
  anatometal: 'ANA',
  neometal: 'NEO',
  bvla: 'BVLA',
};

const MATERIAL_MAP: Record<string, string> = {
  'yellow gold': 'YG',
  'rose gold': 'RG',
  'white gold': 'WG',
  '14k gold': 'G14',
  '18k gold': 'G18',
  '14k': 'G14',
  '18k': 'G18',
  titanium: 'TI',
  niobium: 'NB',
  steel: 'SS',
  'stainless steel': 'SS',
  'silver overlay': 'SSV',
  brass: 'BRS',
  'yellow brass': 'YBRS',
  'white brass': 'WBRS',
  'high polished steel': 'HPSS',
  'high polished': 'HP',
  'matte black': 'MBLK',
  matte: 'MAT',
};

const STONE_MAP: Record<string, string> = {
  'white cz': 'WCZ',
  'arctic blue cz': 'ABCZ',
  'black cz': 'BKCZ',
  'champagne cz': 'CHCZ',
  'fancy purple cz': 'FPCZ',
  'mint green cz': 'MGCZ',
  'pink cz': 'PKCZ',
  'sapphire blue cz': 'SBCZ',
  'aurora borealis cz': 'ABRCZ',
  'aurora borealis': 'ABR',
  'paradise shine cz': 'PSCZ',
  cz: 'CZ',
  'cubic zirconia': 'CZ',
  'black tourmaline': 'BKTOUR',
  'green tourmaline': 'GNTOUR',
  tourmaline: 'TOUR',
  'blue sapphire': 'BSAP',
  'white sapphire': 'WSAP',
  sapphire: 'SAP',
  sunray: 'SUNR',
  'mystic topaz': 'MTPZ',
  topaz: 'TPZ',
  'white opal': 'WOPL',
  'black opal': 'BOPL',
  'synthetic opal': 'SOPL',
  opal: 'OPL',
  moonstone: 'MOON',
  garnet: 'GNT',
  amethyst: 'AMT',
  citrine: 'CTR',
  peridot: 'PRD',
  diamond: 'DIA',
  ruby: 'RBY',
  emerald: 'EMR',
  turquoise: 'TRQ',
  onyx: 'ONX',
  pearl: 'PRL',
  morganite: 'MRG',
  alexandrite: 'ALX',
  dichroic: 'DCR',
  champagne: 'CHM',
  lavender: 'LAV',
  'london blue': 'LNBL',
  'rutilated quartz': 'RTQZ',
};

const SIZE_MAP: Record<string, string> = {
  'extra small': 'XS',
  small: 'SM',
  mini: 'MN',
  medium: 'MD',
  large: 'LG',
  'extra large': 'XL',
};

const PRODUCT_WORD_MAP: Record<string, string> = {
  threaded: 'THR', threadless: 'THL', seam: 'SM', ring: 'RNG', rings: 'RNG',
  clicker: 'CLK', barbell: 'BBL', barbells: 'BBL', curved: 'CRV', straight: 'STR',
  circular: 'CRC', captive: 'CPT', bead: 'BD', bezel: 'BZL', prong: 'PRG',
  cabochon: 'CAB', cabochons: 'CAB', cluster: 'CLU', end: 'END', ends: 'END',
  gem: 'GEM', gems: 'GEM', flat: 'FLT', flatback: 'FB', flatbacked: 'FB',
  flattened: 'FLT', ball: 'BAL', balls: 'BAL', spike: 'SPK', shaft: 'SHF',
  shafts: 'SHF', navel: 'NAV', belly: 'NAV', hinge: 'HNG', hinged: 'HNG',
  claws: 'CLW', claw: 'CLW', set: 'SET', chain: 'CHN', charm: 'CHA', plug: 'PLG',
  tunnel: 'TNL', stud: 'STD', nostril: 'NOS', nose: 'NOS', labret: 'LBR',
  hoop: 'HOP', hoops: 'HOP', flower: 'FLR', fan: 'FAN', trinity: 'TRN',
  scalloped: 'SCAL', bullet: 'BLT', cut: 'CUT', finish: 'FIN', textured: 'TXT',
  polished: 'POL', display: 'DISP', jewelry: 'JWL', curve: 'CRV', transition: 'TRAN',
  sacred: 'SAC', love: 'LOV', dream: 'DRM', radiant: 'RAD', cascade: 'CASC',
  bound: 'BND', enchant: 'ENCH', devotion: 'DEV', insight: 'INS', triple: 'TRP',
  box: 'BOX', backed: 'BKD', back: 'BK',
};

const SKIP_WORDS = [
  'titanium', 'niobium', 'steel', 'stainless', 'gold', 'brass',
  'the', 'with', 'and', 'for', 'by', 'of', 'in', 'a', 'an',
  'usable', 'round', 'brilliant',
];

const byLenDesc = (m: Record<string, string>): Array<[string, string]> =>
  Object.entries(m).sort((a, b) => b[0].length - a[0].length);

const MATERIAL_ENTRIES = byLenDesc(MATERIAL_MAP);
const STONE_ENTRIES = byLenDesc(STONE_MAP);
const SIZE_ENTRIES = byLenDesc(SIZE_MAP);
const SKIP_SET = new Set(SKIP_WORDS);

export function genSku(vendor: string, desc: string): string {
  if (!desc) return '';
  const vendorLower = (vendor || '').toLowerCase().trim();
  let prefix = '';
  for (const [key, val] of Object.entries(VENDOR_PREFIX)) {
    if (vendorLower.includes(key)) {
      prefix = val;
      break;
    }
  }
  if (!prefix) prefix = vendorLower.substring(0, 3).toUpperCase();

  const d = desc.trim().replace(/\(\+?\$[\d.,]+\)/g, '').trim();

  const parts = d.split(/\s*-\s*/);
  let productName = parts[0] || '';
  let attributeStr = '';
  if (parts.length > 1) attributeStr = parts.slice(1).join(' ');

  const commaParts = productName.split(/,\s*/);
  if (commaParts.length > 1) {
    productName = commaParts[0];
    attributeStr = commaParts.slice(1).join(' ') + ' ' + attributeStr;
  }

  const fullLower = (productName + ' ' + attributeStr).toLowerCase();

  let material = '';
  for (const [k, v] of MATERIAL_ENTRIES) if (fullLower.includes(k)) { material = v; break; }
  let stone = '';
  for (const [k, v] of STONE_ENTRIES) if (fullLower.includes(k)) { stone = v; break; }
  let size = '';
  for (const [k, v] of SIZE_ENTRIES) if (fullLower.includes(k)) { size = v; break; }

  const gm = fullLower.match(/(\d{2})g(?:\b|[,\s])/);
  const gauge = gm ? gm[1] + 'G' : '';
  const mm = fullLower.match(/([\d.]+)\s*mm/);
  const mmSize = mm ? mm[1] + 'MM' : '';
  const fr = fullLower.match(/([\d]+\/[\d]+)/);
  const fracSize = fr ? fr[1].replace('/', '_') : '';

  const productWords = productName
    .split(/\s+/)
    .filter((w) => !SKIP_SET.has(w.toLowerCase()))
    .filter((w) => !/^\d+\.?\d*mm$/i.test(w))
    .filter((w) => !/^\d+g$/i.test(w));

  const abbreviatedWords = productWords
    .map((w) => {
      const subWords = w.split('-').filter((s) => s.length > 0);
      if (subWords.length > 1) {
        return subWords
          .map((sw) => {
            const lower = sw.toLowerCase();
            if (PRODUCT_WORD_MAP[lower] !== undefined) return PRODUCT_WORD_MAP[lower];
            if (SKIP_SET.has(lower)) return '';
            return sw.toUpperCase().substring(0, 4);
          })
          .filter((s) => s !== '')
          .join('-');
      }
      const lower = w.toLowerCase();
      if (PRODUCT_WORD_MAP[lower] !== undefined) return PRODUCT_WORD_MAP[lower];
      return w.toUpperCase().substring(0, 4);
    })
    .filter((w) => w !== '');

  let productCode = abbreviatedWords.join('-');
  productCode = productCode.replace(/[^A-Z0-9-]/g, '');
  productCode = productCode.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');

  const sp = [prefix, productCode];
  if (size) sp.push(size);
  if (material) sp.push(material);
  if (gauge) sp.push(gauge);
  if (mmSize) sp.push(mmSize);
  if (fracSize) sp.push(fracSize);
  if (stone) sp.push(stone);

  let sku = sp.join('-');
  sku = sku.replace(/-{2,}/g, '-').replace(/-$/g, '');
  if (sku.length > 30) sku = sku.substring(0, 30);
  return sku;
}

export interface ParsedProduct {
  sku?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

/** Fill in a synthetic SKU only where the invoice provided none (Sc1 module 32). */
export function fillSkus(vendorName: string, products: ParsedProduct[]): ParsedProduct[] {
  return products.map((p) =>
    p.sku && String(p.sku).trim() !== ''
      ? p
      : { ...p, sku: genSku(vendorName, String(p.description ?? '')) },
  );
}
