/**
 * main.js - entry point.
 *
 * Waits for the DOM, creates the Leaflet map with Leaflet.Editable, sets up
 * the layer groups, then initializes every other module in dependency order.
 */
(function () {
  "use strict";

  /**
   * How long the boot splash waits on the icon font before handing the page
   * over without it. Past this the blank squares are the better answer: they
   * fill in by themselves the moment the file lands.
   */
  var ICON_FONT_WAIT_MS = 2500;

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(_setup, 100);
  });

  function _setup() {
    if (typeof L === "undefined") {
      console.error(">>> Leaflet did not load — the map is unavailable.");
      // Nothing further runs on this path, so the splash comes down here.
      // What is behind it is broken, which is still more use than a spinner
      // for something that is not coming.
      _reveal();
      return;
    }
    var node = document.getElementById("map");
    if (!node) {
      console.error(">>> No #map element in the page.");
      _reveal();
      return;
    }
    // zoomControl: false - the two zoom buttons are tiles in the toolbar's
    // View group instead (see controls.js). Leaflet's own pair is a second
    // control in the same top-left corner, styled by leaflet.css rather than
    // by this app, so it reads as the one piece of chrome belonging to a
    // different program - and it names neither of its buttons.
    var map = L.map(node, {
      center: [47.3769, 8.5417],
      zoom: 13,
      zoomControl: false,
    });
    // Before i18n, deliberately: the map should have ground under it while the
    // dictionaries load. App.basemap adds whichever basemap was last chosen --
    // OSM unless someone switched to an aid layer - and the toolbar's View
    // group names them later, once there is a language to name them in.
    App.basemap.init(map);

    if (typeof L.Editable === "undefined") {
      console.error(
        ">>> Leaflet.Editable never loaded — drawing is unavailable.",
      );
    }
    _start(map);
  }

  function _start(map) {
    // Dictionaries must be in place before any module renders a template or
    // builds a string, so the whole start-up hangs off i18n.init().
    App.i18n
      .init()
      .then(function () {
        App.i18n.apply(document.body);
        _startTranslated(map);
      })
      // Start-up is straight-line and unguarded: the first module whose init()
      // throws takes every one after it with it, the hand-over at the end of
      // _startTranslated included. Catching it here keeps the reveal out of
      // that sequence, so a throw leaves a half-built page rather than a
      // spinner parked over one until the fail-safe expires.
      .catch(function (err) {
        console.error(">>> Start-up did not finish:", err);
      })
      .then(_revealWhenIconsAreIn);
  }

  function _startTranslated(map) {
    var s = App.state;
    s.leafletMap = map;

    // Leaflet.Editable
    if (typeof L.Editable !== "undefined" && !map.editTools) {
      try {
        map.editTools = new L.Editable(map, {});
      } catch (e) {
        console.error(">>> Leaflet.Editable failed to initialize:", e);
      }
    }

    // Before anything draws a corner handle: the size lives on the icon
    // class, and a marker already on the map keeps whatever size it was made
    // with. The boundary drawer is the first thing that can make one, and it
    // is reachable from the toolbar the moment the page settles.
    App.vertices.init();
    App.vertices.install();
    App.vertices.watch(map);

    // Panes
    // Stacking is stated here rather than left to draw order. Without these
    // panes it is a side effect of a call sequence: setClusters() builds cluster
    // layers and then calls refreshFilteredData(), so streets and buildings are
    // appended to the SVG after the territories and land on top. That happens to
    // be the right order - hovering a building should tell you about the
    // building - but whichever path is topmost receives the pointer events, so
    // it is not something to inherit by accident.
    //
    // The outer boundary sits at the bottom on purpose: it spans everything,
    // so anywhere else it would swallow every hover in the working area.
    [
      ["outerPane", 405],
      // Between the boundary and the territories: a gap never overlaps a
      // territory, so all this ordering decides is that it wins over the
      // boundary spanning it - which is the point, since the boundary would
      // otherwise swallow the hover.
      ["gapsPane", 408],
      ["clustersPane", 410],
      ["streetsPane", 420],
      ["buildingsPane", 430],
      // The trim proposal is a decision being previewed, so it sits above
      // everything it is a decision about - including the buildings, which is
      // the layer it is being judged against.
      ["trimPane", 440],
      // Above the lot: an annotation is a remark about everything underneath
      // it, and one hidden behind a building is a remark nobody reads. It is
      // also the topmost thing the pointer can hit, which is what makes
      // clicking a note to edit it work while a territory covers the same
      // ground.
      ["notesPane", 450],
    ].forEach(function (spec) {
      if (!map.getPane(spec[0])) map.createPane(spec[0]).style.zIndex = spec[1];
    });

    // Layer groups
    s.streetsLayerGroup = L.featureGroup().addTo(map);
    s.buildingsLayerGroup = L.featureGroup().addTo(map);
    s.gapsLayerGroup = L.featureGroup().addTo(map);
    s.innerPolygonsLayerGroup = L.featureGroup().addTo(map);
    s.outerPolygonLayerGroup = L.featureGroup().addTo(map);
    s.notesLayerGroup = L.featureGroup().addTo(map);

    // Modules, in dependency order. ui first, history after controls so the
    // undo and redo buttons exist when their state is first synced. dom needs
    // no init of its own.
    App.ui.init();
    // Before every module that pushes a context onto it, which is most of
    // them. It only installs one listener; the contexts arrive later.
    App.shortcuts.init();
    App.polygons.init();
    // After polygons: it reads isPrinted off it, and its chips go into the
    // same layer group as the territories themselves.
    App.labels.init();
    // After labels: the territory-number suggestions it builds are labels'
    // numbering, read back through numberOf.
    App.naming.init();
    App.data.init();
    App.session.init();
    // Before clustering: the partition hands it the polygonized blocks to
    // trade, and it reads geometry and spatial into its own init().
    App.balance.init();
    App.clustering.init();
    // Before editing and trim: both ask it for the street graph, and both
    // capture the module reference in their own init().
    App.network.init();
    App.editing.init();
    App.trim.init();
    // After trim: both reshape the outer boundary, and the outline editor
    // hands the same clipping step to App.polygons that trim does.
    App.outline.init();
    // After polygons and outline: it subtracts the territories from the
    // boundary, and both of those are what change underneath it.
    App.gaps.init();
    // Before autoheal, which surveys through it, and read by clustering at the
    // end of a partition for the same question: which boundaries are drawn
    // through a building.
    App.footprints.init();
    // Beside gaps rather than beside labels: both are repairs to the coverage
    // rather than descriptions of it, and both write through setClusters.
    App.autoheal.init();
    // After polygons and before print: notes are drawn over the territories
    // and printed onto the card that carries them.
    App.notes.init();
    App.print.init();
    App.boundary.init();
    _setupGeocoder(s);
    App.controls.init(map);
    App.history.init();
    App.demo.init();
    App.tour.init();
    App.pwa.init();

    App._loaded.forEach((element) => {
      console.log(">>> Module loaded:", element);
    });

    _setupDrawingKeys(map);

    // Map events
    map.on("move zoom", App.ui.closeContextMenu);
    map.on("contextmenu", _onMapContextMenu);
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

    console.log(">>> Ready. Draw an outer polygon to begin.");

    _restoreSession(s);
  }

  // Handing the page over

  /** Take the boot splash down. Defined in index.html.j2, so it may be absent. */
  function _reveal() {
    if (typeof window.hideBootSplash === "function") window.hideBootSplash();
  }

  /**
   * Hand the page over, once its icons will actually draw.
   *
   * Reaching this point means start-up has run to its end, whether that end
   * was a wired app or a module that threw; either way the page is as
   * finished as it is going to get. What it may still not be is legible: Font
   * Awesome ships `font-display: block`, so until its file arrives every icon
   * in the toolbar is drawn as nothing at all.
   *
   * Neither the tiles nor the session restore are waited on - see the splash
   * markup in index.html.j2 for the tiles, and note that the restore puts up
   * the loading overlay itself, which a second spinner would only delay.
   */
  function _revealWhenIconsAreIn() {
    var capped = new Promise(function (resolve) {
      window.setTimeout(resolve, ICON_FONT_WAIT_MS);
    });
    Promise.race([_iconFontsReady(), capped]).then(_reveal, _reveal);
  }

  /**
   * Settles once the fonts behind the icons on the page have loaded, or
   * straight away where the browser cannot resolve one.
   *
   * The families are read off those icons rather than named here: Font
   * Awesome's family string carries its major version ("Font Awesome 7 Free")
   * and the vendor tree is regenerated from package.json by a CI job, so a
   * literal would go stale one dependency bump later - resolving instantly, on
   * a page whose icons are still blank.
   *
   * fonts.load() is also what starts the fetch. An @font-face is a
   * declaration, and the file is only requested once something using it has
   * been laid out; for a toolbar built in JS that is later than the stylesheet
   * in the head suggests.
   */
  function _iconFontsReady() {
    var fonts = document.fonts;
    if (!fonts || typeof fonts.load !== "function") return Promise.resolve();

    var specs = {};
    var icons = document.querySelectorAll(".fa-solid, .fa-regular, .fa-brands");
    Array.prototype.forEach.call(icons, function (icon) {
      var style = window.getComputedStyle(icon);
      specs[style.fontWeight + " 1em " + style.fontFamily] = true;
    });

    return Promise.all(
      Object.keys(specs).map(function (spec) {
        // A family the browser cannot resolve rejects, and a spec it cannot
        // parse throws outright. Both are a reveal rather than a failure:
        // those icons are not coming, and waiting will not bring them.
        try {
          return fonts.load(spec).catch(function () {});
        } catch (e) {
          return Promise.resolve();
        }
      }),
    );
  }

  /**
   * Right-click on bare map.
   *
   * The layer handlers in polygons.js, gaps.js and trim.js all stop propagation,
   * so this only runs when there was nothing under the pointer. Without it that
   * case falls through to the browser's own menu - including in the modes whose
   * hint banner says "Right-click for the menu" and whose menu is the only place
   * some of their actions live.
   *
   * The cut tool is the one exception and has to stay one: it watches the
   * right button on the map container to pan with, and a menu opened from a
   * drag that happens to end where it started would fight the gesture.
   */
  function _onMapContextMenu(e) {
    var s = App.state;
    if (s.editMode) return;
    if (s.mergeMode) {
      App.editing.handleModeContextMenu(e.containerPoint, null, null);
      return;
    }
    if (s.trimMode) {
      App.trim.handleContextMenu(e.containerPoint, null);
      return;
    }
    if (s.outlineMode) {
      App.outline.handleContextMenu(e.containerPoint);
      return;
    }
    if (s.noteMode) {
      App.notes.handleContextMenu(e.containerPoint);
      return;
    }
    App.ui.showMapContextMenu(e.containerPoint);
  }

  /**
   * Bring back whatever the last visit left behind.
   *
   * session.js writes to IndexedDB on every edit, and this is the only reader.
   * Without it a reload discards the boundary, the downloaded streets and the
   * territories - which is a reload of any kind: F5, a PWA relaunch, or a
   * navigation.
   *
   * The view is applied last. applyPayload fits the whole territory, which is
   * the right default with nothing better to go on, but wrong when the last
   * thing the user did was zoom into one corner of it.
   */
  function _restoreSession(s) {
    App.session
      .restore()
      .then(function (restored) {
        if (restored) {
          console.log(">>> Session restored —", s.clusters.length, "clusters");
        }
        App.session.restoreView();
      })
      .catch(function (err) {
        console.warn(">>> Could not restore the session:", err && err.message);
      })
      .then(_offerTour);
  }

  /**
   * The walkthrough, on a first visit only.
   *
   * After the session restore rather than before it, because restoring can
   * open the boundary dialog and two modal things at once is worse than
   * neither; App.tour.maybeAutoStart() checks for exactly that and leaves the
   * flag alone if it backs off, so the next visit tries again. The delay lets
   * Leaflet finish placing its controls - the tour points at their boxes, and
   * measuring one mid-layout puts the spotlight in the wrong place.
   */
  function _offerTour() {
    setTimeout(function () {
      App.tour.maybeAutoStart();
    }, 700);
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

    function drawing() {
      return !!(map.editTools && map.editTools.drawing());
    }

    /**
     * Take back the last vertex.
     *
     * Leaflet.Editable has offered pop() since 1.3.0. Without it bound, the
     * boundary drawer is the one place in the app where a misplaced click can
     * only be answered by abandoning the whole shape and starting again --
     * while the split-line tool three meters away answers Backspace with
     * exactly this.
     */
    function popVertex() {
      var editor = map.editTools && map.editTools._drawingEditor;
      if (!editor || typeof editor.pop !== "function") return;
      if (_drawnVertexCount(editor) < 1) return;
      editor.pop();
    }

    var DRAW_KEYS = {
      id: "draw",
      titleKey: "shortcuts.groupDraw",
      entries: [
        {
          combos: ["Enter"],
          labelKey: "shortcuts.drawFinish",
          when: function () {
            return _drawnVertexCount(map.editTools._drawingEditor) >= 3;
          },
          run: function () {
            // Fewer than three vertices is not a polygon; committing would
            // produce geometry Leaflet.Editable then discards, silently
            // losing the draw.
            if (_drawnVertexCount(map.editTools._drawingEditor) < 3) return;
            map.editTools.commitDrawing();
            hideHint();
          },
        },
        {
          combos: ["Backspace", "Delete"],
          labelKey: "shortcuts.drawBack",
          when: function () {
            return drawing() && _drawnVertexCount(map.editTools._drawingEditor) > 0;
          },
          run: popVertex,
        },
        {
          combos: ["Escape"],
          labelKey: "shortcuts.drawCancel",
          run: function () {
            map.editTools.stopDrawing();
            hideHint();
          },
        },
        { combos: ["Double-click"], labelKey: "shortcuts.drawDouble", note: true },
      ],
    };

    map.on("editable:drawing:start", function () {
      showHint();
      App.shortcuts.push(DRAW_KEYS);
    });

    function done() {
      hideHint();
      App.shortcuts.pop("draw");
    }
    map.on("editable:drawing:end", done);
    map.on("editable:drawing:commit", done);
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
      App.polygons.setOuterLayer(layer);
      App.controls.refresh();

      // The download is offered, not assumed: the double-click that ends a
      // drawing is about the drawing. The whole area becomes one cluster
      // either way, so the boundary is printable and exportable without the
      // partitioner - and without OSM data, if that is declined.
      App.data.confirmAndFetch(geojson).then(function () {
        App.polygons.ensureDefaultCluster();
      });
    } else {
      // Carving a territory out of its neighbor re-tests every building
      // against every territory, which is a second of work on a town.
      App.ui.busy("loading.updating", function () {
        App.polygons.addInnerPolygon(layer, geojson);
      });
    }
  }

  // Address search, proxied through Flask so Nominatim sees one client
  //
  // Results carry their OSM identity (osm_type + osm_id) as well as a centre,
  // because App.boundary uses it to ask /geocode_boundary for the outline of
  // the place and offer it as the outer polygon. Without those two fields the
  // search box can only ever pan the map.
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
            return data
              .map(function (item) {
                var center = L.latLng(
                  parseFloat(item.lat),
                  parseFloat(item.lon),
                );
                if (isNaN(center.lat) || isNaN(center.lng)) return null;

                var bbox = item.boundingbox; // [south, north, west, east]
                var bounds =
                  Array.isArray(bbox) && bbox.length === 4
                    ? L.latLngBounds(
                        L.latLng(parseFloat(bbox[0]), parseFloat(bbox[2])),
                        L.latLng(parseFloat(bbox[1]), parseFloat(bbox[3])),
                      )
                    : L.latLngBounds(center, center);

                return {
                  name: item.display_name,
                  center: center,
                  bbox: bounds,
                  properties: {
                    osmType: item.osm_type,
                    osmId: item.osm_id,
                    category: item.class || item.category,
                    type: item.type,
                  },
                };
              })
              .filter(Boolean);
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

    var geocoder = L.Control.geocoder({
      // Top-right, which is a corner of its own: the zoom buttons and the
      // toolbar panel are both top-left, so the search does not have to compete
      // with them for width or be mistaken for one of them.
      position: "topright",
      // Always open. A search box that has to be found before it can be used
      // is a search box most people never find.
      collapsed: false,
      defaultMarkGeocode: false,
      placeholder: App.i18n.t("search.placeholder"),
      errorMessage: App.i18n.t("search.notFound"),
      geocoder: new FlaskNominatim(),
    })
      .on("markgeocode", function (e) {
        s.leafletMap.fitBounds(e.geocode.bbox, { padding: [30, 30] });
        _flashMarker(s, e.geocode);
        // Fire-and-forget: the outline arrives a moment later and opens its own
        // dialog, or quietly does not.
        App.boundary.suggest(e.geocode);
      })
      .addTo(s.leafletMap);

    // The plugin reads its strings once, at construction. That was harmless
    // while switching language meant a page load; now that the page survives
    // the switch, an English placeholder would sit in a Polish UI until the
    // next reload.
    App.i18n.onChange(function () {
      geocoder.options.errorMessage = App.i18n.t("search.notFound");
      var input = geocoder.getContainer().querySelector("input");
      if (input) input.placeholder = App.i18n.t("search.placeholder");
    });
  }

  /** A marker that names the hit and then gets out of the way. */
  function _flashMarker(s, geocode) {
    var marker = L.marker(geocode.center)
      .addTo(s.leafletMap)
      .bindPopup(geocode.name)
      .openPopup();
    setTimeout(function () {
      s.leafletMap.removeLayer(marker);
    }, 3000);
  }
})();
