/**
 * state.js — single source of truth for shared mutable state.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.state = {
  // ── Map and layer refs ────────────────────────────────────
  leafletMap: null,
  streetsLayerGroup: null,
  buildingsLayerGroup: null,
  innerPolygonsLayerGroup: null,
  outerPolygonLayerGroup: null,
  outerPolygonLayer: null,

  // ── Street data ───────────────────────────────────────────
  streetSegments: [], // turf LineStrings, one per street feature part

  // ── Feature caches ────────────────────────────────────────
  cachedStreets: null,
  cachedBuildings: null,
  cachedBounds: null,

  // ── Clusters ──────────────────────────────────────────────
  outerPolygonDrawn: false,
  clusters: [], // [{ feature: GeoJSON Feature, layer: L.Layer }]

  // ── UI / misc ─────────────────────────────────────────────
  contextMenu: null,
  userLocationMarker: null,
  _skipOuterClear: false,

  // ── Mode flags ────────────────────────────────────────────
  editMode: false,
  mergeMode: false,
  selectedClusters: [], // [{ layer, feature }]

  // ── Cut tool toggles (live, flipped from the cut toolbar) ─
  cutSnap: true, // snap vertices to the street network
  cutSnapEdges: true, // …and to existing territory outlines
  cutFollow: true, // route between vertices along streets

  // ── Tuning ────────────────────────────────────────────────
  STREET_SEARCH_MAX_ITER: 5000,
  ROUTE_SNAP_MAX_M: 500, // how far edge routing will reach for a graph node

  // The cut tool measures its snap radius on screen, not on the ground. A
  // fixed metric radius is either a magnet that swallows the whole viewport
  // when zoomed in or useless when zoomed out; a pixel radius behaves the
  // same at every zoom, which is the only way the tool feels predictable.
  CUT_SNAP_PX: 14,
  CUT_SNAP_MAX_M: 40, // ceiling, so a zoomed-out view cannot reach for miles
  CUT_NODE_BONUS: 0.6, // <1 makes intersections win ties against centre-lines
  CUT_EDGE_PENALTY: 1.7, // >1 makes territory outlines lose ties to streets

  CUT_ROUTE_MAX_DETOUR: 1.75, // reject a street route longer than this × direct
  CUT_ROUTE_MAX_EXTRA_M: 300, // …and cap the absolute extra length too
  CUT_ROUTE_MAX_POPS: 30000, // A* budget, so a live preview cannot stall

  CUT_EXTEND_OVERSHOOT_M: 1.5, // push endpoints past the boundary they meet

  // Knife widths, tried in order until one separates. The ceiling is not
  // arbitrary: geometry.unionHealed closes gaps up to 2 × HEAL_METERS = 1 m,
  // so a blade wider than that would cut two halves apart in a way that can
  // no longer be merged back without a visible seam.
  CUT_KNIFE_M: [0.25, 0.75],
  CUT_MIN_PIECE_M2: 5, // discard crumbs the knife shaves off

  MAX_PARTITIONS: 200,
};

window.App = App;
