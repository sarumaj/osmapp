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
   * Download everything inside a boundary, one area at a time.
   *
   * The server takes a single polygon and refuses one over MAX_AREA_KM2,
   * which is what keeps a careless drag off Overpass' back. A boundary holding
   * three villages is therefore three pairs of requests rather than one pair
   * over their common bounding box - which for villages twenty kilometers
   * apart is a request for the farmland between them, and a refusal.
   *
   * @param {Object} geojson polygon or multipolygon to download
   * @param {{force?: boolean, merge?: boolean}} [opts] `force` is accepted and
   *   ignored; there is no cache to bypass, and the body below says why.
   *   `merge` adds what comes back to the data already on screen, for an area
   *   joining a project that is already open.
   * @returns {Promise<{cancelled?:boolean, failed?:boolean}>} always resolves
   */
  function fetchData(geojson, opts) {
    opts = opts || {};
    // Every call downloads. There is no cache to consult: `s.cachedPolygon`,
    // the field a "have we already covered this area" check would read, is
    // assigned nowhere in the app, and `opts.force` is accepted but never
    // read. Skipping a download the user has just confirmed also needs an
    // answer for what a confirmed download that then does not happen looks
    // like on screen.
    var areas = G.polygonParts(geojson);
    if (!areas.length) return Promise.resolve({ failed: true });

    _cancelled = false;
    App.ui.showBusy(
      T("loading.streets"),
      _areaStatus("loading.streetsStatus", 0, areas.length),
      cancelFetch,
    );

    var streets = [];
    var buildings = [];
    var bounds = null;

    /** Recursive rather than a loop: each area is two awaited requests. */
    function fetchArea(index) {
      if (index >= areas.length) return Promise.resolve();
      App.ui.setOverlayText(
        T("loading.streets"),
        _areaStatus("loading.streetsStatus", index, areas.length),
      );
      return _post("/fetch_streets", areas[index])
        .then(function (data) {
          streets = streets.concat((data.streets || {}).features || []);
          App.ui.setOverlayText(
            T("loading.buildings"),
            _areaStatus("loading.buildingsStatus", index, areas.length),
          );
          return _post("/fetch_buildings", areas[index]);
        })
        .then(function (data) {
          buildings = buildings.concat((data.buildings || {}).features || []);
          bounds = _widen(bounds, data.bounds);
          return fetchArea(index + 1);
        });
    }

    return fetchArea(0)
      .then(function () {
        App.ui.setOverlayText(T("loading.preparing"), "");
        App.ui.hideOverlay();
        s._skipOuterClear = true;
        displayResults(
          {
            streets: { type: "FeatureCollection", features: streets },
            buildings: { type: "FeatureCollection", features: buildings },
            bounds: bounds,
          },
          { merge: !!opts.merge },
        );
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
   * @param {Object} geojson polygon or multipolygon to download
   * @param {{force?: boolean, merge?: boolean}} [opts] passed through to
   *   fetchData
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
        return fetchData(geojson, opts);
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

  /**
   * The overlay's second line, told which area of how many it is on.
   *
   * Silent about it when there is only one, which is every project drawn
   * rather than assembled: "area 1 of 1" is a progress report on a job with no
   * progress to report.
   */
  function _areaStatus(key, index, total) {
    var status = T(key);
    if (total < 2) return status;
    var progress = T("loading.areaProgress", {
      index: index + 1,
      total: total,
    });
    return status + " " + progress;
  }

  /** The smallest bounds box holding both, either of which may be missing. */
  function _widen(box, next) {
    if (!next) return box;
    if (!box) return next;
    return {
      west: Math.min(box.west, next.west),
      south: Math.min(box.south, next.south),
      east: Math.max(box.east, next.east),
      north: Math.max(box.north, next.north),
    };
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

  /**
   * @param {Object} data streets, buildings and bounds to draw
   * @param {{merge?: boolean}} [opts] merge folds the data into what is
   *   already cached and leaves the territories alone, for an area joining a
   *   project that is already open. Without it this is a fresh download and
   *   the territories belong to the area being replaced.
   */
  function displayResults(data, opts) {
    var merge = !!(opts && opts.merge);

    if (!s._skipOuterClear) {
      s.outerPolygonLayerGroup.clearLayers();
      s.outerPolygonLayer = null;
    }
    if (!merge) App.polygons.setClusters([], { silent: true });

    s.cachedStreets = merge
      ? _mergedCollection(s.cachedStreets, data.streets)
      : data.streets || { type: "FeatureCollection", features: [] };
    s.cachedBuildings = merge
      ? _mergedCollection(s.cachedBuildings, data.buildings)
      : data.buildings || { type: "FeatureCollection", features: [] };
    s.cachedBounds = merge
      ? _widen(s.cachedBounds, data.bounds)
      : data.bounds || null;
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
   * @param {{merge?: boolean}} [opts] merge adds the bundle to the project on
   *   screen instead of replacing it - see _merged for what that means for
   *   each part of it
   * @returns {number} how many territories were restored; a payload with none
   *   gets the default single territory covering the whole boundary
   * @throws when the version does not match or the boundary is unusable
   */
  function applyPayload(payload, opts) {
    if (payload && payload.version != null && payload.version !== PAYLOAD_VERSION) {
      throw new Error("unsupported export version " + payload.version);
    }

    _ensureLayerGroups();

    if (opts && opts.merge && s.outerPolygonLayer) payload = _merged(payload);

    var outer = _boundary(payload.outerPolygon);
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
    // this one. A merge has already folded the two lists together.
    App.notes.restore(payload.notes);

    var restored = App.polygons.setClusters(payload.clusters || []);
    if (restored === 0) {
      App.polygons.ensureDefaultCluster();
      restored = s.clusters.length;
    }
    return restored;
  }

  /**
   * The boundary out of a payload, with every area of it kept.
   *
   * largestPolygon() stood here until a project could hold more than one area.
   * It is the right answer for a file that has picked up a stray sliver from a
   * clipping bug, and exactly the wrong one for a three-village project saved
   * by this build: it would open as the biggest village, with the other two
   * gone and nothing said.
   *
   * @returns {Object|null} Feature<Polygon|MultiPolygon>
   */
  function _boundary(x) {
    return G.multiPolygonOf(G.polygonParts(x));
  }

  // MERGING TWO PROJECTS
  //
  // A wall map of a circuit is several projects: villages surveyed on
  // different evenings, or one town split across two machines because nobody
  // wanted to send a nine-megabyte file twice. Merging them is what turns that
  // into one sheet - and it is the only operation in the app where two
  // boundaries meet, which is why the rules are written down here rather than
  // inferred from each helper.
  //
  //   - The **boundary** gains the incoming areas. Two that overlap are
  //     dissolved into one; two that are disjoint stay separate, which is what
  //     makes the boundary a MultiPolygon and the reason the rest of the app
  //     learned to expect one.
  //   - **Territories** are appended, minus any ground the project already
  //     covers. Territories not overlapping is the one invariant the building
  //     counts, the gap finder and the printed marks all read, and the shapes
  //     already on screen are the ones somebody has been working on.
  //   - **Streets and buildings** are appended and de-duplicated by OSM id, so
  //     two downloads that shared a boundary street do not draw it twice.
  //   - **Notes** are appended. They are somebody's own remarks about ground
  //     that is still there, and there is no version of "the same note twice"
  //     that can be recognized.

  /** The project on screen with `incoming` folded into it. */
  function _merged(incoming) {
    var current = buildPayload();
    var clusters = _fitted(incoming.clusters || [], current.clusters);

    console.log(
      ">>> Merging a project in —",
      G.polygonParts(incoming.outerPolygon).length,
      "area(s),",
      clusters.length,
      "of",
      (incoming.clusters || []).length,
      "territories kept",
    );

    return {
      version: PAYLOAD_VERSION,
      outerPolygon: G.unionAll(
        G.polygonParts(current.outerPolygon).concat(
          G.polygonParts(incoming.outerPolygon),
        ),
      ),
      bounds: _widen(current.bounds, incoming.bounds),
      streets: _mergedCollection(current.streets, incoming.streets),
      buildings: _mergedCollection(current.buildings, incoming.buildings),
      clusters: current.clusters.concat(clusters),
      notes: (current.notes || []).concat(incoming.notes || []),
    };
  }

  /**
   * Incoming territories with the ground the project already covers taken off.
   *
   * Two projects that overlap is how an import goes wrong in practice: the
   * same village exported twice, or a boundary redrawn one street wider before
   * the second half of the round. Laying the newcomers on top would leave
   * every building inside the overlap counted twice and belonging to two
   * cards.
   *
   * What is left of a territory after the subtraction can be nothing, in which
   * case it is dropped, or a scrap, in which case MIN_REMAINDER_M2 - the same
   * floor a hand-drawn territory leaves behind - drops it too.
   */
  function _fitted(incoming, existing) {
    if (!existing.length) return incoming.slice();

    var boxes = existing.map(function (feature) {
      return turf.bbox(feature);
    });

    return incoming
      .map(function (feature) {
        var box;
        try {
          box = turf.bbox(feature);
        } catch (e) {
          return null;
        }

        var kept = feature;
        for (var i = 0; i < existing.length && kept; i++) {
          if (!G.bboxOverlap(box, boxes[i])) continue;
          try {
            kept = G.difference(kept, existing[i]);
          } catch (e) {
            /* an unsubtractable pair leaves the shape as it was */
          }
        }

        if (!kept || !kept.geometry) return null;
        if (G.area(kept) < (s.MIN_REMAINDER_M2 || 50)) return null;
        return {
          type: "Feature",
          geometry: kept.geometry,
          properties: Object.assign({}, feature.properties || {}),
        };
      })
      .filter(Boolean);
  }

  /**
   * Two feature collections as one, without the features they share.
   *
   * Keyed on the OSM id, which every street and building the server hands back
   * carries: two downloads over neighboring areas both return the road along
   * the join, and drawing it twice doubles its weight on screen and its cost
   * in every filtered-view pass. A feature with no id is kept unconditionally,
   * since there is nothing to compare it on.
   */
  function _mergedCollection(a, b) {
    var features = [];
    var seen = Object.create(null);

    [a, b].forEach(function (collection) {
      ((collection && collection.features) || []).forEach(function (feature) {
        var id = feature.properties && feature.properties.osmid;
        if (id != null) {
          if (seen[id]) return;
          seen[id] = true;
        }
        features.push(feature);
      });
    });

    return { type: "FeatureCollection", features: features };
  }

  /**
   * Import a saved project, from an export file or from a printed card.
   *
   * A card is a PDF with the project embedded in it, so the two paths differ
   * only in how the JSON is obtained - the server unpacks the attachment and
   * hands back exactly what a .json export would have contained. Everything
   * after that is shared, including the failure messages, because "this file
   * is not a project" means the same thing whichever wrapper it arrived in.
   *
   * @param {File} file
   * @param {{merge?: boolean}} [opts] merge adds the file to the project on
   *   screen rather than replacing it
   * @returns {Promise<boolean>} whether the project was applied. Resolves
   *   rather than rejects on every failure - each has already been reported to
   *   the user by the time this settles - so that importing a stack of files
   *   carries on past the one that was a holiday photo.
   */
  function importData(file, opts) {
    if (_looksLikePdf(file)) {
      return _readProjectFromPdf(file).then(function (payload) {
        return payload ? _applyImported(payload, opts) : false;
      });
    }

    return _readJson(file).then(function (payload) {
      return payload ? _applyImported(payload, opts) : false;
    });
  }

  /** @returns {Promise<Object|null>} null when it has already been reported */
  function _readJson(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();

      reader.onerror = function () {
        alert(T("alert.importUnreadable"));
        resolve(null);
      };

      reader.onload = function (e) {
        try {
          resolve(JSON.parse(e.target.result));
        } catch (err) {
          alert(T("alert.importNotJson"));
          resolve(null);
        }
      };

      reader.readAsText(file);
    });
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


  /**
   * @param {Object} payload the bundle as it arrived, before any merging
   * @param {{merge?: boolean}} [opts]
   * @returns {Promise<boolean>} whether it was applied
   */
  function _applyImported(payload, opts) {
    var merge = !!(opts && opts.merge);
    var ok = false;
    // Behind the spinner for the same reason the session restore is, and with
    // the same `always` - see session.js. Opening a project is a second of
    // blocked main thread on a town, plus the gap recount behind it, and
    // nothing has measured this project yet to say so.
    return App.ui
      .busy(
        "loading.importing",
        function () {
          // Before the merge rather than after it, so Ctrl+Z takes the added
          // village back off and Ctrl+Y puts it on again. A replace has
          // nothing worth returning to and clears the stack below instead.
          if (merge && App.history) App.history.push();

          var restored;
          try {
            restored = applyPayload(payload, { merge: merge });
          } catch (err) {
            console.error(">>> Import failed:", err);
            // The entry above describes a merge that did not happen. Left on
            // the stack it is a step that undoes nothing, which reads as an
            // undo that is broken rather than as an import that failed - and
            // if the boundary was already swapped before the throw, this puts
            // it back as well. The same recovery gaps.js uses for a dissolve
            // that moved nothing.
            if (merge && App.history) App.history.undo();
            alert(T("alert.importInvalid", { message: err.message }));
            return;
          }
          // Not on a merge. The stack describes the project on screen, and
          // the project on screen is still the one those steps were taken in --
          // an added village does not make an hour of cutting unrepeatable.
          if (!merge && App.history) App.history.clear();
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
        // The boundary offered is the one that arrived, not the merged
        // whole: the areas already open have their streets, and re-downloading
        // them is minutes of somebody's evening and of Overpass' time for data
        // the app is already holding.
        //
        // After the overlay comes down, not under it: this asks a question,
        // and a dialog behind a spinner is a dialog nobody can answer.
        if (!ok || !payload || !payload.partial) return ok;
        return confirmAndFetch(payload.outerPolygon, { merge: merge }).then(
          function () {
            return ok;
          },
        );
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
