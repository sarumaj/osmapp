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

  // ── Tuning ────────────────────────────────────────────────
  STREET_SEARCH_MAX_ITER: 5000,
  STREET_SNAP_MAX_M: 200, // how far the draw tool will reach for a street
  ROUTE_SNAP_MAX_M: 500, // how far edge routing will reach for a graph node
  MAX_PARTITIONS: 200,
};

window.App = App;
