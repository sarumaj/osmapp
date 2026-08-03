/**
 * polygons.js — cluster lifecycle, hover styling, and the filtered view.
 *
 * Added in this pass:
 *   • ensureDefaultCluster() — drawing an outer polygon now yields one cluster
 *     covering the whole area, so a territory is usable without partitioning.
 *     That cluster carries properties.auto so the app can tell it apart from a
 *     deliberate one.
 *   • Hover highlighting for clusters and the outer polygon. The style is
 *     resolved from layer state (selected beats hover beats resting) so
 *     merge-mode selection survives a mouseout.
 *   • addInnerPolygon() carves out of the auto cluster rather than rejecting
 *     the draw — otherwise every hand-drawn polygon would "overlap" the
 *     whole-area cluster and be refused.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.polygons = (function () {
  "use strict";

  var s = null;
  var G = null;
  var T = null;

  var OUTER_STYLE = {
    color: "#3388ff",
    fillColor: "#3388ff",
    fillOpacity: 0.05,
    weight: 2,
  };
  var OUTER_STYLE_HOVER = {
    color: "#1d6fe0",
    fillColor: "#3388ff",
    fillOpacity: 0.08,
    weight: 4,
  };
  var CLUSTER_STYLE = {
    color: "#9b59b6",
    fillColor: "#9b59b6",
    fillOpacity: 0.2,
    weight: 2,
  };
  var CLUSTER_STYLE_DIM = {
    color: "#9b59b6",
    fillColor: "#9b59b6",
    fillOpacity: 0.15,
    weight: 2,
  };
  var CLUSTER_STYLE_HOVER = {
    color: "#7d3c98",
    fillColor: "#9b59b6",
    fillOpacity: 0.35,
    weight: 4,
  };
  var CLUSTER_STYLE_SELECTED = {
    color: "#f39c12",
    fillColor: "#f39c12",
    fillOpacity: 0.3,
    weight: 3,
  };
  var STREET_STYLE = { color: "#e74c3c", weight: 4, opacity: 0.25 };
  var STREET_STYLE_HOVER = { color: "#e74c3c", weight: 4, opacity: 1 };
  var BUILDING_STYLE = {
    color: "#555555",
    fillColor: "#7f8c8d",
    fillOpacity: 0.5,
    weight: 1,
  };

  function init() {
    s = App.state;
    G = App.geometry;
    T = App.i18n.t;

    // One delegated pair of handlers for every street, now and in future.
    s.streetsLayerGroup.on("mouseover", function (e) {
      if (e.layer && e.layer.setStyle) e.layer.setStyle(STREET_STYLE_HOVER);
    });
    s.streetsLayerGroup.on("mouseout", function (e) {
      if (e.layer && e.layer.setStyle) e.layer.setStyle(STREET_STYLE);
    });
    App._loaded.push("polygons");
  }

  // ══════════════════════════════════════════════════════════════════════
  // STYLE RESOLUTION
  // ══════════════════════════════════════════════════════════════════════

  /** Selected beats hover beats resting, so hovering a selection is stable. */
  function _styleFor(layer) {
    if (layer._selected) return CLUSTER_STYLE_SELECTED;
    if (layer._hover) return CLUSTER_STYLE_HOVER;
    return CLUSTER_STYLE_DIM;
  }

  function refreshStyle(layer) {
    if (layer && layer.setStyle) layer.setStyle(_styleFor(layer));
  }

  function selectCluster(layer, selected) {
    layer._selected = !!selected;
    refreshStyle(layer);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLUSTER STORE
  // ══════════════════════════════════════════════════════════════════════

  function clusterFeatures() {
    return s.clusters.map(function (c) {
      return c.feature;
    });
  }

  function clusterLayers() {
    return s.clusters.map(function (c) {
      return c.layer;
    });
  }

  function findCluster(layer) {
    for (var i = 0; i < s.clusters.length; i++)
      if (s.clusters[i].layer === layer)
        return { index: i, entry: s.clusters[i] };
    return null;
  }

  function isAuto(feature) {
    return !!(feature && feature.properties && feature.properties.auto);
  }

  /**
   * Replace every cluster. Accepts GeoJSON Features or bare geometries.
   * @param {Array} features
   * @param {{silent?: boolean}} [opts] silent skips the filtered-data refresh
   * @returns {number} how many clusters ended up on the map
   */
  function setClusters(features, opts) {
    s.innerPolygonsLayerGroup.clearLayers();
    s.clusters = [];
    s.selectedClusters = [];

    (features || []).forEach(function (input) {
      var geometry = input && (input.geometry || (input.type ? input : null));
      if (!geometry || !geometry.type) return;

      var feature = {
        type: "Feature",
        geometry: geometry,
        properties: (input && input.properties) || {},
      };
      var layer = G.toLayer(feature.geometry, CLUSTER_STYLE_DIM);
      if (!layer) return;

      s.innerPolygonsLayerGroup.addLayer(layer);
      attachClusterEvents(layer, feature);
      s.clusters.push({ feature: feature, layer: layer });
    });

    if (!opts || !opts.silent) refreshFilteredData();
    if (App.session) App.session.markDirty();
    return s.clusters.length;
  }

  /**
   * Give the outer polygon a cluster of its own when nothing else exists, so a
   * freshly drawn territory is immediately printable and exportable without
   * running the partitioner.
   */
  function ensureDefaultCluster() {
    if (s.clusters.length > 0 || !s.outerPolygonLayer) return false;
    var outer;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      console.warn(">>> Cannot create the default cluster:", e.message);
      return false;
    }
    setClusters([
      { type: "Feature", geometry: outer.geometry, properties: { auto: true } },
    ]);
    console.log(">>> Whole area set as a single cluster");
    return true;
  }

  /**
   * Append a hand-drawn polygon.
   *
   * Deliberate clusters may not overlap. The auto whole-area cluster is a
   * placeholder rather than a decision, so a new polygon is carved out of it
   * instead of being rejected.
   */
  function addInnerPolygon(layer, geojson) {
    var candidate = G.feat(geojson.geometry || geojson);

    if (s.outerPolygonLayer) {
      try {
        var clipped = G.intersect(
          candidate,
          G.getOuterFeature(s.outerPolygonLayer),
        );
        if (clipped && clipped.geometry) candidate = clipped;
      } catch (e) {
        /* keep the unclipped shape */
      }
    }

    for (var i = 0; i < s.clusters.length; i++) {
      if (isAuto(s.clusters[i].feature)) continue;
      try {
        var overlap = G.intersect(candidate, s.clusters[i].feature);
        if (overlap && turf.area(overlap) > 1) {
          if (s.leafletMap.hasLayer(layer)) s.leafletMap.removeLayer(layer);
          alert(T("alert.overlap"));
          return false;
        }
      } catch (e) {
        console.warn(">>> Overlap test failed for cluster", i, e.message);
      }
    }

    var next = [];
    s.clusters.forEach(function (entry) {
      if (!isAuto(entry.feature)) {
        next.push(entry.feature);
        return;
      }
      var remainder = null;
      try {
        remainder = G.difference(entry.feature, candidate);
      } catch (e) {
        remainder = null;
      }
      if (remainder && remainder.geometry && turf.area(remainder) > 1) {
        next.push({
          type: "Feature",
          geometry: remainder.geometry,
          properties: { auto: true },
        });
      }
    });
    next.push({
      type: "Feature",
      geometry: candidate.geometry,
      properties: {},
    });

    // setClusters rebuilds layers from geometry, so the drawn one is surplus.
    if (s.leafletMap.hasLayer(layer)) s.leafletMap.removeLayer(layer);

    if (App.history) App.history.push();
    setClusters(next);
    return true;
  }

  function deleteCluster(layer) {
    var hit = findCluster(layer);
    if (!hit) return false;
    if (App.history) App.history.push();
    if (layer.disableEdit) layer.disableEdit();
    s.innerPolygonsLayerGroup.removeLayer(layer);
    s.clusters.splice(hit.index, 1);
    refreshFilteredData();
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // EVENTS
  // ══════════════════════════════════════════════════════════════════════

  function attachClusterEvents(layer, feature) {
    layer.off("mouseover mouseout click contextmenu");

    layer.on("mouseover", function () {
      layer._hover = true;
      refreshStyle(layer);
      if (layer.bringToFront) layer.bringToFront();
    });

    layer.on("mouseout", function () {
      layer._hover = false;
      refreshStyle(layer);
    });

    layer.on("click", function (e) {
      if (s.mergeMode) {
        L.DomEvent.stopPropagation(e);
        App.editing.handleClusterSelectClick(layer, feature);
        return;
      }
      // In draw mode let the event through so Leaflet.Editable's vertex
      // handles and the draw tool's map click both still work.
      if (s.editMode) return;

      L.DomEvent.stopPropagation(e);
      App.ui.closeContextMenu();
      s.leafletMap.fitBounds(layer.getBounds(), {
        padding: [50, 50],
        maxZoom: 18,
      });
    });

    layer.on("contextmenu", function (e) {
      L.DomEvent.stopPropagation(e);
      if (s.editMode || s.mergeMode) return;
      App.ui.showPolygonContextMenu(e.containerPoint, layer, feature);
    });
  }

  function attachOuterEvents(layer) {
    layer.off("mouseover mouseout");
    layer.on("mouseover", function () {
      layer.setStyle(OUTER_STYLE_HOVER);
    });
    layer.on("mouseout", function () {
      layer.setStyle(OUTER_STYLE);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // FILTERED VIEW
  // ══════════════════════════════════════════════════════════════════════

  function refreshFilteredData() {
    if (!s.cachedStreets || !s.cachedBuildings) return;

    if (s.clusters.length === 0) {
      renderStreets(s.cachedStreets.features);
      renderBuildings(s.cachedBuildings.features);
      App.ui.setInfoLoaded(
        s.cachedStreets.features.length,
        s.cachedBuildings.features.length,
      );
      return;
    }

    var feats = clusterFeatures();
    var boxes = feats.map(function (f) {
      return turf.bbox(f);
    });

    // ── Streets: bbox reject, then a real intersection test ──────────────
    var filteredStreets = [];
    s.cachedStreets.features.forEach(function (f) {
      if (!f.geometry) return;
      var fb;
      try {
        fb = turf.bbox(f);
      } catch (e) {
        return;
      }
      for (var i = 0; i < feats.length; i++) {
        if (!G.bboxOverlap(fb, boxes[i])) continue;
        try {
          if (turf.booleanIntersects(G.feat(f.geometry), feats[i])) {
            filteredStreets.push(f);
            return;
          }
        } catch (e) {
          if (G.anyCoordInPolygons(f, feats)) {
            filteredStreets.push(f);
            return;
          }
        }
      }
    });

    // ── Buildings: one centroid per building, cached on the feature ──────
    var filteredBuildings = [];
    s.cachedBuildings.features.forEach(function (f) {
      if (!f.geometry) return;
      var centroid = f._centroid;
      if (!centroid) {
        try {
          centroid = f._centroid = turf.centroid(G.feat(f.geometry));
        } catch (e) {
          return;
        }
      }
      var c = centroid.geometry.coordinates;
      for (var i = 0; i < feats.length; i++) {
        if (
          c[0] < boxes[i][0] ||
          c[0] > boxes[i][2] ||
          c[1] < boxes[i][1] ||
          c[1] > boxes[i][3]
        )
          continue;
        try {
          if (turf.booleanPointInPolygon(centroid, feats[i])) {
            filteredBuildings.push(f);
            return;
          }
        } catch (e) {
          /* fall through to the next cluster */
        }
      }
    });

    renderStreets(filteredStreets);
    renderBuildings(filteredBuildings);
    App.ui.setInfoFiltered(
      filteredStreets.length,
      filteredBuildings.length,
      s.clusters.length,
    );
  }

  function renderStreets(features) {
    s.streetsLayerGroup.clearLayers();
    if (!features || features.length === 0) return;
    L.geoJSON(
      { type: "FeatureCollection", features: features },
      { style: STREET_STYLE },
    ).addTo(s.streetsLayerGroup);
  }

  function renderBuildings(features) {
    s.buildingsLayerGroup.clearLayers();
    if (!features || features.length === 0) return;
    L.geoJSON(
      { type: "FeatureCollection", features: features },
      { style: BUILDING_STYLE },
    ).addTo(s.buildingsLayerGroup);
  }

  return {
    init: init,

    clusterFeatures: clusterFeatures,
    clusterLayers: clusterLayers,
    findCluster: findCluster,
    isAuto: isAuto,
    setClusters: setClusters,
    ensureDefaultCluster: ensureDefaultCluster,
    addInnerPolygon: addInnerPolygon,
    deleteCluster: deleteCluster,

    attachClusterEvents: attachClusterEvents,
    attachOuterEvents: attachOuterEvents,
    selectCluster: selectCluster,
    refreshStyle: refreshStyle,
    refreshFilteredData: refreshFilteredData,
    renderStreets: renderStreets,
    renderBuildings: renderBuildings,

    OUTER_STYLE: OUTER_STYLE,
    CLUSTER_STYLE: CLUSTER_STYLE,
    CLUSTER_STYLE_DIM: CLUSTER_STYLE_DIM,
    CLUSTER_STYLE_HOVER: CLUSTER_STYLE_HOVER,
    CLUSTER_STYLE_SELECTED: CLUSTER_STYLE_SELECTED,
    STREET_STYLE: STREET_STYLE,
    BUILDING_STYLE: BUILDING_STYLE,
  };
})();

window.App = App;
