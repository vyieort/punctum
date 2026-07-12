// Category routing tests.
//   1. routing parity — the ported switch resolves the same paths the Make bridge did;
//   2. config coverage — every path the router can emit exists in RE's real category_map
//      (the 54 rows pulled from Make DataStore 92123), so nothing routes to a missing
//      category. This is the end-to-end proof that the extraction is complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCategoryPath, resolveCategoryId, CATEGORY_PATHS } from '../src/lib/categories.js';

// RE's category_map paths, exactly as seeded from Make DataStore 92123 (54 rows).
const RE_CATEGORY_PATHS = new Set<string>([
  'Navels', 'Rings', 'Septum', 'Service & Tool Fees', 'Surface', 'Threaded', 'Threadless', 'Vendors',
  'Navels > Bezel Navel Curves', 'Navels > Prong Navel Curves', 'Rings > Captive Bead Rings',
  'Rings > Clickers & Hinge Rings', 'Rings > Fixed Bead Rings', 'Rings > Seam Rings', 'Septum > Clickers',
  'Surface > Surface Anchors', 'Threaded > Threaded Circular Barbells', 'Threaded > Threaded Curved Barbells',
  'Threaded > Threaded Ends', 'Threaded > Threaded Straight Barbells', 'Threadless > Threadless Barbells',
  'Threadless > Threadless Ends', 'Threadless > Threadless Flatbacks & Posts', 'Vendors > Anatometal',
  'Vendors > BVLA', 'Vendors > NeoMetal', "Vendors > People's Jewelry", 'Vendors > Quetzalli',
  'Threaded > Threaded Ends > Ball / Disc', 'Threaded > Threaded Ends > Spike / Gem Ball',
  'Threadless > Threadless Ends > Bezel-Set', 'Threadless > Threadless Ends > Cabochon',
  'Threadless > Threadless Ends > Cluster / Fan', 'Threadless > Threadless Ends > Dangles',
  'Threadless > Threadless Ends > Plain / Ball', 'Threadless > Threadless Ends > Prong-Set',
  'Threadless > Threadless Ends > Shapes', 'Threadless > Threadless Ends > Trinity / Flower',
  'Piercing Fee', 'Surface > Surface Barbells', 'Threaded > Threaded Flatbacks & Posts',
  'Threaded > Threaded L-Bars', 'Threaded > Threaded Ends > Bezel Cabochon',
  'Threaded > Threaded Ends > Captive Bezel', 'Threaded > Threaded Ends > Marquise Bezel',
  'Plugs & Tunnels', 'Plugs & Tunnels > Single Flair', 'Plugs & Tunnels > Double Flair',
  'Plugs & Tunnels > Eyelets & Tunnels', 'Chains & Connectors', 'Vendors > Glasswear Studios',
  'Vendors > Stiletto Piercing Supply', 'Diagnostic', 'Diagnostic > Flag For Review',
]);

test('config coverage: every routable category path exists in RE category_map', () => {
  const missing = Object.values(CATEGORY_PATHS).filter((p) => !RE_CATEGORY_PATHS.has(p));
  assert.deepEqual(missing, [], `paths the router can emit but category_map lacks: ${missing.join(' | ')}`);
});

test('routing parity — representative cases match the Make bridge', () => {
  const cases: Array<[Parameters<typeof resolveCategoryPath>[0], string | null]> = [
    [{ product_type: 'THREADLESS_END', setting: 'PRONG' }, 'Threadless > Threadless Ends > Prong-Set'],
    [{ product_type: 'THREADLESS_END', setting: 'CAB' }, 'Threadless > Threadless Ends > Cabochon'],
    [{ product_type: 'THREADLESS_END', setting: 'disk' }, 'Threadless > Threadless Ends > Plain / Ball'],
    [{ product_type: 'THREADLESS_END' }, 'Threadless > Threadless Ends'],
    [{ product_type: 'THREADED_END' }, 'Threaded > Threaded Ends'],
    [{ product_type: 'FLATBACK', thread_type: 'threaded' }, 'Threaded > Threaded Flatbacks & Posts'],
    [{ product_type: 'FLATBACK', thread_type: 'threadless' }, 'Threadless > Threadless Flatbacks & Posts'],
    [{ product_type: 'BARBELL', thread_type: 'threadless' }, 'Threadless > Threadless Barbells'],
    [{ product_type: 'BARBELL', thread_type: 'threaded', barbell_format: 'CURVED' }, 'Threaded > Threaded Curved Barbells'],
    [{ product_type: 'BARBELL', thread_type: 'threaded', barbell_format: 'STRAIGHT' }, 'Threaded > Threaded Straight Barbells'],
    [{ product_type: 'RING', ring_format: 'SEAM' }, 'Rings > Seam Rings'],
    [{ product_type: 'RING', ring_format: 'CBR' }, 'Rings > Captive Bead Rings'],
    [{ product_type: 'RING' }, 'Rings'],
    [{ product_type: 'NAVEL' }, 'Navels'],
    [{ product_type: 'SEPTUM' }, 'Septum'],
    [{ product_type: 'SURFACE' }, 'Surface'],
    [{ product_type: 'SERVICE' }, 'Service & Tool Fees'],
    [{ product_type: 'PLUG', setting: 'eyelet' }, 'Plugs & Tunnels > Eyelets & Tunnels'],
    [{ product_type: 'PLUG' }, 'Plugs & Tunnels'],
    [{ product_type: 'CHAIN' }, 'Chains & Connectors'],
    [{ product_type: 'FALLBACK' }, null],
    [{ product_type: '' }, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveCategoryPath(input), expected, `for ${JSON.stringify(input)}`);
  }
});

test('resolveCategoryId maps through category_map to the client Square id', () => {
  const map = new Map<string, string>([
    ['Threadless > Threadless Ends > Prong-Set', 'H4MIE33J6RSG6SZMNSNFI3TD'],
    ['Rings > Seam Rings', '2XRYBKYA4YH2CVSSZGGQVS4Z'],
  ]);
  assert.equal(
    resolveCategoryId({ product_type: 'THREADLESS_END', setting: 'prong' }, map),
    'H4MIE33J6RSG6SZMNSNFI3TD',
  );
  assert.equal(resolveCategoryId({ product_type: 'RING', ring_format: 'SEAM' }, map), '2XRYBKYA4YH2CVSSZGGQVS4Z');
  assert.equal(resolveCategoryId({ product_type: 'FALLBACK' }, map), null); // unroutable -> null
  assert.equal(resolveCategoryId({ product_type: 'NAVEL' }, map), null); // routable but not in this partial map
});
