/**
 * data.js — Overpass fetching via the Flask backend, rendering, export/import.
 *
 * Changes:
 *   • importData() used s.outerPolygonsLayerGroup (plural) — a name nothing
 *     else in the app defines — and _ensureLayerGroups() created the typo on
 *     demand, so imported polygons sat outside the layer control and outside
 *     resetAll(). Names corrected; the guard now only fills in the real groups.
 *   • Import used to call refreshFilteredData(), which returns early with no
 *     clusters, so a cluster-less file rendered nothing. It now goes through
 *     displayResults() like a fetch does, and shows the export toolbar.
 *   • _isWithinCache() read coordinates[0] only, so it was wrong for
 *     MultiPolygon and ignored holes. It uses turf.bbox now.
 *   • The /import_data round trip was never called by any client code; the
 *     endpoint is gone from app.py and nothing here references it.
 */
var App = window.App || {};

App.data = (function () {
  "use strict";

  var s = null;
  var G = null;
  var T = null;

  function init() {
    s = App.state;
    G = App.geometry;
    T = App.i18n.t;
  }

  // ══════════════════════════════════════════════════════════════════════
  // FETCH
  // ══════════════════════════════════════════════════════════════════════

  function fetchData(geojson, forceRefresh) {
    if (
      !forceRefresh &&
      s.cachedStreets &&
      s.cachedBuildings &&
      _isWithinCache(geojson)
    ) {
      s._skipOuterClear = true;
      displayResults({
        streets: s.cachedStreets,
        buildings: s.cachedBuildings,
        bounds: _bboxToBounds(turf.bbox(G.feat(geojson))),
      });
      s._skipOuterClear = false;
      return Promise.resolve();
    }

    App.ui.showBusy(T("loading.streets"), T("loading.streetsStatus"));

    var streets = null;

    return _post("/fetch_streets", geojson)
      .then(function (data) {
        streets = data.streets;
        App.ui.setOverlayText(
          T("loading.buildings"),
          T("loading.buildingsStatus"),
        );
        return _post("/fetch_buildings", geojson);
      })
      .then(function (data) {
        App.ui.setOverlayText(T("loading.preparing"), "");
        App.ui.hideOverlay();
        s._skipOuterClear = true;
        displayResults({
          streets: { type: "FeatureCollection", features: streets.features },
          buildings: {
            type: "FeatureCollection",
            features: data.buildings.features,
          },
          bounds: data.bounds,
        });
        s._skipOuterClear = false;
      })
      .catch(function (err) {
        console.error(">>> Fetch failed:", err);
        App.ui.hideOverlay();
        alert(T("alert.fetchFailed", { message: err.message }));
      });
  }

  function _post(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(
        function (data) {
          if (!r.ok || data.error) {
            throw new Error(data.error || "Server returned " + r.status);
          }
          return data;
        },
        function () {
          throw new Error("Server returned " + r.status);
        },
      );
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════

  function displayResults(data) {
    if (!s._skipOuterClear) {
      s.outerPolygonLayerGroup.clearLayers();
      s.outerPolygonLayer = null;
    }
    App.polygons.setClusters([], { silent: true });

    s.cachedStreets = data.streets || {
      type: "FeatureCollection",
      features: [],
    };
    s.cachedBuildings = data.buildings || {
      type: "FeatureCollection",
      features: [],
    };
    s.cachedBounds = data.bounds || null;
    s.outerPolygonDrawn = !!s.outerPolygonLayer || s.outerPolygonDrawn;

    _indexStreetSegments(s.cachedStreets);

    App.polygons.renderStreets(s.cachedStreets.features);
    App.polygons.renderBuildings(s.cachedBuildings.features);
    App.ui.showExportToolbar();

    if (s.cachedBounds) {
      s.leafletMap.fitBounds(
        [
          [s.cachedBounds.south, s.cachedBounds.west],
          [s.cachedBounds.north, s.cachedBounds.east],
        ],
        { padding: [40, 40] },
      );
    }

    App.ui.setInfoLoaded(
      s.cachedStreets.features.length,
      s.cachedBuildings.features.length,
    );
    if (App.session) App.session.markDirty({ data: true });
  }

  /** Flatten street features into turf LineStrings once, for clustering. */
  function _indexStreetSegments(streets) {
    s.streetSegments = [];
    if (!streets || !streets.features) return;
    streets.features.forEach(function (f) {
      var geom = f.geometry;
      if (!geom) return;
      if (geom.type === "LineString") {
        if (geom.coordinates.length >= 2)
          s.streetSegments.push(turf.lineString(geom.coordinates));
      } else if (geom.type === "MultiLineString") {
        geom.coordinates.forEach(function (line) {
          if (line.length >= 2) s.streetSegments.push(turf.lineString(line));
        });
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // EXPORT / IMPORT
  // ══════════════════════════════════════════════════════════════════════

  /** The bundle written to a file or to the session store. */
  function buildPayload() {
    return {
      version: 3,
      exportedAt: new Date().toISOString(),
      outerPolygon: s.outerPolygonLayer
        ? s.outerPolygonLayer.toGeoJSON()
        : null,
      bounds: s.cachedBounds,
      streets: s.cachedStreets,
      buildings: s.cachedBuildings,
      clusters: App.polygons.clusterFeatures().map(function (f, i) {
        return {
          type: "Feature",
          geometry: f.geometry,
          properties: Object.assign({}, f.properties || {}, { cluster: i }),
        };
      }),
    };
  }

  function exportData() {
    if (!s.outerPolygonLayer) {
      alert(T("alert.exportNothing"));
      return;
    }

    var payload = buildPayload();
    var blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "partition_export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log(">>> Exported", payload.clusters.length, "clusters");
  }

  /**
   * Apply a saved bundle: outer boundary, streets, buildings, territories.
   * Shared by file import and session restore.
   * @param {{outerPolygon, streets, buildings, bounds, clusters}} payload
   */
  function applyPayload(payload) {
    _ensureLayerGroups();

    var outer = G.largestPolygon(payload.outerPolygon);
    if (!outer) throw new Error("no usable outer boundary");

    s.outerPolygonLayerGroup.clearLayers();
    s.outerPolygonLayer = G.toLayer(outer.geometry, App.polygons.OUTER_STYLE);
    s.outerPolygonLayerGroup.addLayer(s.outerPolygonLayer);
    s.outerPolygonDrawn = true;
    App.polygons.attachOuterEvents(s.outerPolygonLayer);

    s._skipOuterClear = true;
    displayResults({
      streets: payload.streets,
      buildings: payload.buildings,
      bounds: payload.bounds || _bboxToBounds(turf.bbox(outer)),
    });
    s._skipOuterClear = false;

    var restored = App.polygons.setClusters(payload.clusters || []);
    if (restored === 0) {
      App.polygons.ensureDefaultCluster();
      restored = s.clusters.length;
    }
    return restored;
  }

  function importData(file) {
    var reader = new FileReader();

    reader.onerror = function () {
      alert(T("alert.importUnreadable"));
    };

    reader.onload = function (e) {
      var payload;
      try {
        payload = JSON.parse(e.target.result);
      } catch (err) {
        alert(T("alert.importNotJson"));
        return;
      }

      var restored = applyPayload(payload);
      if (App.history) App.history.clear();

      console.log(
        ">>> Import complete — streets:",
        s.cachedStreets.features.length,
        "buildings:",
        s.cachedBuildings.features.length,
        "clusters:",
        restored,
      );
    };

    reader.readAsText(file);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ══════════════════════════════════════════════════════════════════════

  function _isWithinCache(geojson) {
    if (!s.cachedBounds) return false;
    var b;
    try {
      b = turf.bbox(G.feat(geojson));
    } catch (e) {
      return false;
    }
    return (
      b[0] >= s.cachedBounds.west &&
      b[2] <= s.cachedBounds.east &&
      b[1] >= s.cachedBounds.south &&
      b[3] <= s.cachedBounds.north
    );
  }

  function _bboxToBounds(b) {
    return { west: b[0], south: b[1], east: b[2], north: b[3] };
  }

  function _ensureLayerGroups() {
    [
      "outerPolygonLayerGroup",
      "innerPolygonsLayerGroup",
      "streetsLayerGroup",
      "buildingsLayerGroup",
    ].forEach(function (name) {
      if (!s[name]) s[name] = L.featureGroup().addTo(s.leafletMap);
    });
    s.clusters = s.clusters || [];
    s.selectedClusters = s.selectedClusters || [];
  }

  return {
    init: init,
    fetchData: fetchData,
    displayResults: displayResults,
    exportData: exportData,
    importData: importData,
    buildPayload: buildPayload,
    applyPayload: applyPayload,
  };
})();

window.App = App;
