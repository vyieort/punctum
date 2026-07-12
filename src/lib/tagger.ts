// Sc2.5 — POS Tag Generator
//
// Faithful TypeScript port of Make scenario 5330172 ("PRODUCTION - V2 - 2.5 Tag and
// Search Suffix Generator"), module 3 (ExecuteCode). The source of truth is the Make
// blueprint's `codeStringJavascript`.
//
// PORTING CONTRACT (see docs/DECISIONS.md):
//   - Output is a space-joined tag string; TAG ORDER IS PART OF THE CONTRACT.
//   - Dictionaries are copied verbatim from the live code, including collisions
//     (e.g. 'princess' -> 'PRG', same as 'prong') and near-duplicate misspellings
//     ('labadorite', 'rhodalite', 'artic blue', 'junippur').
//   - Matching quirks are intentional and preserved (e.g. 'sapphire blue' yields BOTH
//     SBL and SPH). Do NOT "fix" these — they are what the golden corpus was written by.
//   - The only intentional divergence from the live code: the Make `\\n` line-splitting
//     quirk is dropped. This port takes STRUCTURED group input; the job wrapper
//     (src/jobs/tags.generate.ts) builds groups directly.

/** One catalog row feeding a tag group (mapped from mapping-sheet columns). */
export interface TagInputRow {
  /** col A — Vendor */
  vendor: string;
  /** col G — Square Item (item name) */
  itemName: string;
  /** col H — Square Variation (variation name) */
  variationName: string;
  /** col D — Square Catalog ID (group key) */
  catalogId: string;
  /** sheet row number */
  rowNumber: number;
}

export interface TagResult {
  tags: string;
  catalogId: string;
  rowNums: number[];
  tagCount: number;
  variationCount: number;
  baseName: string;
  error?: string;
}

// --- Dictionaries (verbatim from live code; order preserved) ------------------

const VENDOR_TAGS: Record<string, string> = {
  neometal: 'NEO',
  'neometal inc': 'NEO',
  anatometal: 'ANA',
  bvla: 'BVLA',
  'body vision los angeles': 'BVLA',
  'body vision': 'BVLA',
  "people's jewelry": 'PJ',
  'peoples jewelry': 'PJ',
  "people's": 'PJ',
  quetzalli: 'QZ',
  'glasswear studios': 'GW',
  glasswear: 'GW',
  'buddha jewelry': 'BJ',
  buddha: 'BJ',
  junipurr: 'JNP',
  junippur: 'JNP',
  'kate jack': 'KJ',
  leroi: 'LR',
  'le roi': 'LR',
  'pupil hall': 'PH',
  'so fine': 'SF',
};

const TYPE_WORDS: Record<string, string> = {
  'seam ring': 'SMR',
  'seamless ring': 'SMR',
  seamless: 'SMR',
  'fixed bead ring': 'FBR',
  'fixed ring': 'FBR',
  'captive bead ring': 'CBR',
  'captive bead': 'CBR',
  captive: 'CBR',
  'circular barbell': 'CIR',
  horseshoe: 'CIR',
  'curved barbell': 'CBB',
  banana: 'CBB',
  'straight barbell': 'BBL',
  barbell: 'BBL',
  clicker: 'CLK',
  'hinged ring': 'HNG',
  'hinge ring': 'HNG',
  navel: 'NAV',
  belly: 'NAV',
  'flat back': 'LBR',
  flatback: 'LBR',
  labret: 'LBR',
  plug: 'PLG',
  eyelet: 'PLG',
  chain: 'CHN',
  charm: 'CHA',
  dangle: 'CHA',
  'nose stud': 'NOS',
  'nostril screw': 'NOS',
  'nostril nail': 'NOS',
  'l-bar': 'NOS',
  'nose ring': 'NOS',
  end: 'END',
  top: 'END',
  attachment: 'END',
  pin: 'END',
  disc: 'DK',
  disk: 'DK',
  ball: 'BL',
};

const SETTING_WORDS: Record<string, string> = {
  prong: 'PRG',
  'prong set': 'PRG',
  'prong-set': 'PRG',
  'v prong': 'PRG',
  'v-prong': 'PRG',
  bezel: 'BZL',
  'bezel set': 'BZL',
  'bezel-set': 'BZL',
  'open back': 'BZL',
  cabochon: 'CAB',
  cab: 'CAB',
  trinity: 'TRN',
  cluster: 'CLU',
  fan: 'FAN',
  'fan cluster': 'FAN',
  flower: 'FLR',
  claw: 'CLW',
  channel: 'CHL',
  flush: 'FLU',
  baguette: 'BAG',
  marquise: 'MQZ',
  pave: 'PAV',
  princess: 'PRG',
};

const MATERIAL_WORDS: Record<string, string> = {
  yg14k: 'YG',
  yg18k: 'YG',
  'yellow gold': 'YG',
  rg14k: 'RG',
  rg18k: 'RG',
  'rose gold': 'RG',
  wg14k: 'WG',
  wg18k: 'WG',
  'white gold': 'WG',
  titanium: 'TI',
  niobium: 'NB',
  platinum: 'PT',
  stainless: 'SS',
  steel: 'SS',
  gold: 'GD',
  sterling: 'SS',
};

