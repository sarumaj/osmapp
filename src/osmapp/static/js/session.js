/**
 * session.js — keeps the working state in IndexedDB so a refresh does not
 * lose the territory.
 *
 * Saves are debounced and split across three keys: the street and building
 * cache is megabytes and changes rarely, while the territory list is small and
 * changes constantly.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.session = (function () {
  "use strict";

  var META = "session:meta";
  var DATA = "session:data";
  var CLUSTERS = "session:clusters";
  var VIEW_KEY = "osmapp.map.view";
  var DEBOUNCE_MS = 1000;
  var VIEW_DEBOUNCE_MS = 400;
  var VERSION = App.data.PAYLOAD_VERSION || 3; // must match the export version

  var s = null;
  var _timer = null;
  var _viewTimer = null;
  var _restoring = false;
  var _dataDirty = false;
  var _suspended = false;

  function init() {
    s = App.state;
    _bindView();
    App._loaded.push("session");
  }

  // ══════════════════════════════════════════════════════════════════════
  // MAP VIEW
  // ══════════════════════════════════════════════════════════════════════
  //
  // Kept in localStorage rather than in the IndexedDB payload: it is two
  // numbers and a zoom, it changes on every pan, and it is worth restoring
  // even when there is no territory to restore with it.

  function _bindView() {
    if (!s.leafletMap) return;
    s.leafletMap.on("moveend zoomend", function () {
      clearTimeout(_viewTimer);
      _viewTimer = setTimeout(_saveView, VIEW_DEBOUNCE_MS);
    });
  }

  function _saveView() {
    if (!s.leafletMap || _suspended) return;
    var center = s.leafletMap.getCenter();
    // In private mode the view does not persist, which App.util already knows
    // how to shrug off.
    App.util.writeJson(VIEW_KEY, {
      lat: center.lat,
      lng: center.lng,
      zoom: s.leafletMap.getZoom(),
    });
  }

  /**
   * Put the map back where it was.
   *
   * Called after restore() on purpose: applyPayload fits the bounds of the
   * whole territory, which is the right answer when there is nothing better,
   * but not when the last thing the user did was zoom into one corner of it.
   *
   * @returns {boolean} whether a stored view was applied
   */
  function restoreView() {
    var saved = App.util.readJson(VIEW_KEY, null);
    if (
      !saved ||
      typeof saved.lat !== "number" ||
      typeof saved.lng !== "number" ||
      typeof saved.zoom !== "number" ||
      Math.abs(saved.lat) > 90 ||
      Math.abs(saved.lng) > 180
    ) {
      return false;
    }
    s.leafletMap.setView([saved.lat, saved.lng], saved.zoom);
    return true;
  }

  /**
   * Stop persisting anything until told otherwise.
   *
   * For the guided tour, which loads a sample area over whatever the user was
   * working on and puts it back afterwards. Without this the debounced save
   * would land a demo village in IndexedDB a second later and the real work
   * would be gone on the next reload — the one failure this feature must not
   * have.
   *
   * A boolean rather than a counter: a counter that gets one extra suspend()
   * somewhere silently stops saving for the rest of the session, which is a
   * far worse way to be wrong than a redundant resume.
   */
  function setSuspended(on) {
    _suspended = !!on;
    if (!_suspended) return;
    // Anything already queued was queued for the state being replaced.
    clearTimeout(_timer);
    clearTimeout(_viewTimer);
  }

  /** @param {{data?: boolean}} [opts] data marks streets/buildings as changed */
  function markDirty(opts) {
    if (_restoring || _suspended) return; // neither is a user edit
    if (opts && opts.data) _dataDirty = true;
    clearTimeout(_timer);
    _timer = setTimeout(_save, DEBOUNCE_MS);
  }

  function _save() {
    if (!s.outerPolygonLayer) return;
    var payload = App.data.buildPayload();

    var writes = [
      App.store.set(META, {
        version: VERSION,
        savedAt: Date.now(),
        outerPolygon: payload.outerPolygon,
        bounds: payload.bounds,
      }),
      App.store.set(CLUSTERS, payload.clusters),
    ];

    if (_dataDirty) {
      _dataDirty = false;
      writes.push(
        App.store.set(DATA, {
          streets: payload.streets,
          buildings: payload.buildings,
        }),
      );
    }

    Promise.all(writes).catch(function (err) {
      console.warn(">>> Could not save session:", err && err.message);
      _dataDirty = true;   // retry on the next edit rather than never again
    });
  }

  function restore() {
    return Promise.all([
      App.store.get(META),
      App.store.get(DATA),
      App.store.get(CLUSTERS),
    ]).then(function (parts) {
      var meta = parts[0];
      if (!meta || meta.version !== VERSION || !meta.outerPolygon) return false;

      var ok = false;
      _restoring = true;
      // Behind the spinner, and not because anything measured this project:
      // applying a payload is the heaviest thing the app does, the estimate
      // ui.busy() normally consults is measured from it, and at this point
      // nothing has been measured at all. On a real project it is a second of
      // blocked main thread and then the gap recount behind it — and both used
      // to land on a page that had just finished drawing itself, so the map
      // appeared, looked ready, and stopped answering. hideOverlay() takes the
      // recount with it, which is what keeps the second one under here too.
      return App.ui
        .busy(
          "loading.restoring",
          function () {
            try {
              App.data.applyPayload({
                outerPolygon: meta.outerPolygon,
                bounds: meta.bounds,
                streets: (parts[1] || {}).streets,
                buildings: (parts[1] || {}).buildings,
                clusters: parts[2] || [],
              });
              console.log(">>> Session restored from", new Date(meta.savedAt));
              ok = true;
            } catch (e) {
              console.warn(">>> Could not restore session:", e.message);
              clear();
            }
          },
          { always: true },
        )
        .then(function () {
          // After the work rather than in a finally around it: the saves this
          // suppresses are queued by what applyPayload does, and not all of that
          // lands on this tick.
          _restoring = false;
          return ok;
        });
    });
  }

  function clear() {
    clearTimeout(_timer);
    _dataDirty = false;
    return Promise.all([
      App.store.remove(META),
      App.store.remove(DATA),
      App.store.remove(CLUSTERS),
    ]);
  }

  return {
    init: init,
    markDirty: markDirty,
    setSuspended: setSuspended,
    restore: restore,
    restoreView: restoreView,
    clear: clear,
  };
})();

window.App = App;
