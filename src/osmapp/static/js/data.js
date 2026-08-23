/**
 * data.js - Overpass fetching via the Flask backend, rendering, export/import.
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

  // FETCH
  //
  // Overpass is a shared, free, frequently overloaded service. A download that
  // fails is far more often "come back in ten seconds" than "this will never
  // work", so a single attempt followed by an alert turns a transient 504 into
  // lost work and a user guessing how long to wait.
  //
  // A failure that looks temporary is therefore retried with exponential
  // backoff and jitter, the overlay says what is happening and counts down,
  // and the whole thing can be abandoned from the Cancel button.
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
   * @param {boolean} [forceRefresh] accepted and ignored; there is no cache
   *   to bypass, and the body below says why
   * @returns {Promise<{cancelled?:boolean, failed?:boolean}>} always resolves
   */
  function fetchData(geojson, forceRefresh) {
    // Every call downloads. There is no cache to consult: `s.cachedPolygon`,
    // the field a "have we already covered this area" check would read, is
    // assigned nowhere in the app, and `forceRefresh` is accepted but never
    // read. Skipping a download the user has just confirmed also needs an
    // answer for what a confirmed download that then does not happen looks
    // like on screen.
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
   * Committing a polygon and picking a search result both reach here, and
   * neither should download on the spot: the click that ends a drawing is about
   * the drawing, and a search result is often only a way to pan the map.
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

  /** "About 12.4 km2" - the one number that predicts how long this will take. */
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
          // fetch only rejects on a transport problem - DNS, a dropped
          // connection, a proxy timeout, or this module's own abort() - so
          // everything that lands here except a cancellation is worth another
          // try.
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
      status === 429 || // rate limited - Overpass says this often
      status === 500 ||
      status === 502 || // this app's own "Overpass may be busy"
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

  // RENDER

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

  // EXPORT / IMPORT

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
      // Additive rather than a version bump. PAYLOAD_VERSION is a
      // compatibility gate that throws, so raising it for a new optional key
      // would discard every session and every export file already out there --
      // for a field an older build ignores and a newer one defaults to empty.
      notes: App.notes.all(),
    };
  }

  /**
   * The project state, minus everything that can be downloaded again.
   *
   * buildPayload() is a session snapshot and carries `streets` and
   * `buildings` - the whole OSM cache, which for a town is a few megabytes of
   * geometry. That is the right thing to write into a file somebody chose to
   * save; it is the wrong thing to staple to every printed card, where it
   * would multiply the size of the PDF by an order of magnitude for data that
   * Overpass will hand back on request.
   *
   * What is left is the part nobody can recover: the boundary somebody drew,
   * the way it was divided, and which territories have been done. Importing
   * from a card restores those and offers to re-download the rest.
   */
  function buildAttachmentPayload() {
    var payload = buildPayload();
    if (!payload.outerPolygon) throw new Error("no boundary to attach");
    return {
      version: payload.version,
      exportedAt: payload.exportedAt,
      outerPolygon: payload.outerPolygon,
      bounds: payload.bounds,
      clusters: payload.clusters,
      // Kept, unlike the OSM cache: an annotation is somebody's own remark
      // about the ground and nothing can hand it back.
      notes: payload.notes,
      // Says the OSM cache was left out on purpose, so applyPayload can tell
      // "printed card" from "export that lost its streets somehow".
      partial: true,
    };
  }

  /**
   * Offer the full session bundle as a .json download.
   *
   * Everything buildPayload() holds, OSM cache included, so the file reopens
   * without a network. Does nothing but warn when there is no boundary yet.
   */
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
   * Apply a saved bundle: outer boundary, streets, buildings, territories.
   * Shared by file import and session restore.
   *
   * @param {{outerPolygon, streets, buildings, bounds, clusters, notes}} payload
   * @returns {number} how many territories were restored; a payload with none
   *   gets the default single territory covering the whole boundary
   * @throws when the version does not match or the boundary is unusable
   */
  function applyPayload(payload) {
    if (payload && payload.version != null && payload.version !== PAYLOAD_VERSION) {
      throw new Error("unsupported export version " + payload.version);
    }

    _ensureLayerGroups();

    var outer = G.largestPolygon(payload.outerPolygon);
    if (!outer) throw new Error("no usable outer boundary");

    App.polygons.setOuterLayer(
      G.toLayer(outer.geometry, App.polygons.OUTER_STYLE),
    );

    s._skipOuterClear = true;
    displayResults({
      streets: payload.streets,
      buildings: payload.buildings,
      bounds: payload.bounds || _bboxToBounds(turf.bbox(outer)),
    });
    s._skipOuterClear = false;

    // A payload with no notes in it clears them, which is what applying a
    // project means: the annotations on screen belong to the one being
    // replaced, and keeping them would scatter another area's remarks over
    // this one.
    App.notes.restore(payload.notes);

    var restored = App.polygons.setClusters(payload.clusters || []);
    if (restored === 0) {
      App.polygons.ensureDefaultCluster();
      restored = s.clusters.length;
    }
    return restored;
  }

  /**
   * Import a saved project, from an export file or from a printed card.
   *
   * A card is a PDF with the project embedded in it, so the two paths differ
   * only in how the JSON is obtained - the server unpacks the attachment and
   * hands back exactly what a .json export would have contained. Everything
   * after that is shared, including the failure messages, because "this file
   * is not a project" means the same thing whichever wrapper it arrived in.
   */
  function importData(file) {
    if (_looksLikePdf(file)) {
      _readProjectFromPdf(file).then(function (payload) {
        if (payload) _applyImported(payload);
      });
      return;
    }

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
      _applyImported(payload);
    };

    reader.readAsText(file);
  }

  function _looksLikePdf(file) {
    if (!file) return false;
    if (file.type === "application/pdf") return true;
    return /\.pdf$/i.test(file.name || "");
  }

  /** @returns {Promise<Object|null>} null when it has already been reported */
  function _readProjectFromPdf(file) {
    App.ui.showBusy(T("loading.readingCard"));
    return App.pdfdoc
      .extractProject(file)
      .catch(function (err) {
        console.error(">>> Could not read the card:", err);
        alert(T("alert.importNoProject", { message: err.message }));
        return null;
      })
      .then(function (payload) {
        App.ui.hideOverlay();
        return payload;
      });
  }


  function _applyImported(payload) {
    var ok = false;
    // Behind the spinner for the same reason the session restore is, and with
    // the same `always` - see session.js. Opening a project is a second of
    // blocked main thread on a town, plus the gap recount behind it, and
    // nothing has measured this project yet to say so.
    App.ui
      .busy(
        "loading.importing",
        function () {
          var restored;
          try {
            restored = applyPayload(payload);
          } catch (err) {
            console.error(">>> Import failed:", err);
            alert(T("alert.importInvalid", { message: err.message }));
            return;
          }
          if (App.history) App.history.clear();
          ok = true;

          console.log(
            ">>> Import complete — streets:",
            s.cachedStreets.features.length,
            "buildings:",
            s.cachedBuildings.features.length,
            "clusters:",
            restored,
          );
        },
        { always: true },
      )
      .then(function () {
        // A card carries the boundary and the territories but not the OSM
        // cache, which is deliberate - see buildAttachmentPayload. Offered
        // rather than assumed, for the same reason drawing a boundary offers
        // it: the download is the slow part, and somebody who only wanted to
        // look at last round's territories should not have to wait for it.
        //
        // After the overlay comes down, not under it: this asks a question,
        // and a dialog behind a spinner is a dialog nobody can answer.
        if (ok && payload && payload.partial) confirmAndFetch(payload.outerPolygon);
      });
  }

  // PRIVATE

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
    exportData: exportData,
    buildAttachmentPayload: buildAttachmentPayload,
    importData: importData,
    buildPayload: buildPayload,
    applyPayload: applyPayload,
  };
})();

window.App = App;