// Ordered array (longest / most-specific first). Iterated in order; every hit is added.
const GEM_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['sapphire blue cz', 'CZ'],
  ['copper rutilated quartz', 'QTZ'],
  ['rutilated quartz', 'QTZ'],
  ['rose quartz', 'QTZ'],
  ['smoky quartz', 'QTZ'],
  ['chatham paraiba spinel', 'SPN'],
  ['paraiba spinel', 'SPN'],
  ['chatham champagne sapphire', 'SPH'],
  ['chatham lab created ruby', 'RBY'],
  ['zawadi sapphire', 'SPH'],
  ['padparadscha sapphire', 'SPH'],
  ['padparadscha', 'SPH'],
  ['champagne sapphire', 'SPH'],
  ['rainbow moonstone', 'MOON'],
  ['london blue topaz', 'TPZ'],
  ['swiss blue topaz', 'TPZ'],
  ['blue topaz', 'TPZ'],
  ['white topaz', 'TPZ'],
  ['mystic topaz', 'TPZ'],
  ['aurora borealis', 'ABR'],
  ['arctic blue', 'ARC'],
  ['artic blue', 'ARC'],
  ['sapphire blue', 'SBL'],
  ['champagne', 'CHP'],
  ['fancy purple', 'FPR'],
  ['paradise shine', 'PDS'],
  ['mint green', 'MNT'],
  ['teal', 'TEL'],
  ['pink', 'PNK'],
  ['black', 'BLK'],
  ['white', 'WHT'],
  ['white opal', 'OPL'],
  ['black opal', 'OPL'],
  ['fire opal', 'OPL'],
  ['white cz', 'CZ'],
  ['cubic zirconia', 'CZ'],
  ['tiger eye', 'TE'],
  ['tigers eye', 'TE'],
  ['labradorite', 'LAB'],
  ['labadorite', 'LAB'],
  ['tourmaline', 'TML'],
  ['moonstone', 'MOON'],
  ['morganite', 'MRG'],
  ['rhodolite', 'GNT'],
  ['rhodalite', 'GNT'],
  ['tanzanite', 'TN'],
  ['turquoise', 'TRQ'],
  ['amethyst', 'AMT'],
  ['sapphire', 'SPH'],
  ['diamond', 'DIA'],
  ['peridot', 'PD'],
  ['garnet', 'GNT'],
  ['citrine', 'CTR'],
  ['iolite', 'IOL'],
  ['spinel', 'SPN'],
  ['topaz', 'TPZ'],
  ['quartz', 'QTZ'],
  ['amber', 'AMB'],
  ['onyx', 'ONX'],
  ['opal', 'OPL'],
  ['ruby', 'RBY'],
  ['cz', 'CZ'],
];

// --- Primitives (verbatim behavior) ------------------------------------------

function norm(s: string): string {
  return (s || '').toLowerCase().trim();
}

function addTag(set: string[], tag: string): void {
  if (tag && set.indexOf(tag) === -1) set.push(tag);
}

function keysByLengthDesc(dict: Record<string, string>): string[] {
  // Object.keys preserves insertion order; sort is stable in Node/V8, so equal-length
  // keys keep dictionary order — matching the live code's Object.keys(...).sort().
  return Object.keys(dict).sort((a, b) => b.length - a.length);
}

function extractGems(text: string, tags: string[]): void {
  const t = norm(text);
  for (let i = 0; i < GEM_WORDS.length; i++) {
    if (t.indexOf(GEM_WORDS[i][0]) !== -1) addTag(tags, GEM_WORDS[i][1]);
  }
}

function wordMatch(text: string, word: string): boolean {
  const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
  return re.test(text);
}

function extractSettings(text: string, tags: string[]): void {
  const t = norm(text);
  const keys = keysByLengthDesc(SETTING_WORDS);
  for (let i = 0; i < keys.length; i++) {
    if (wordMatch(t, keys[i])) addTag(tags, SETTING_WORDS[keys[i]]);
  }
}

function extractMaterials(text: string, tags: string[]): void {
  const t = norm(text);
  const keys = keysByLengthDesc(MATERIAL_WORDS);
  for (let i = 0; i < keys.length; i++) {
    if (t.indexOf(keys[i]) !== -1) addTag(tags, MATERIAL_WORDS[keys[i]]);
  }
}

function extractTypes(text: string, tags: string[]): void {
  const t = norm(text);
  const keys = keysByLengthDesc(TYPE_WORDS);
  const matched: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (t.indexOf(keys[i]) !== -1) {
      let skip = false;
      for (let m = 0; m < matched.length; m++) {
        if (matched[m].indexOf(keys[i]) !== -1) {
          skip = true;
          break;
        }
      }
      if (!skip) {
        addTag(tags, TYPE_WORDS[keys[i]]);
        matched.push(keys[i]);
      }
    }
  }
}

