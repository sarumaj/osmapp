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
  trimMode: false,
  selectedClusters: [], // [{ layer, feature }]

  // ── Trim tool (live, flipped from the trim toolbar) ───────
  trimReachM: 60, // how far the boundary runs behind a building
  trimDetailM: 15, // how far the traced edge may be straightened
  trimFollow: true, // snap and route the new edge along streets
  trimEdit: false, // the proposal is being dragged about by hand

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

  // ── Trim tool tuning ──────────────────────────────────────
  //
  // The three distances are one argument, not three settings. The raster
  // guarantees every kept building sits at least TRIM_REACH_M from the
  // proposed boundary; snapping then moves a vertex by up to TRIM_SNAP_M and
  // a routed edge wanders up to TRIM_ROUTE_SLACK_M from the ring it replaces.
  // Both are well under the reach on purpose — that margin is the whole
  // reason the boundary can be dragged onto the street network without any
  // risk of it walking over a house.
  TRIM_REACH_M: 60, // default reach, overridden live by trimReachM
  TRIM_REACH_MIN_M: 20,
  TRIM_REACH_MAX_M: 150,
  TRIM_SNAP_M: 25, // how far a ring vertex may be pulled onto a street
  TRIM_ROUTE_SLACK_M: 40, // how far a routed edge may stray from the ring
  TRIM_ROUTE_MIN_M: 15, // hops shorter than this are not worth an A*
  TRIM_ROUTE_BUDGET: 400, // routes attempted per proposal
  TRIM_ROUTE_MAX_POPS: 6000, // A* budget per route; this runs hundreds of times

  // 10 m cells over a city-sized boundary is a quarter of a million of them,
  // which is a few milliseconds. The budget is the backstop: past it the cell
  // grows instead, because a coarser answer now beats a finer one that lands
  // after the slider has moved again.
  TRIM_CELL_M: 10,
  TRIM_MAX_CELLS: 400000,
  TRIM_SIMPLIFY_M: 6, // floor: below the cell there is nothing but staircase
  TRIM_DETAIL_M: 15, // default edge detail, overridden live by trimDetailM
  // Simplification moves the edge inward by up to its own tolerance, so the
  // detail slider is capped at reach minus this. Asking for a wider berth
  // around the houses is what buys the room to draw a simpler line.
  TRIM_DETAIL_CLEARANCE_M: 15,
  TRIM_DEBOUNCE_MS: 220,

  // The corridor is a wedge: full reach where it leaves the settlement, and a
  // tip this many corridor-widths across at the building it reaches, whose
  // own reach disc rounds the end off. Widening *both* ends instead left a
  // long link looking like a wire with a trumpet soldered to each end.
  TRIM_TIP_FACTOR: 2,

  // Isolation is a property of a place, not of a building. Buildings are
  // grouped by single linkage — anything within LINK_FACTOR × the median plot
  // spacing of anything else is the same place — and a group is an outlier
  // when it is both small and far. Measuring each building on its own asked
  // "is this house alone?", and four houses two kilometers out answer no:
  // they have each other, so a hamlet was never found however far it sat.
  TRIM_OUTLIER_NEIGHBORS: 3, // k, for the median spacing that sets the scale
  TRIM_OUTLIER_FACTOR: 3, // far: this many times the median
  TRIM_OUTLIER_MIN_M: 120, // floor: nothing inside this is ever "isolated"
  TRIM_OUTLIER_LINK_FACTOR: 1.5, // short enough to keep two settlements apart
  // Small: a share of everything downloaded, with a floor. A genuine second
  // village of fifty houses is not an accident to be swept up automatically —
  // that is a decision somebody should make by dragging a box over it.
  TRIM_OUTLIER_GROUP_MAX: 8,
  TRIM_OUTLIER_GROUP_SHARE: 0.05,

  // A group of kept buildings that is not connected to the main settlement is
  // joined to it by a corridor rather than dropped, so "what I keep, I keep"
  // holds and un-excluding a building visibly reshapes the boundary.
  //
  // The corridor goes straight. Asking the street network first produced arms
  // that wandered around two corners to reach a farm three hundred meters
  // away, because the shortest way there by road is rarely the lane it sits
  // on. Streets are right for the *edge* of the territory, where the line has
  // to be one somebody can stand on; for a link the only question is how to
  // reach the building without covering ground nobody asked for.
  TRIM_CORRIDOR_M: 12,
  TRIM_LINK_ROUNDS: 3, // bridging passes before giving up
  TRIM_LINK_MAX_GROUPS: 40, // past this it would be a starfish, not a territory

  // Marks are drawn for the visible extent only, and never more than this
  // many: excluding a quarter of a town is one drag, and four thousand live
  // markers is a map that no longer pans.
  TRIM_MARKER_MAX: 800,

  // A territory whose bounding box is shorter than this on screen is flagged
  // as one you cannot reasonably see. 24 px is roughly the size of the number
  // chip itself: below that the label is bigger than the thing it labels,
  // which is exactly the case worth pointing at.
  TINY_TERRITORY_PX: 24,

  // Carving a hand-drawn polygon out of the whole-area cluster leaves a
  // remainder. Below this it is dropped instead of becoming a territory in
  // its own right — see polygons.addInnerPolygon.
  MIN_REMAINDER_M2: 50,
};

window.App = App;
