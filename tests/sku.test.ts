// Synthetic SKU generator — golden parity with the Make Sc1 `genSku` (module 32).
//
// GOLDEN pairs were captured from the verbatim Make oracle via the oracle-diff harness;
// the TS port matched the oracle across this corpus + a cross-vendor fuzz matrix. These
// SKUs are only fallbacks for line items the invoice leaves blank — parity (not prettiness)
// is the contract, so the quirks below (30-char truncation, doubled stone codes) are
// intentionally preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genSku, fillSkus } from '../src/lib/sku.js';

const GOLDEN: Array<[string, string, string]> = [
  ['NeoMetal', '18ga Ti bezel 4mm onyx cabochon', 'NEO-18GA-TI-BZL-ONYX-CAB-4MM-O'],
  ['NeoMetal', '18ga Ti prong set 5mm paradise shine cz', 'NEO-18GA-TI-PRG-SET-PARA-SHIN-'],
  ['BVLA', 'Threadless Disk - 3mm Yellow 14K', 'BVLA-THL-DISK-G14-3MM'],
  ['BVLA', 'Muse Seam Ring 18g White 14K 1.5mm White CZ', 'BVLA-MUSE-SM-RNG-WHIT-14K-WHIT'],
  ['BVLA', 'Fan Cluster End - Rose Gold - Opal', 'BVLA-FAN-CLU-END-RG-OPL'],
  ['Anatometal', '16g Curved Barbell - Titanium', 'ANA-CRV-BBL-TI-16G'],
  ['Anatometal', 'Flat Back Labret, Titanium, 18g', 'ANA-FLT-BK-LBR-TI-18G'],
  ['Anatometal', 'Captive Bead Ring 14g Niobium', 'ANA-CPT-BD-RNG-NB-14G'],
  ['Quetzalli', 'Navel Curve Prong Set Sapphire', 'QTZ-NAV-CRV-PRG-SET-SAPP-SAP'],
  ['Quetzalli', 'Trinity Cluster 3mm champagne cz', 'QTZ-TRN-CLU-CHAM-CZ-3MM-CHCZ'],
  ["People's Jewelry", 'Chain Connector Triple', 'PJ-CHN-CONN-TRP'],
  ["People's Jewelry", 'Circular Barbell 14g Yellow Gold', 'PJ-CRC-BBL-YELL-YG-14G'],
  ['Glasswear Studios', 'Glass Plug - Dichroic - 1/2"', 'GLA-GLAS-PLG-1_2-DCR'],
  ['Stiletto', 'Seam Ring 16g Rose Gold', 'STI-SM-RNG-ROSE-RG-16G'],
  ['Stiletto', '14g Straight Barbell Steel', 'STI-STR-BBL-SS-14G'],
  ['NeoMetal', 'Bezel Cabochon Moonstone Medium', 'NEO-BZL-CAB-MOON-MEDI-MD-MOON'],
  ['NeoMetal', '20g Nostril Screw Yellow Gold', 'NEO-NOS-SCRE-YELL-YG-20G'],
  ['BVLA', 'Spike End Black CZ', 'BVLA-SPK-END-BLAC-CZ-BKCZ'],
  ['BVLA', 'Ball End 4mm Titanium', 'BVLA-BAL-END-TI-4MM'],
  ['Anatometal', 'Hinged Ring 16g Titanium', 'ANA-HNG-RNG-TI-16G'],
  ['BVLA', '', ''],
  ['ObscureCo', 'Simple Widget', 'OBS-SIMP-WIDG'],
];

test('genSku matches the Make original across the golden corpus', () => {
  for (const [vendor, desc, expected] of GOLDEN) {
    assert.equal(genSku(vendor, desc), expected, `vendor=${vendor} desc="${desc}"`);
  }
});

test('fillSkus fills only blanks and never overwrites an existing SKU', () => {
  const out = fillSkus('BVLA', [
    { sku: 'EXISTING-1', description: 'Ball End 4mm Titanium' },
    { sku: '', description: 'Ball End 4mm Titanium' },
    { description: 'Spike End Black CZ' },
    { sku: '   ', description: 'Fan Cluster End - Rose Gold - Opal' },
  ]);
  assert.equal(out[0]!.sku, 'EXISTING-1'); // preserved
  assert.equal(out[1]!.sku, 'BVLA-BAL-END-TI-4MM'); // empty -> filled
  assert.equal(out[2]!.sku, 'BVLA-SPK-END-BLAC-CZ-BKCZ'); // missing -> filled
  assert.equal(out[3]!.sku, 'BVLA-FAN-CLU-END-RG-OPL'); // whitespace-only -> filled
});