function extractGauges(text: string, tags: string[]): void {
  const t = norm(text);
  const m = t.match(/\b(\d{1,2})g\b/g);
  if (m) {
    for (let i = 0; i < m.length; i++) addTag(tags, m[i]);
  }
  const ga = t.match(/\b(\d{1,2})\s*ga\b/gi);
  if (ga) {
    for (let j = 0; j < ga.length; j++) {
      const num = ga[j].match(/(\d{1,2})/);
      if (num) addTag(tags, num[1] + 'g');
    }
  }
}

function extractConnection(text: string, tags: string[]): void {
  const t = norm(text);
  if (
    t.indexOf('threadless') !== -1 ||
    t.indexOf('push-fit') !== -1 ||
    t.indexOf('push fit') !== -1 ||
    t.indexOf('pin with') !== -1
  ) {
    addTag(tags, 'TL');
  }
  if (
    (t.indexOf('threaded') !== -1 && t.indexOf('threadless') === -1) ||
    t.indexOf('internally threaded') !== -1
  ) {
    addTag(tags, 'TD');
  }
}

// --- Main entry point ---------------------------------------------------------

/**
 * Generate the POS tag string for a catalog group.
 *
 * `rows` must be all mapping-sheet rows sharing one catalog ID, in sheet order.
 * The first row supplies the vendor, item name, and catalog ID (matching the live
 * code, which reads those from line 0 of the aggregated group).
 */
export function generateTags(rows: TagInputRow[]): TagResult {
  let vendor = '';
  const vendors: string[] = [];
  let itemName = '';
  let catalogId = '';
  const variations: string[] = [];
  const rowNums: number[] = [];

  for (let li = 0; li < rows.length; li++) {
    const lineVendor = (rows[li].vendor || '').trim();
    if (li === 0) {
      vendor = lineVendor;
      itemName = (rows[li].itemName || '').trim();
      catalogId = (rows[li].catalogId || '').trim();
    }
    if (lineVendor && vendors.indexOf(lineVendor) === -1) vendors.push(lineVendor);
    const vn = (rows[li].variationName || '').trim();
    if (vn) variations.push(vn);
    const rn = rows[li].rowNumber;
    if (rn !== undefined && rn !== null && !Number.isNaN(rn)) rowNums.push(rn);
  }

  // `vendor` is captured to mirror the live code's line-0 read; tags use `vendors`.
  void vendor;

  if (!catalogId || !itemName) {
    return {
      error: 'Empty catalogId or itemName.',
      tags: '',
      catalogId,
      rowNums: [],
      tagCount: 0,
      variationCount: 0,
      baseName: '',
    };
  }

  const tags: string[] = [];

  // Vendor tags first: one hit per unique vendor, longest key wins, then break.
  const vendorKeys = keysByLengthDesc(VENDOR_TAGS);
  for (let av = 0; av < vendors.length; av++) {
    const vLower = norm(vendors[av]);
    for (let vi = 0; vi < vendorKeys.length; vi++) {
      if (vLower.indexOf(vendorKeys[vi]) !== -1) {
        addTag(tags, VENDOR_TAGS[vendorKeys[vi]]);
        break;
      }
    }
  }

  // Item-name extraction (order is part of the contract).
  const cleanName = itemName.replace(/\s*\[.*\]\s*$/, '').trim();
  extractGauges(cleanName, tags);
  extractTypes(cleanName, tags);
  extractSettings(cleanName, tags);
  extractConnection(cleanName, tags);
  extractGems(cleanName, tags);
  extractMaterials(cleanName, tags);

  // Per-variation extraction (gems, materials, settings only).
  for (let i = 0; i < variations.length; i++) {
    extractGems(variations[i], tags);
    extractMaterials(variations[i], tags);
    extractSettings(variations[i], tags);
  }

  // Threading inference for barbell families lacking an explicit connection.
  const isBBL =
    tags.indexOf('BBL') !== -1 || tags.indexOf('CBB') !== -1 || tags.indexOf('CIR') !== -1;
  if (isBBL && tags.indexOf('TL') === -1 && tags.indexOf('TD') === -1) {
    if (tags.indexOf('12g') !== -1 || tags.indexOf('14g') !== -1) {
      addTag(tags, 'TD');
    } else if (tags.indexOf('16g') !== -1) {
      if (tags.indexOf('NEO') !== -1) {
        addTag(tags, 'TL');
      } else {
        addTag(tags, 'TD');
      }
    }
  }

  // Generic-gold dedupe: drop GD when a specific karat color is present.
  if (
    tags.indexOf('GD') !== -1 &&
    (tags.indexOf('YG') !== -1 || tags.indexOf('RG') !== -1 || tags.indexOf('WG') !== -1)
  ) {
    tags.splice(tags.indexOf('GD'), 1);
  }

  const tagString = tags.join(' ');
  return {
    tags: tagString,
    catalogId,
    rowNums,
    tagCount: tags.length,
    variationCount: variations.length,
    baseName: cleanName,
  };
}
