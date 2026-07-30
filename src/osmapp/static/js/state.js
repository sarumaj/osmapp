/**
 * state.js — single source of truth for shared mutable state.
 *
 * Changes:
 *   • innerPolygons[] / innerPolygonLayers[] were two parallel arrays kept in
 *     sync by hand, and deleteInnerPolygon() could de-sync them. They are now
 *     one array of { feature, layer } pairs: s.clusters.
 *   • snapActive / snapMarker / streetSnapPoints / snapGrid / GRID_CELL_SIZE /
 *     SNAP_THRESHOLD_PX are gone with snap.js — the draw tool in editing.js
 *     does its own snapping against a spatial index.
 *   • SNAP_GRID_RANGE and STREET_SEARCH_MAX_RANGE were never read.
 *   • editMode is now actually written to (editing.js), so snap/click guards
 *     in other modules work.
 */
var App = window.App || {};

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

  // ── Tuning ────────────────────────────────────────────────
  STREET_SEARCH_MAX_ITER: 5000,
  STREET_SNAP_MAX_M: 200, // how far the draw tool will reach for a street
  ROUTE_SNAP_MAX_M: 500, // how far edge routing will reach for a graph node
  MAX_PARTITIONS: 200,
};

window.App = App;
