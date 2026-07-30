/**
 * store.js — a tiny promise wrapper over one IndexedDB object store.
 *
 * Used for things localStorage cannot hold: the uploaded PDF template (a File)
 * and the working session (GeoJSON large enough to blow the 5 MB quota).
 *
 * Every call degrades to a resolved promise when storage is unavailable —
 * Firefox in private mode throws on indexedDB.open(), and the app must stay
 * usable without persistence.
 */
var App = window.App || {};

App.store = (function () {
  "use strict";

  var DB_NAME = "osm-territory";
  var DB_VERSION = 1;
  var STORE = "kv";
  var _db = null;

  function _open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      request.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = function (e) {
        _db = e.target.result;
        resolve(_db);
      };
      request.onerror = function () {
        reject(request.error);
      };
    });
  }

  function _tx(mode, run) {
    return _open()
      .then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE, mode);
          var request = run(tx.objectStore(STORE));
          tx.oncomplete = function () {
            resolve(request ? request.result : undefined);
          };
          tx.onerror = function () {
            reject(tx.error);
          };
          tx.onabort = function () {
            reject(tx.error);
          };
        });
      })
      .catch(function (err) {
        console.warn(">>> Storage unavailable:", err && err.message);
        return undefined;
      });
  }

  function get(key) {
    return _tx("readonly", function (store) {
      return store.get(key);
    });
  }

  function set(key, value) {
    return _tx("readwrite", function (store) {
      store.put(value, key);
    });
  }

  function remove(key) {
    return _tx("readwrite", function (store) {
      store.delete(key);
    });
  }

  function clear() {
    return _tx("readwrite", function (store) {
      store.clear();
    });
  }

  return { get: get, set: set, remove: remove, clear: clear };
})();

window.App = App;
