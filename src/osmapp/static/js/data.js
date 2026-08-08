/**
 * data.js — Overpass fetching via the Flask backend, rendering, export/import.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.data = (function () {
  "use strict";

  var s = null;
  var G = null;
  var T = null;
  var PAYLOAD_VERSION = 3;

  function init() {
    s = App.state;
    G = App.geometry;
    T = App.i18n.t;
    App._loaded.push("data");
  }

  // ══════════════════════════════════════════════════════════════════════
  // FETCH
  // ══════════════════════════════════════════════════════════════════════
  //
  // Overpass is a shared, free, frequently overloaded service. A download that
  // fails is far more often "come back in ten seconds" than "this will never
  // work", and the old behavior — one attempt, then an alert — turned a
  // transient 504 into lost work and a user who has to find the re-download
  // button and guess how long to wait.
  //
  // So a failure that looks temporary is retried with exponential backoff and
  // jitter, the overlay says what is happening and counts down, and the whole
  // thing can be abandoned from the Cancel button. Waiting is the user's only
  // job; the app should be the one that knows how long to wait.
  //
  // What is not retried: 400 (a malformed or oversized polygon), 404 (the area
  // genuinely has no streets), and anything else the server marks
  // retryable: false. Retrying those only delays the message that explains them.

  var RETRY_ATTEMPTS = 5; // total tries per request, not extra tries
  var RETRY_BASE_MS = 2000; // first backoff; doubles from there
  var RETRY_MAX_MS = 30000; // ceiling, so attempt 5 is not a four-minute wait
  var RETRY_TICK_MS = 250; // countdown refresh

  var _abort = null; // AbortController for the in-flight request
  var _retryTimer = null;
  var _cancelled = false;

  /**
   * @param {Object} geojson polygon to download
   * @param {boolean} [forceRefresh] ignore the cache
   * @returns {Promise<{cancelled?:boolean, failed?:boolean}>} always resolves
   */
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
      return Promise.resolve({});
    }

    _cancelled = false;
    App.ui.showBusy(
      T("loading.streets"),
      T("loading.streetsStatus"),
      cancelFetch,
    );

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
        return {};
      })
      .catch(function (err) {
        App.ui.hideOverlay();

        if (err && err.cancelled) {
          console.log(">>> Download cancelled");
          App.ui.setInfo({
            titleKey: "info.notLoaded",
            hintKey: "info.hintNotLoaded",
          });
          return { cancelled: true };
        }

        console.error(">>> Fetch failed:", err);
        alert(
          err && err.attempts > 1
            ? T("alert.fetchFailedRetries", {
                message: err.message,
                attempts: err.attempts,
              })
            : T("alert.fetchFailed", { message: err.message }),
        );
        App.ui.setInfo({
          titleKey: "info.notLoaded",
          hintKey: "info.hintNotLoaded",
        });
        return { failed: true };
      });
  }

  /**
   * Ask before spending a minute of someone's time and a slice of a shared
   * public service on a download they may not have meant to start.
   *
   * Committing a polygon and picking a search result both used to fire a
   * download on the spot, which is the wrong default: the click that ends a
   * drawing is about the drawing, and a search result is often just a way to
   * pan the map.
   *
   * @returns {Promise<{cancelled?:boolean, failed?:boolean}>}
   */
  function confirmAndFetch(geojson, opts) {
    opts = opts || {};
    return App.ui
      .confirm({
        titleKey: "confirm.downloadTitle",
        messageKey: "confirm.downloadMessage",
        detail: _areaLine(geojson),
        okKey: "confirm.download",
        cancelKey: "confirm.later",
      })
      .then(function (ok) {
        if (!ok) {
          App.ui.setInfo({
            titleKey: "info.notLoaded",
            hintKey: "info.hintNotLoaded",
          });
          if (App.controls) App.controls.refresh();
          return { cancelled: true };
        }
        return fetchData(geojson, opts.force);
      });
  }

  /** "About 12.4 km²" — the one number that predicts how long this will take. */
  function _areaLine(geojson) {
    try {
      var km2 = turf.area(G.feat(geojson)) / 1e6;
      return T("confirm.downloadArea", {
        area: km2 >= 100 ? Math.round(km2) : Math.round(km2 * 100) / 100,
      });
    } catch (e) {
      return "";
    }
  }

  /** Abandon the download in flight, including a pending backoff. */
  function cancelFetch() {
    _cancelled = true;
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (_abort) {
      try {
        _abort.abort();
      } catch (e) {
        /* already finished */
      }
    }
    App.ui.hideOverlay();
  }

  function _post(url, body) {
    var attempt = 0;

    function attemptOnce() {
      attempt++;
      _abort = window.AbortController ? new window.AbortController() : null;

      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: _abort ? _abort.signal : undefined,
      })
        .then(_parse, function (err) {
          // fetch only rejects on a transport problem — DNS, a dropped
          // connection, a proxy timeout, or our own abort() — so everything
          // that lands here except a cancellation is worth another try.
          if (_cancelled) throw _cancelledError();
          throw _retryableError(
            (err && err.message) || "Network request failed",
          );
        })
        .catch(function (err) {
          if (_cancelled) throw _cancelledError();
          err.attempts = attempt;
          if (!err.retryable || attempt >= RETRY_ATTEMPTS) throw err;
          return _backoff(attempt, err).then(attemptOnce);
        });
    }

    return attemptOnce();
  }

  function _parse(response) {
    return response.json().then(
      function (data) {
        if (response.ok && !data.error) return data;
        throw _httpError(
          data.error || "Server returned " + response.status,
          response.status,
          data.retryable,
        );
      },
      function () {
        // A non-JSON body means a proxy or gateway answered instead of Flask,
        // which is exactly the transient case worth retrying.
        throw _httpError("Server returned " + response.status, response.status);
      },
    );
  }

  function _httpError(message, status, retryable) {
    var err = new Error(message);
    err.status = status;
    err.retryable =
      retryable != null ? !!retryable : _statusIsRetryable(status);
    return err;
  }

  function _retryableError(message) {
    var err = new Error(message);
    err.retryable = true;
    return err;
  }

  function _cancelledError() {
    var err = new Error("cancelled");
    err.cancelled = true;
    return err;
  }

  function _statusIsRetryable(status) {
    return (
      status === 408 || // request timeout
      status === 425 || // too early
      status === 429 || // rate limited — Overpass says this often
      status === 500 ||
      status === 502 || // our own "Overpass may be busy"
      status === 503 ||
      status === 504
    );
  }

  /**
   * Wait out one backoff, counting down in the overlay so the wait reads as a
   * plan rather than a hang.
   */
  function _backoff(attempt, err) {
    var delay = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * Math.pow(2, attempt - 1),
    );
    // Jitter, so that two tabs that failed together do not retry together.
    delay = Math.round(delay * (0.85 + Math.random() * 0.3));

    console.warn(
      ">>> Attempt " +
        attempt +
        " of " +
        RETRY_ATTEMPTS +
        " failed (" +
        err.message +
        ") — retrying in " +
        delay +
        " ms",
    );

    return new Promise(function (resolve, reject) {
      var until = Date.now() + delay;

      function tick() {
        if (_cancelled) {
          reject(_cancelledError());
          return;
        }
        var left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        if (left <= 0) {
          App.ui.setOverlayStatus(
            T("loading.retrying", {
              attempt: attempt + 1,
              total: RETRY_ATTEMPTS,
            }),
          );
          resolve();
          return;
        }
        App.ui.setOverlayStatus(
          T("loading.retryIn", {
            count: left,
            attempt: attempt + 1,
            total: RETRY_ATTEMPTS,
          }),
        );
        _retryTimer = setTimeout(tick, RETRY_TICK_MS);
      }

      tick();
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
    if (App.controls) App.controls.refresh();

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
      version: PAYLOAD_VERSION,
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
    a.download = "partition_export_" + Math.floor(Date.now() / 1000) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Safari and older Firefox have not started the transfer when click()
    // returns; revoking synchronously cancels it.
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    console.log(">>> Exported", payload.clusters.length, "clusters");
  }

  /**
   * Apply a saved bundle: outer boundary, streets, buildings, territories.p
   * Shared by file import and session restore.
   * @param {{outerPolygon, streets, buildings, bounds, clusters}} payload
   */
  function applyPayload(payload) {
    if (payload && payload.version != null && payload.version !== PAYLOAD_VERSION) {
      throw new Error("unsupported export version " + payload.version);
    }

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

      var restored;
      try {
        restored = applyPayload(payload);
      } catch (err) {
        console.error(">>> Import failed:", err);
        alert(T("alert.importInvalid", { message: err.message }));
        return;
      }
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
    if (!s.cachedPolygon) return false;
    try {
      return turf.booleanContains(s.cachedPolygon, G.feat(geojson));
    } catch (e) {
      return false;
    }
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
    // Read by session.js at load time to key its stored records; it must
    // move with the export format, not be re-typed beside it.
    PAYLOAD_VERSION: PAYLOAD_VERSION,
    fetchData: fetchData,
    confirmAndFetch: confirmAndFetch,
    cancelFetch: cancelFetch,
    displayResults: displayResults,
    exportData: exportData,
    importData: importData,
    buildPayload: buildPayload,
    applyPayload: applyPayload,
  };
})();

window.App = App;
