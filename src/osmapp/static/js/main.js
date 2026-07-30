/**
 * main.js — entry point.
 *
 * Waits for the DOM, finds the Folium-generated Leaflet map, initializes
 * Leaflet.Editable, sets up layer groups, then wires the modules.
 *
 * Changes:
 *   • The L.Draw.Event.CREATED handler is gone. index.html never loaded
 *     Leaflet.draw, so that line only resolved because Folium injects it from
 *     a remote CDN — and when it did not resolve, the TypeError aborted setup
 *     before the geolocation handlers were registered. Drawing is now
 *     Leaflet.Editable only, started from the toolbar button in controls.js.
 *   • App.history.init() runs after App.controls.init(), so the undo/redo
 *     buttons exist by the time their state is first synced.
 *   • findMap() no longer stays around as a window scan for other modules to
 *     reuse; the map is captured once into s.leafletMap.
 *   • The unprompted geolocation request on load is gone. It fired without a
 *     user gesture, which browsers increasingly block and users find abrupt.
 *     The locate button in controls.js is the only trigger now.
 */
(function () {
  "use strict";

  var SETUP_RETRY_MS = 100;
  var SETUP_MAX_RETRIES = 50; // 5 s
  var _retries = 0;

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(_setup, 100);
  });

  function _findMap() {
    for (var key in window) {
      if (key.indexOf("map_") === 0 && window[key] instanceof L.Map)
        return window[key];
    }
    return null;
  }

  function _setup() {
    _retries++;
    var map = _findMap();
    var editableReady = typeof L.Editable !== "undefined";

    if (!map || !editableReady) {
      if (_retries <= SETUP_MAX_RETRIES) {
        setTimeout(_setup, SETUP_RETRY_MS);
      } else if (!map) {
        console.error(">>> No Leaflet map appeared after 5 s — giving up.");
      } else {
        console.error(
          ">>> Leaflet.Editable never loaded — drawing is unavailable.",
        );
        _start(map);
      }
      return;
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

    App.session.restore().then(function (restored) {
      if (restored)
        App.ui.setInfoFiltered(
          s.cachedStreets ? s.cachedStreets.features.length : 0,
          s.cachedBuildings ? s.cachedBuildings.features.length : 0,
          s.clusters.length,
        );
    });

    _setupGeocoder(s);

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
        .bindPopup("You are here");
    });

    console.log(
      ">>> Ready (attempt " + _retries + "). Draw an outer polygon to begin.",
    );
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
