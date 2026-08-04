/**
 * boundary.js — turn a geocoder hit into the outer polygon.
 *
 * Nominatim knows the administrative outline of most places it returns, so
 * after a search for "Pforzheim" there is no reason to trace the town by hand.
 * The flow is:
 *
 *   1. main.js hands every accepted geocoder result to suggest().
 *   2. Nodes are skipped — a point has no outline — and so are results already
 *      known to be addresses. Ways and relations go to /geocode_boundary.
 *   3. The outline is previewed on the map, dashed and non-interactive, with a
 *      dialog offering a detail slider, the bounding box as a fallback, and the
 *      area measured the same way the download guard measures it.
 *   4. Accepting installs it exactly the way a hand-drawn polygon is installed
 *      (see _adoptPolygon in main.js): outer layer, then fetch, then the
 *      whole-area default cluster.
 *
 * Simplification is client-side and one-directional. The server already trims
 * at BOUNDARY_THRESHOLD (~11 m), so the slider only ever goes coarser — asking
 * for finer detail would mean another Nominatim round trip per drag.
 *
 * The suggestion is only ever a suggestion: nothing is applied until the
 * dialog's primary button is pressed, and the preview leaves no trace.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.boundary = (function () {
  "use strict";

  var s = null;
  var G = null;
  var T = null;
  var D = null;

  /** Non-interactive so the preview never eats a click meant for the map. */
  var PREVIEW_STYLE = {
    color: "#e67e22",
    weight: 3,
    dashArray: "7 5",
    fillColor: "#e67e22",
    fillOpacity: 0.08,
    interactive: false,
  };

  // Douglas-Peucker tolerances in degrees. Index 0 is "as delivered": the
  // server has already applied its own threshold, so simplifying below it is a
  // no-op that only costs a turf pass.
  var TOLERANCES = [0, 0.00005, 0.0001, 0.0002, 0.0005, 0.001];

  var _previewLayer = null;
  var _lookups = {}; // osm ref → Promise, so re-picking a result is free

  function init() {
    s = App.state;
    G = App.geometry;
    T = App.i18n.t;
    D = App.dom;
    App._loaded.push("boundary");
  }

  // ══════════════════════════════════════════════════════════════════════
  // ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @param {{name:string, properties?:{osmType?:string, osmId?:number|string}}} geocode
   *   A result from the geocoder in main.js.
   * @returns {Promise<boolean>} whether a suggestion was actually offered
   */
  function suggest(geocode) {
    var props = (geocode && geocode.properties) || {};
    if (!_mayHaveOutline(props)) return Promise.resolve(false);

    App.ui.showBusy(
      T("boundary.looking"),
      T("boundary.lookingStatus", { name: _shortName(geocode.name) }),
    );

    return _lookup(props.osmType, props.osmId)
      .then(function (payload) {
        App.ui.hideOverlay();
        if (!payload.geometry && !payload.bounds) {
          console.log(">>> No outline available for", geocode.name);
          return false;
        }
        _openDialog(payload, geocode);
        return true;
      })
      .catch(function (err) {
        App.ui.hideOverlay();
        console.warn(">>> Boundary lookup failed:", err && err.message);
        return false;
      });
  }

  /**
   * Nodes are points, so they never carry a polygon. Everything else is worth
   * asking about: a way may be a village outline, and a relation may be a
   * district, a forest or a postcode area.
   */
  function _mayHaveOutline(props) {
    if (!props || props.osmId == null) return false;
    var type = String(props.osmType || "").toLowerCase();
    return type === "way" || type === "relation";
  }

  function _lookup(osmType, osmId) {
    var ref = osmType + "/" + osmId;
    if (_lookups[ref]) return _lookups[ref];

    var url =
      "/geocode_boundary?osm_type=" +
      encodeURIComponent(osmType) +
      "&osm_id=" +
      encodeURIComponent(osmId);

    var promise = fetch(url).then(function (r) {
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

    // A failed lookup should not be remembered — the next attempt may succeed.
    promise.catch(function () {
      delete _lookups[ref];
    });
    _lookups[ref] = promise;
    return promise;
  }

  // ══════════════════════════════════════════════════════════════════════
  // DIALOG
  // ══════════════════════════════════════════════════════════════════════

  function _openDialog(payload, geocode) {
    var base = payload.geometry
      ? { type: "Feature", geometry: payload.geometry, properties: {} }
      : null;
    var boxFeature = _boundsFeature(payload.bounds);
    var current = base || boxFeature;
    var tolIndex = 0;

    var dialog = App.ui.openDialog("tpl-boundary-dialog", _clearPreview);

    D.text(dialog, "name", _shortName(payload.name || geocode.name));
    D.text(dialog, "meta", _metaLine(payload));

    var slider = D.role(dialog, "detail");
    var detailOut = D.role(dialog, "detail-out");
    var warn = D.role(dialog, "warn");
    var partsNote = D.role(dialog, "parts");
    var useBtn = D.role(dialog, "use");

    slider.max = String(TOLERANCES.length - 1);
    slider.value = "0";

    // No polygon at all: the rectangle is the only thing on offer, so the
    // detail slider and the separate rectangle button are noise.
    D.toggleRole(dialog, "row-detail", !!base);
    D.toggleRole(dialog, "box", !!base && !!boxFeature);
    if (!base) {
      // Re-target data-i18n as well as the text, so a language change does not
      // put the "we have an outline" wording back on a rectangle.
      var hint = D.role(dialog, "hint");
      hint.setAttribute("data-i18n", "boundary.hintBoxOnly");
      hint.textContent = T("boundary.hintBoxOnly");
      useBtn.setAttribute("data-i18n", "boundary.useBox");
      useBtn.textContent = T("boundary.useBox");
    }

    D.toggle(partsNote, payload.parts > 1);
    if (payload.parts > 1) {
      partsNote.textContent = T("boundary.parts", { count: payload.parts });
    }

    var overLimit =
      payload.areaKm2 != null &&
      payload.maxAreaKm2 != null &&
      payload.areaKm2 > payload.maxAreaKm2;
    D.toggle(warn, overLimit);
    if (overLimit) {
      // t() localizes numeric vars itself, so these go in raw.
      warn.textContent = T("boundary.tooBig", {
        area: _round(payload.areaKm2),
        max: payload.maxAreaKm2,
      });
    }

    function render() {
      current = base ? _simplify(base, TOLERANCES[tolIndex]) : boxFeature;
      _preview(current);
      if (base) {
        detailOut.textContent = T("boundary.detailValue", {
          metres: Math.round(TOLERANCES[tolIndex] * 111000),
          points: _countVertices(current.geometry),
        });
      }
      useBtn.disabled = !current;
    }

    slider.addEventListener("input", function () {
      tolIndex = Math.max(
        0,
        Math.min(TOLERANCES.length - 1, parseInt(slider.value, 10) || 0),
      );
      render();
    });

    D.onRole(dialog, "cancel", function () {
      App.ui.closeDialog();
    });

    D.onRole(dialog, "box", function () {
      if (boxFeature) _accept(boxFeature);
    });

    D.onRole(dialog, "use", function () {
      if (current) _accept(current);
    });

    render();
    if (current) {
      try {
        s.leafletMap.fitBounds(L.geoJSON(current).getBounds(), {
          padding: [40, 40],
        });
      } catch (e) {
        /* an unmappable preview still gets a dialog */
      }
    }
  }

  function _metaLine(payload) {
    var bits = [];
    var kind = payload.type || payload.category;
    if (kind) bits.push(String(kind).replace(/_/g, " "));
    if (payload.adminLevel)
      bits.push(T("boundary.adminLevel", { level: payload.adminLevel }));
    if (payload.areaKm2 != null)
      bits.push(T("boundary.area", { area: _round(payload.areaKm2) }));
    return bits.join(" · ");
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ══════════════════════════════════════════════════════════════════════

  function _preview(feature) {
    _clearPreview();
    if (!feature) return;
    try {
      _previewLayer = L.geoJSON(feature, { style: PREVIEW_STYLE }).addTo(
        s.leafletMap,
      );
    } catch (e) {
      console.warn(">>> Could not preview the boundary:", e.message);
    }
  }

  function _clearPreview() {
    if (_previewLayer) {
      s.leafletMap.removeLayer(_previewLayer);
      _previewLayer = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // APPLY
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Install the chosen outline as the outer boundary.
   *
   * Deliberately mirrors _adoptPolygon() in main.js rather than sharing code
   * with it: that function is an event handler for a Leaflet.Editable commit
   * and has to unhook the drawn layer first, which does not apply here.
   *
   * Only the largest ring is kept. The server's polygon_from_request() does the
   * same to a MultiPolygon, so keeping the exclaves client-side would draw an
   * outline the downloaded data does not cover.
   */
  function _accept(feature) {
    var poly = G.largestPolygon(feature);
    if (!poly) {
      alert(T("boundary.unusable"));
      return;
    }

    if (s.outerPolygonDrawn && !confirm(T("alert.replaceOuter"))) return;

    App.ui.closeDialog(); // teardown clears the preview

    var layer = G.toLayer(poly.geometry, App.polygons.OUTER_STYLE);
    if (!layer) {
      alert(T("boundary.unusable"));
      return;
    }

    layer.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
    });

    if (s.editMode) App.editing.toggleEditMode();
    if (s.mergeMode) App.editing.toggleMergeMode();
    if (s.leafletMap.editTools) s.leafletMap.editTools.stopDrawing();

    s.outerPolygonLayerGroup.clearLayers();
    s.outerPolygonLayerGroup.addLayer(layer);
    s.outerPolygonLayer = layer;
    s.outerPolygonDrawn = true;
    App.polygons.attachOuterEvents(layer);

    // The territories, streets and buildings that existed belonged to the
    // previous boundary. displayResults() drops them on a successful fetch, but
    // a fetch that fails — an area over the download limit is the common case —
    // would otherwise leave the old territory sitting under the new outline.
    // Clearing up front means the state is coherent either way, and there is
    // nothing sensible to undo back to.
    App.polygons.setClusters([], { silent: true });
    s.cachedStreets = null;
    s.cachedBuildings = null;
    s.cachedBounds = null;
    s.streetSegments = [];
    App.polygons.renderStreets([]);
    App.polygons.renderBuildings([]);
    if (App.history) App.history.clear();

    try {
      s.leafletMap.fitBounds(layer.getBounds(), { padding: [30, 30] });
    } catch (e) {
      /* keep the current view */
    }

    console.log(
      ">>> Outer boundary set from Nominatim —",
      _countVertices(poly.geometry),
      "points",
    );

    App.data.fetchData(poly).then(function () {
      _ensureWholeAreaCluster(poly);
    });
  }

  /**
   * Guarantee the whole-area cluster a hand-drawn polygon gets for free.
   *
   * ensureDefaultCluster() reads the geometry back out of the Leaflet layer and
   * bails quietly on anything it cannot normalize, which leaves a territory
   * with an outline but nothing to print or export. Here the feature that was
   * just installed is still in hand, so a bail-out can fall back to it directly
   * instead of ending up with no cluster at all.
   */
  function _ensureWholeAreaCluster(poly) {
    if (s.clusters.length > 0) return;
    if (App.polygons.ensureDefaultCluster()) return;

    App.polygons.setClusters([
      { type: "Feature", geometry: poly.geometry, properties: { auto: true } },
    ]);
    console.log(">>> Whole area set as a single cluster (from the boundary)");
  }

  // ══════════════════════════════════════════════════════════════════════
  // GEOMETRY HELPERS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Simplification can fold a thin peninsula into a self-intersection, which
   * turf.intersect and the partitioner both hate, so a result that loses its
   * shape or fails validation is discarded in favour of the original.
   */
  function _simplify(feature, tolerance) {
    if (!tolerance) return feature;
    var out;
    try {
      out = turf.simplify(feature, {
        tolerance: tolerance,
        highQuality: true,
        mutate: false,
      });
    } catch (e) {
      return feature;
    }
    if (!out || !out.geometry || _countVertices(out.geometry) < 4)
      return feature;
    try {
      if (turf.booleanValid && !turf.booleanValid(out)) return feature;
    } catch (e) {
      return feature;
    }
    return out;
  }

  function _countVertices(geometry) {
    function walk(node) {
      if (!Array.isArray(node)) return 0;
      if (typeof node[0] === "number") return 1;
      return node.reduce(function (sum, child) {
        return sum + walk(child);
      }, 0);
    }
    return geometry ? walk(geometry.coordinates) : 0;
  }

  function _boundsFeature(bounds) {
    if (!bounds) return null;
    try {
      return turf.polygon([
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.south],
          [bounds.east, bounds.north],
          [bounds.west, bounds.north],
          [bounds.west, bounds.south],
        ],
      ]);
    } catch (e) {
      return null;
    }
  }

  function _round(km2) {
    return km2 >= 100 ? Math.round(km2) : Math.round(km2 * 100) / 100;
  }

  /** display_name runs to six or seven comma-separated parts; three is plenty. */
  function _shortName(name) {
    if (!name) return "";
    var parts = String(name).split(",");
    return parts.slice(0, 3).join(",").trim();
  }

  return {
    init: init,
    suggest: suggest,
  };
})();

window.App = App;
