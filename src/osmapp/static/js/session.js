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
  var DEBOUNCE_MS = 1000;
  var VERSION = App.data.PAYLOAD_VERSION || 3;  // must match the export version

  var s = null;
  var _timer = null;
  var _restoring = false;
  var _dataDirty = false;

  function init() {
    s = App.state;
    App._loaded.push("session");
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

  return { init: init, markDirty: markDirty, restore: restore, clear: clear };
})();

window.App = App;
