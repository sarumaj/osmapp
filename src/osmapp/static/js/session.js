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
    if (!s.leafletMap) return;
    try {
      var center = s.leafletMap.getCenter();
      window.localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          lat: center.lat,
          lng: center.lng,
          zoom: s.leafletMap.getZoom(),
        }),
      );
    } catch (e) {
      /* private mode: the view just does not persist */
    }
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
    var saved;
    try {
      saved = JSON.parse(window.localStorage.getItem(VIEW_KEY) || "null");
    } catch (e) {
      return false;
    }
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

  /** @param {{data?: boolean}} [opts] data marks streets/buildings as changed */
  function markDirty(opts) {
    if (_restoring) return; // restoring is not a user edit
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
        App.store.set(DATA, { streets: payload.streets, buildings: payload.buildings })
          .then(function () { _dataDirty = false; }),
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

      _restoring = true;
      try {
        App.data.applyPayload({
          outerPolygon: meta.outerPolygon,
          bounds: meta.bounds,
          streets: (parts[1] || {}).streets,
          buildings: (parts[1] || {}).buildings,
          clusters: parts[2] || [],
        });
        console.log(">>> Session restored from", new Date(meta.savedAt));
        return true;
      } catch (e) {
        console.warn(">>> Could not restore session:", e.message);
        clear();
        return false;
      } finally {
        _restoring = false;
      }
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
    restore: restore,
    restoreView: restoreView,
    clear: clear,
  };
})();

window.App = App;
