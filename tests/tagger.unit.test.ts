// Unit tests for the ported tagger. These lock the behaviors the handoff calls out as
// fidelity-critical: threading inference, GD dedupe, princess/prong collision, and gauge
// normalization — plus vendor matching, type substring-skip, and the intentional
// 'sapphire blue' -> SBL+SPH quirk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTags, type TagInputRow } from '../src/lib/tagger.js';

/** Build a catalog group: one row per variation; item name/vendor come from row 0. */
function grp(vendor: string, itemName: string, variations: string[] = ['']): TagInputRow[] {
  const vs = variations.length ? variations : [''];
  return vs.map((v, i) => ({
    vendor,
    itemName,
    variationName: v,
    catalogId: 'CID',
    rowNumber: i + 1,
  }));
}

const tagsOf = (vendor: string, item: string, vars: string[] = ['']) =>
  generateTags(grp(vendor, item, vars)).tags;
const setOf = (s: string) => new Set(s.split(' ').filter(Boolean));

// --- Threading inference ------------------------------------------------------

test('threading: 14g barbell with no connection -> TD', () => {
  assert.equal(tagsOf('Anatometal', '14G Straight Barbell'), 'ANA 14g BBL TD');
});

test('threading: 16g NeoMetal barbell family -> TL', () => {
  assert.equal(tagsOf('NeoMetal', '16G Curved Barbell'), 'NEO 16g CBB TL');
});

test('threading: 16g non-Neo barbell family -> TD', () => {
  assert.equal(tagsOf('Anatometal', '16G Circular Barbell'), 'ANA 16g CIR TD');
});

test('threading: explicit threadless wins, no inference', () => {
  const t = setOf(tagsOf('NeoMetal', '16G Threadless Barbell'));
  assert.ok(t.has('TL'), 'has TL from threadless');
  assert.ok(!t.has('TD'), 'no inferred TD');
});

test('threading: not triggered for non-barbell types', () => {
  assert.ok(!setOf(tagsOf('', '18G Labret')).has('TD'));
});

// --- GD (generic gold) dedupe -------------------------------------------------

test('GD dedupe: specific karat color drops GD', () => {
  const t = setOf(tagsOf('', 'Gold Disc', ['Yellow Gold']));
  assert.ok(t.has('YG'), 'keeps YG');
  assert.ok(!t.has('GD'), 'drops GD');
});

test('GD dedupe: plain gold with no karat color keeps GD', () => {
  assert.ok(setOf(tagsOf('', 'Gold Disc')).has('GD'));
});

// --- princess / prong collision (both -> PRG) --------------------------------

test('princess + prong collapse to a single PRG', () => {
  assert.equal(tagsOf('', 'Princess Cut Prong Set'), 'PRG');
});

test('princess alone yields PRG', () => {
  assert.equal(tagsOf('', 'Princess'), 'PRG');
});

// --- gauge normalization ------------------------------------------------------

test('gauge: "20g", "20 ga", "20GA" all normalize to 20g', () => {
  for (const item of ['20g Charm', '20 ga Charm', '20GA Charm']) {
    assert.ok(setOf(tagsOf('', item)).has('20g'), `${item} -> 20g`);
  }
});

test('gauge: attached form "18ga" normalizes to 18g', () => {
  assert.ok(setOf(tagsOf('', '18ga Labret')).has('18g'));
});

// --- vendor matching ----------------------------------------------------------

test('vendor alias resolves (Body Vision Los Angeles -> BVLA)', () => {
  assert.ok(setOf(tagsOf('Body Vision Los Angeles', '18G Seam Ring')).has('BVLA'));
});

test('unknown vendor contributes no vendor tag', () => {
  assert.equal(tagsOf('Stiletto Piercing Supply', 'Threadless Disk'), 'DK TL');
});

// --- type substring skip ------------------------------------------------------

test('type: "Captive Bead Ring" yields only CBR (longer key wins)', () => {
  assert.equal(tagsOf('', 'Captive Bead Ring'), 'CBR');
});

// --- documented gem quirk -----------------------------------------------------

test('quirk: "sapphire blue" yields BOTH SBL and SPH (intentional)', () => {
  const t = setOf(tagsOf('', 'Sapphire Blue End'));
  assert.ok(t.has('SBL') && t.has('SPH'));
});

// --- BVLA 20G Seam Ring — reconstructed bonus golden (blueprint sample) --------
// Blueprint sample output for catalog GAXK47WFGT6RDSFEUYOC2GJB was "BVLA 20g SMR RG WG YG"
// (24 RG/WG/YG-14K variations). That ID lives in the sandbox sheet, not the production
// backup, so it is reconstructed here from the documented variation grammar.

test('bonus golden: BVLA 20G Seam Ring -> "BVLA 20g SMR RG WG YG"', () => {
  const rows = grp('BVLA', '20G Seam Ring', [
    '7/32″ RG14K',
    '1/4″ RG14K',
    '9/32″ RG14K',
    '5/16″ WG14K',
    '11/32″ WG14K',
    '3/8″ YG14K',
    '13/32″ YG14K',
  ]);
  const out = generateTags(rows);
  assert.equal(out.tags, 'BVLA 20g SMR RG WG YG');
  assert.equal(out.tagCount, 6);
});

// --- error handling -----------------------------------------------------------

test('empty item name returns an error and no tags', () => {
  const out = generateTags([
    { vendor: 'BVLA', itemName: '', variationName: '', catalogId: 'C', rowNumber: 1 },
  ]);
  assert.ok(out.error);
  assert.equal(out.tags, '');
});

test('trailing [bracket] segment is stripped from the base name', () => {
  const out = generateTags(grp('', '18G Seam Ring [internal note]'));
  assert.equal(out.baseName, '18G Seam Ring');
  assert.ok(setOf(out.tags).has('SMR'));
});
