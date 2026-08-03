/**
 * main.js — entry point.
 *
 * Waits for the DOM, finds the initializes Leaflet.Editable,
 * sets up layer groups, then wires the modules.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(_setup, 100);
  });

  function _setup() {
    if (typeof L === "undefined") {
      console.error(">>> Leaflet did not load — the map is unavailable.");
      return;
    }
    var node = document.getElementById("map");
    if (!node) {
      console.error(">>> No #map element in the page.");
      return;
    }
    var map = L.map(node, { center: [47.3769, 8.5417], zoom: 13 });
    L.tileLayer("/tiles/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    if (typeof L.Editable === "undefined") {
      console.error(">>> Leaflet.Editable never loaded — drawing is unavailable.");
    }
    _start(map);
  }

  function _start(map) {
    // Dictionaries must be in place before any module renders a template or
    // builds a string, so the whole start-up hangs off i18n.init().
    App.i18n.init().then(function () {
      App.i18n.apply(document.body);
      _startTranslated(map);
    });
  }

  function _startTranslated(map) {
    var s = App.state;
    s.leafletMap = map;

    // ── Leaflet.Editable ────────────────────────────────────────────────
    if (typeof L.Editable !== "undefined" && !map.editTools) {
      try {
        map.editTools = new L.Editable(map, {});
      } catch (e) {
        console.error(">>> Leaflet.Editable failed to initialize:", e);
      }
    }

    // ── Layer groups ────────────────────────────────────────────────────
    s.streetsLayerGroup = L.featureGroup().addTo(map);
    s.buildingsLayerGroup = L.featureGroup().addTo(map);
    s.innerPolygonsLayerGroup = L.featureGroup().addTo(map);
    s.outerPolygonLayerGroup = L.featureGroup().addTo(map);

    // ── Modules — dom and ui first, history after controls so the undo and
    //    redo buttons exist when their state is first synced ─────────────
    App.ui.init();
    App.polygons.init();
    App.data.init();
    App.session.init();
    App.clustering.init();
    App.editing.init();
    App.print.init();
    App.controls.init(map);
    App.history.init();

    App._loaded.forEach(element => {
      console.log(">>> Module loaded:", element);
    });

    _setupGeocoder(s);

    _setupDrawingKeys(map);

    // ── Map events ──────────────────────────────────────────────────────
    map.on("move zoom", App.ui.closeContextMenu);
    map.on("editable:drawing:commit", function (e) {
      _adoptPolygon(s, map, e.layer);
    });

    map.on("locationfound", function (e) {
      if (s.userLocationMarker) map.removeLayer(s.userLocationMarker);
      s.userLocationMarker = L.circleMarker(e.latlng, {
        radius: 8,
        color: "#3498db",
        fillColor: "#3498db",
        fillOpacity: 0.5,
        weight: 3,
      })
        .addTo(map)
        .bindPopup(App.i18n.t("map.youAreHere"));
    });

    console.log(
      ">>> Ready. Draw an outer polygon to begin.",
    );
  }

  /**
   * Enter closes the outer polygon by committing the drawing; Leaflet.Editable
   * joins the last vertex to the first, since a polygon ring is closed by
   * definition. Escape abandons it.
   *
   * A hint banner is shown for the duration, because otherwise nothing tells
   * anyone the Enter shortcut exists.
   */
  function _setupDrawingKeys(map) {
    var hint = null;

    function showHint() {
      if (hint) return;
      hint = App.dom.mountOnMap("tpl-draw-hint", map);
      // The template carries data-i18n="draw.hint" for the split-line tool.
      // Re-target the key as well as the text, so a later i18n.apply() does not
      // put the split-line wording back.
      hint.setAttribute("data-i18n", "draw.outerHint");
      hint.textContent = App.i18n.t("draw.outerHint");
    }

    function hideHint() {
      hint = App.dom.remove(hint);
    }

    map.on("editable:drawing:start", showHint);
    map.on("editable:drawing:end", hideHint);
    map.on("editable:drawing:commit", hideHint);

    document.addEventListener("keydown", function (e) {
      if (!map.editTools || !map.editTools.drawing()) return;

      if (e.key === "Escape") {
        e.preventDefault();
        map.editTools.stopDrawing();
        hideHint();
        return;
      }

      if (e.key !== "Enter") return;
      e.preventDefault();

      // Fewer than three vertices is not a polygon; committing would produce
      // geometry Leaflet.Editable then discards, silently losing the draw.
      if (_drawnVertexCount(map.editTools._drawingEditor) < 3) return;
      map.editTools.commitDrawing();
      hideHint();
    });
  }

  /** Vertices placed so far, preferring the public path over the private one. */
  function _drawnVertexCount(editor) {
    if (!editor) return 0;
    try {
      var rings = editor.feature.getLatLngs();
      var ring = Array.isArray(rings[0]) ? rings[0] : rings;
      if (Array.isArray(ring)) return ring.length;
    } catch (e) {
      /* fall through */
    }
    return Array.isArray(editor._drawnLatLngs)
      ? editor._drawnLatLngs.length
      : 0;
  }

  /** Route a freshly committed polygon to the outer boundary or a cluster. */
  function _adoptPolygon(s, map, layer) {
    var geojson = layer.toGeoJSON();
    var type = geojson.geometry && geojson.geometry.type;
    if (type !== "Polygon" && type !== "MultiPolygon") return;

    // Stop the shape from swallowing map clicks.
    layer.off("click");
    layer.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
    });

    if (
      map.editTools.featuresLayer &&
      map.editTools.featuresLayer.hasLayer(layer)
    ) {
      map.editTools.featuresLayer.removeLayer(layer);
    }

    if (!s.outerPolygonDrawn) {
      layer.setStyle(App.polygons.OUTER_STYLE);
      s.outerPolygonLayerGroup.clearLayers();
      s.outerPolygonLayerGroup.addLayer(layer);
      s.outerPolygonLayer = layer;
      s.outerPolygonDrawn = true;
      App.polygons.attachOuterEvents(layer);
      // The whole area becomes one cluster straight away, so the territory is
      // printable and exportable without running the partitioner.
      App.data.fetchData(geojson).then(function () {
        App.polygons.ensureDefaultCluster();
      });
    } else {
      App.polygons.addInnerPolygon(layer, geojson);
    }
  }

  // ── Address search, proxied through Flask so Nominatim sees one client ──
  function _setupGeocoder(s) {
    if (
      typeof L.Control === "undefined" ||
      typeof L.Control.Geocoder === "undefined"
    ) {
      console.warn(
        ">>> leaflet-control-geocoder not available — address search is off",
      );
      return;
    }

    var FlaskNominatim = L.Class.extend({
      _fetch: function (query) {
        return fetch("/geocode?q=" + encodeURIComponent(query) + "&limit=5")
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            if (!Array.isArray(data)) return [];
            return data.map(function (item) {
              var bbox = item.boundingbox; // [south, north, west, east]
              return {
                name: item.display_name,
                center: L.latLng(parseFloat(item.lat), parseFloat(item.lon)),
                bbox: L.latLngBounds(
                  L.latLng(parseFloat(bbox[0]), parseFloat(bbox[2])),
                  L.latLng(parseFloat(bbox[1]), parseFloat(bbox[3])),
                ),
              };
            });
          })
          .catch(function () {
            return [];
          });
      },

      geocode: function (query, cb, context) {
        return this._fetch(query).then(function (results) {
          if (typeof cb === "function") cb.call(context, results);
          return results; // the plugin awaits the return value
        });
      },

      suggest: function (query, cb, context) {
        return this.geocode(query, cb, context);
      },

      reverse: function (location, scale, cb, context) {
        if (typeof cb === "function") cb.call(context, []);
        return Promise.resolve([]);
      },
    });

    L.Control.geocoder({
      position: "topright",
      defaultMarkGeocode: false,
      placeholder: "Search address…",
      errorMessage: "Nothing found.",
      geocoder: new FlaskNominatim(),
    })
      .on("markgeocode", function (e) {
        s.leafletMap.fitBounds(e.geocode.bbox, { padding: [30, 30] });
        var marker = L.marker(e.geocode.center)
          .addTo(s.leafletMap)
          .bindPopup(e.geocode.name)
          .openPopup();
        setTimeout(function () {
          s.leafletMap.removeLayer(marker);
        }, 3000);
      })
      .addTo(s.leafletMap);
  }
})();
