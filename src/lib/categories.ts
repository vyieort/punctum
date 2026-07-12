// Config-driven category resolution.
//
// Port of the Make Sc2 bridge category routing (module 59). A product's classified type +
// attributes resolve to a canonical category PATH (shared taxonomy — the same for every
// client), and the per-client `category_map` turns that path into that client's Square
// category id. So a new client with different Square categories is just different
// category_map rows; the routing logic is shared.

export const CATEGORY_PATHS = {
  THREADLESS_END: 'Threadless > Threadless Ends',
  THREADED_END: 'Threaded > Threaded Ends',
  THREADLESS_PRONG: 'Threadless > Threadless Ends > Prong-Set',
  THREADLESS_BEZEL: 'Threadless > Threadless Ends > Bezel-Set',
  THREADLESS_CAB: 'Threadless > Threadless Ends > Cabochon',
  THREADLESS_TRINITY: 'Threadless > Threadless Ends > Trinity / Flower',
  THREADLESS_CLUSTER: 'Threadless > Threadless Ends > Cluster / Fan',
  THREADLESS_PLAIN: 'Threadless > Threadless Ends > Plain / Ball',
  THREADLESS_DANGLE: 'Threadless > Threadless Ends > Dangles',
  THREADLESS_SHAPES: 'Threadless > Threadless Ends > Shapes',
  THREADLESS_FLATBACK: 'Threadless > Threadless Flatbacks & Posts',
  THREADED_FLATBACK: 'Threaded > Threaded Flatbacks & Posts',
  THREADLESS_BARBELL: 'Threadless > Threadless Barbells',
  THREADED_STRAIGHT: 'Threaded > Threaded Straight Barbells',
  THREADED_CURVED: 'Threaded > Threaded Curved Barbells',
  THREADED_CIRCULAR: 'Threaded > Threaded Circular Barbells',
  THREADED_LBAR: 'Threaded > Threaded L-Bars',
  THREADED_BARBELL: 'Threaded',
  RING: 'Rings',
  RING_SEAM: 'Rings > Seam Rings',
  RING_CBR: 'Rings > Captive Bead Rings',
  RING_FBR: 'Rings > Fixed Bead Rings',
  RING_CLICKER: 'Rings > Clickers & Hinge Rings',
  NAVEL: 'Navels',
  NAVEL_BEZEL: 'Navels > Bezel Navel Curves',
  NAVEL_PRONG: 'Navels > Prong Navel Curves',
  SEPTUM: 'Septum',
  SEPTUM_CLICKER: 'Septum > Clickers',
  SURFACE: 'Surface',
  SURFACE_ANCHOR: 'Surface > Surface Anchors',
  SURFACE_BARBELL: 'Surface > Surface Barbells',
  SERVICE: 'Service & Tool Fees',
  FLAG_FOR_REVIEW: 'Diagnostic > Flag For Review',
  PLUGS: 'Plugs & Tunnels',
  PLUG_SINGLE: 'Plugs & Tunnels > Single Flair',
  PLUG_DOUBLE: 'Plugs & Tunnels > Double Flair',
  PLUG_EYELET: 'Plugs & Tunnels > Eyelets & Tunnels',
  CHAINS: 'Chains & Connectors',
} as const;

export interface CategoryInput {
  product_type?: string | null;
  setting?: string | null;
  thread_type?: string | null;
  barbell_format?: string | null;
  ring_format?: string | null;
}

const P = CATEGORY_PATHS;

/** Classified product -> canonical category path (shared taxonomy). Null if unroutable. */
export function resolveCategoryPath(item: CategoryInput): string | null {
  const pt = String(item.product_type ?? '').toUpperCase();
  const setting = String(item.setting ?? '').toLowerCase();
  const tt = String(item.thread_type ?? '').toLowerCase();
  const barbellFmt = String(item.barbell_format ?? '').toUpperCase();
  const ringFmt = String(item.ring_format ?? '').toUpperCase();

  switch (pt) {
    case 'THREADLESS_END':
      if (setting === 'prong') return P.THREADLESS_PRONG;
      if (setting === 'bezel') return P.THREADLESS_BEZEL;
      if (setting === 'bezel_cab' || setting === 'cab') return P.THREADLESS_CAB;
      if (setting === 'trinity' || setting === 'flower') return P.THREADLESS_TRINITY;
      if (setting === 'cluster' || setting === 'fan') return P.THREADLESS_CLUSTER;
      if (setting === 'ball' || setting === 'disk' || setting === 'textured_disk') return P.THREADLESS_PLAIN;
      if (setting === 'dangle') return P.THREADLESS_DANGLE;
      if (setting === 'shape') return P.THREADLESS_SHAPES;
      return P.THREADLESS_END;
    case 'THREADED_END':
      return P.THREADED_END;
    case 'FLATBACK':
      return tt === 'threaded' ? P.THREADED_FLATBACK : P.THREADLESS_FLATBACK;
    case 'BARBELL':
      if (tt === 'threadless') return P.THREADLESS_BARBELL;
      if (barbellFmt === 'CURVED') return P.THREADED_CURVED;
      if (barbellFmt === 'CIRCULAR') return P.THREADED_CIRCULAR;
      if (barbellFmt === 'LBAR') return P.THREADED_LBAR;
      if (barbellFmt === 'STRAIGHT') return P.THREADED_STRAIGHT;
      return P.THREADED_BARBELL;
    case 'RING':
      if (ringFmt === 'SEAM') return P.RING_SEAM;
      if (ringFmt === 'CBR') return P.RING_CBR;
      if (ringFmt === 'FBR') return P.RING_FBR;
      if (ringFmt === 'CLICKER') return P.RING_CLICKER;
      return P.RING;
    case 'NAVEL':
      return P.NAVEL;
    case 'SEPTUM':
      return P.SEPTUM;
    case 'SURFACE':
      return P.SURFACE;
    case 'SERVICE':
      return P.SERVICE;
    case 'PLUG':
      if (setting === 'single_flair') return P.PLUG_SINGLE;
      if (setting === 'double_flair') return P.PLUG_DOUBLE;
      if (setting === 'eyelet' || setting === 'tunnel') return P.PLUG_EYELET;
      return P.PLUGS;
    case 'CHAIN':
      return P.CHAINS;
    default:
      return null;
  }
}

/** Classified product -> this client's Square category id (via their category_map). */
export function resolveCategoryId(
  item: CategoryInput,
  categoryMap: ReadonlyMap<string, string>,
): string | null {
  const path = resolveCategoryPath(item);
  return path === null ? null : categoryMap.get(path) ?? null;
}
