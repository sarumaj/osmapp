/**
 * state.js - shared mutable state and tuning constants.
 *
 * Every module reads and writes the same `App.state` object rather than
 * keeping its own copy of the map, the layers or the current tool settings.
 * The file is split into two halves: mutable fields at the top, which change
 * as the user works, and named constants at the bottom in SCREAMING_CASE,
 * which do not. The constants are documented individually because most of them
 * are thresholds whose value is a judgement about the physical world - how far
 * apart houses stand, how big a target a finger can hit - and picking a
 * different number changes how the app behaves rather than how fast it runs.
 *
 * Some vocabulary used throughout this file and the rest of the app:
 *
 *   - The **outer boundary** is the area being worked on, drawn by hand or
 *     taken from an administrative outline. All OSM data is downloaded for it.
 *   - A **territory** (called a cluster in the code) is one subdivision of that
 *     area. Territories are what get printed onto cards for field use.
 *   - **Reach** is the walking distance from a building that still counts as
 *     belonging to it, which is how the trim tool decides where the settlement
 *     ends and the countryside begins.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.state = {
  // Map and layer refs
  //
  // Populated by main.js at startup. Each layer group holds one category of
  // geometry so that categories can be toggled and reordered independently.
  leafletMap: null,
  streetsLayerGroup: null,
  buildingsLayerGroup: null,
  innerPolygonsLayerGroup: null,
  gapsLayerGroup: null,
  notesLayerGroup: null,
  outerPolygonLayerGroup: null,
  outerPolygonLayer: null,

  // Street data
  //
  // The street network, flattened for geometric queries. One OSM street can be
  // a MultiLineString, so it becomes several entries here.
  streetSegments: [], // turf LineStrings, one per street feature part

  // Feature caches
  //
  // The last successful download, kept so that redrawing and exporting do not
  // have to ask the server again. Null means nothing has been downloaded yet.
  cachedStreets: null,
  cachedBuildings: null,
  cachedBounds: null,

  // Clusters
  outerPolygonDrawn: false, // whether an outer boundary exists yet
  clusters: [], // [{ feature: GeoJSON Feature, layer: L.Layer }]

  // Notes
  //
  // Annotations laid over the working area: written notes, pins on places, and
  // marks drawn along streets. Records rather than layers - App.notes owns
  // what they look like - because they are also what a session, an export and
  // a printed card carry. See notes.js.
  notes: [], // [{ kind, points, text, color, width }]

  // UI / misc
  contextMenu: null, // the open context menu element, if any
  userLocationMarker: null,
  _skipOuterClear: false, // set while importing, so a redraw keeps the boundary

  // Mode flags
  //
  // At most one of these is true at a time. Each corresponds to a modal tool
  // that takes over clicks on the map and installs its own toolbar.
  editMode: false, // cutting territories apart
  mergeMode: false, // joining territories together
  trimMode: false, // shrinking the boundary onto the buildings
  outlineMode: false, // reshaping the boundary vertex by vertex
  noteMode: false, // writing annotations over the area
  selectedClusters: [], // [{ layer, feature }]

  // Trim tool (live, flipped from the trim toolbar)
  //
  // These mirror the sliders and switches on the trim toolbar, so the tool can
  // recompute its proposal as they move.
  trimReachM: 60, // how far the boundary runs behind a building
  trimDetailM: 15, // how far the traced edge may be straightened
  trimFollow: true, // snap and route the new edge along streets
  trimEdit: false, // the proposal is being dragged about by hand
  // What counts as an outlying place. Both numbers are multiples of the area's
  // own median plot spacing rather than absolute distances, which is what lets
  // them be sliders at all: the same setting means the same thing in a terrace
  // and in farmland. See TRIM_OUTLIER_* below for how the unit is derived.
  trimOutlierFactor: 3, // far: this many times the median spacing
  trimOutlierGroupMax: 8, // small: at most this many buildings in the group

  // Notes tool toggle (live, flipped from the notes toolbar)
  //
  // Whether a clicked vertex of a mark is pulled onto the street network and
  // the hop before it routed along one. A freehand sweep ignores it: a sweep
  // is a statement about where the hand went.
  noteSnap: true,

  // Cut tool toggles (live, flipped from the cut toolbar)
  cutSnap: true, // snap vertices to the street network
  cutSnapEdges: true, // ...and to existing territory outlines
  cutFollow: true, // route between vertices along streets

  // Tuning
  STREET_SEARCH_MAX_ITER: 5000,
  ROUTE_SNAP_MAX_M: 500, // how far edge routing will reach for a graph node

  // The cut tool measures its snap radius in screen pixels rather than in
  // meters. A fixed metric radius behaves differently at every zoom level --
  // a magnet that swallows the whole viewport when zoomed in, and useless when
  // zoomed out - whereas a pixel radius always matches what the pointer looks
  // like it is near.
  CUT_SNAP_PX: 14,
  CUT_SNAP_MAX_M: 40, // ceiling, so a zoomed-out view cannot reach for miles
  // Snap candidates compete by distance, and these weights bias that contest.
  // A multiplier below 1 shortens the measured distance and so wins ties.
  CUT_NODE_BONUS: 0.6, // <1 makes intersections win ties against centre-lines
  CUT_EDGE_PENALTY: 1.7, // >1 makes territory outlines lose ties to streets

  // A cut can follow the streets between the vertices the user placed. These
  // three reject a route that is technically shortest but obviously not what
  // was meant, and stop the search from stalling the live preview.
  CUT_ROUTE_MAX_DETOUR: 1.75, // reject a street route longer than this x direct
  CUT_ROUTE_MAX_EXTRA_M: 300, // ...and cap the absolute extra length too
  CUT_ROUTE_MAX_POPS: 30000, // A* budget, so a live preview cannot stall

  CUT_EXTEND_OVERSHOOT_M: 1.5, // push endpoints past the boundary they meet

  // A cut is performed by subtracting a thin polygon - the "knife" - from the
  // territory, so the blade needs width to actually separate the two halves.
  // The widths are tried in order until one does. The ceiling is not
  // arbitrary: geometry.unionHealed closes gaps up to 2 x HEAL_METERS = 1 m
  // when territories are merged, so a blade wider than that would cut two
  // halves apart in a way that can no longer be merged back without a seam.
  CUT_KNIFE_M: [0.25, 0.75],
  CUT_MIN_PIECE_M2: 5, // discard crumbs the knife shaves off

  MAX_PARTITIONS: 200, // upper bound on territories the partitioner will make

  // Trim tool tuning
  //
  // The three distances below are one argument rather than three independent
  // settings. The raster guarantees that every kept building sits at least
  // TRIM_REACH_M from the proposed boundary; snapping then moves a vertex by
  // up to TRIM_SNAP_M, and a routed edge wanders up to TRIM_ROUTE_SLACK_M from
  // the ring it replaces. Both of the latter are well under the reach, and
  // that margin is what allows the boundary to be pulled onto the street
  // network without any risk of it crossing a house.
  TRIM_REACH_M: 60, // default reach, overridden live by trimReachM
  TRIM_REACH_MIN_M: 20,
  TRIM_REACH_MAX_M: 150,
  TRIM_SNAP_M: 25, // how far a ring vertex may be pulled onto a street
  TRIM_ROUTE_SLACK_M: 40, // how far a routed edge may stray from the ring
  TRIM_ROUTE_MIN_M: 15, // hops shorter than this are not worth an A*
  TRIM_ROUTE_BUDGET: 400, // routes attempted per proposal
  TRIM_ROUTE_MAX_POPS: 6000, // A* budget per route; this runs hundreds of times

  // The trim tool works on a raster rather than on polygons (see coverage.js),
  // so cell size trades accuracy against memory. 10 m cells over a city-sized
  // boundary is a quarter of a million of them, which takes a few
  // milliseconds. TRIM_MAX_CELLS is the backstop: rather than allocate past
  // it, the cell size grows, because a coarser answer now is more useful than
  // a finer one that arrives after the slider has moved again.
  TRIM_CELL_M: 10,
  TRIM_MAX_CELLS: 400000,
  TRIM_SIMPLIFY_M: 6, // floor: below the cell size there is only staircase
  TRIM_DETAIL_M: 15, // default edge detail, overridden live by trimDetailM
  // Simplifying the traced edge moves it inward by up to its own tolerance, so
  // the detail slider is capped at the reach minus this clearance. In other
  // words, asking for a wider berth around the houses is what buys the room to
  // draw a simpler line.
  TRIM_DETAIL_CLEARANCE_M: 15,
  TRIM_DEBOUNCE_MS: 220, // pause after a slider moves before recomputing

  // Outlying groups of buildings are joined to the main settlement by a
  // corridor. The corridor is a wedge rather than a constant-width strip: full
  // reach where it leaves the settlement, tapering to a tip this many corridor
  // widths across at the building it reaches, where that building's own reach
  // disc rounds the end off.
  TRIM_TIP_FACTOR: 2,

  // Isolation is a property of a place rather than of a single building.
  // Buildings are first grouped by single linkage - anything within
  // TRIM_OUTLIER_LINK_FACTOR x the median plot spacing of anything else joins
  // the same group - and a group counts as an outlier when it is both small
  // and far.
  // Asking the question per building instead would mean four houses two
  // kilometers out are not outliers, because each has the other three nearby.
  TRIM_OUTLIER_NEIGHBORS: 3, // k, for the median spacing that sets the scale
  TRIM_OUTLIER_FACTOR: 3, // far: this many times the unit below
  TRIM_OUTLIER_MIN_M: 120, // floor: nothing inside this is ever "isolated"
  TRIM_OUTLIER_LINK_FACTOR: 1.5, // short enough to keep two settlements apart

  // How much of the main settlement's own extent counts as "far".
  //
  // This is the third term in the distance unit, and it is what makes the rule
  // hold in a city as well as in farmland. Spacing and the floor together say
  // that anything more than 120 m from the built-up mass is isolated, which is
  // true in the countryside and wrong in a town, where a block across a park
  // is exactly that far and plainly still part of the town. Taking 2.5% of the
  // main settlement's diagonal stays below the floor for anything
  // village-sized, so villages are governed by the floor, and overtakes it
  // from roughly a five-kilometer town upward.
  TRIM_OUTLIER_SPAN_SHARE: 0.025,

  // Small: a group of at most this many buildings can be an outlier. This is
  // an absolute count, deliberately not scaled to the size of the download --
  // scaling it would mean a ceiling of two hundred buildings in a city while
  // the control beside it still reads eight.
  TRIM_OUTLIER_GROUP_MAX: 8,

  // The range of the two outlier sliders.
  //
  // TRIM_OUTLIER_LINK_FACTOR above has no slider on purpose: it decides what
  // counts as one place, and exposing it would offer a chance to split a village
  // down the middle without any indication that this is what the control does.
  //
  // The distance range starts at 1 rather than at the floor's equivalent,
  // because with an adaptive unit there is a meaningful setting down there:
  // "only what is much farther out than the town is wide" is a reasonable
  // thing to ask for on a coastline or in a ribbon village.
  TRIM_OUTLIER_FACTOR_MIN: 1,
  TRIM_OUTLIER_FACTOR_MAX: 20,
  TRIM_OUTLIER_GROUP_MIN: 1, // 1 is "single buildings only"
  TRIM_OUTLIER_GROUP_LIMIT: 60,

  // Corner handles
  //
  // Leaflet.Editable draws an 8 px vertex handle, which is smaller than a
  // trackpad can reliably hit. Missing one is not harmless: the click lands on
  // whatever is underneath - the boundary itself in the outline editor, a
  // building in trim mode. See vertices.js.
  //
  // This is the drawn size only. The stylesheet grows the target with a
  // transparent pseudo-element inset by -7 px, so the handle a pointer can hit
  // is 26 px across even though the circle is 12.
  VERTEX_SIZE_PX: 12,
  // How far the eraser reaches from the pointer. It is wider than the handle
  // on purpose: erasing is a sweeping gesture rather than an aimed click, and
  // a target you have to thread is no faster than clicking each handle.
  VERTEX_ERASER_PX: 22,

  // Width of the corridor that joins an outlying group of buildings to the
  // main settlement, so that keeping a building always visibly reshapes the
  // boundary rather than leaving a detached island.
  //
  // The corridor goes straight rather than following the streets. A routed one
  // takes the shortest way by road, which for a farm three hundred meters out
  // is rarely the lane it stands on, so the arm wanders around two corners.
  // Streets are the right answer for the *edge* of a territory, which has to be
  // a line somebody can stand on; a link only has to reach the building without
  // covering ground nobody asked for.
  TRIM_CORRIDOR_M: 12,
  TRIM_LINK_ROUNDS: 3, // bridging passes before giving up
  TRIM_LINK_MAX_GROUPS: 40, // past this it would be a starfish, not a territory

  // Buildings are marked with a live marker so the user can include or exclude
  // them. Markers are drawn for the visible extent only and never more than
  // this many, because excluding a quarter of a town is a single drag and four
  // thousand live markers is a map that no longer pans.
  TRIM_MARKER_MAX: 800,

  // A territory whose bounding box is shorter than this on screen is flagged
  // as one the user cannot reasonably see. 24 px is roughly the size of the
  // number chip drawn on it, so below this the label is larger than the thing
  // it labels, which is exactly the case worth pointing at.
  TINY_TERRITORY_PX: 24,

  // The smallest uncovered patch worth offering as a gap (see gaps.js).
  //
  // Hairline seams between adjacent territories are removed by the opening
  // step below rather than by this threshold, so this only has to sit above
  // the scraps the rest of the app already treats as negligible:
  // CUT_MIN_PIECE_M2 is 5 and MIN_REMAINDER_M2 is 50. A much larger value
  // hides the case the feature exists for, since a 30 x 30 m plot between two
  // territories is uncovered ground somebody still has to walk.
  GAP_MIN_M2: 200,

  // How far an uncovered piece is shrunk before it is asked whether anything
  // is left - a morphological opening, which erases slivers narrower than
  // twice this. Half a meter is the same tolerance geometry.unionHealed uses
  // to decide that two boundaries are the same boundary, which is the right
  // number to match: anything narrower is a rounding artefact everywhere else
  // in the app and should not become a territory here.
  GAP_OPEN_M: 0.5,

  // Drawing a territory by hand carves it out of the surrounding one, which
  // leaves a remainder. A remainder smaller than this is dropped rather than
  // kept as a territory in its own right - see polygons.addInnerPolygon.
  MIN_REMAINDER_M2: 50,
};

window.App = App;
