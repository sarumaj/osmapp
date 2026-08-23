/**
 * store.js - promise-based key/value storage backed by IndexedDB.
 *
 * This holds the things localStorage cannot: the uploaded PDF template, which
 * is a File object rather than a string, and the working session, which is
 * GeoJSON far past the 5 MB quota localStorage allows. Simple view
 * preferences go through util.js instead.
 *
 * IndexedDB's API is event-based and transaction-oriented; the four functions
 * exported here reduce it to get, set, remove and clear over a single object
 * store, each returning a promise.
 *
 * Opening the database can fail outright - some private browsing modes throw
 * from indexedDB.open() - and the app has to remain usable without
 * persistence. When that happens the promise still resolves, with `undefined`,
 * so callers do not need a fallback path for a browser that has no storage. A
 * failure of an individual read or write does reject, since that indicates a
 * quota or corruption problem the caller should know about.
 */
var App = window.App || {};

App.store = (function () {
  "use strict";

  var DB_NAME = "osm-territory";
  var DB_VERSION = 1;
  var STORE = "kv";
  var _db = null;

  /**
   * Open the database, creating the object store on first use, and remember
   * the handle for subsequent calls.
   *
   * @returns {Promise<IDBDatabase>} rejects when storage is unavailable
   */
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

  /**
   * Run one transaction against the object store.
   *
   * The result is taken after `oncomplete` rather than after the request's own
   * `onsuccess`, because a write is not durable until the transaction commits,
   * and reporting success earlier would let a caller believe data was saved
   * that a later abort discarded.
   *
   * @param {"readonly"|"readwrite"} mode
   * @param {function(IDBObjectStore): (IDBRequest|undefined)} run issues the
   *   request; return it if its result is wanted
   * @returns {Promise<*>} the request's result, or undefined when there is no
   *   result or no storage
   */
  function _tx(mode, run) {
    return _open()
      .then(
        function (db) {
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
        },
        function (err) {
          // This handler covers only a failure to open the database, since it
          // is attached to _open(). Individual transaction failures reject
          // through the inner promise and are not swallowed here.
          console.warn(">>> Storage unavailable:", err && err.message);
          return undefined;
        },
      );
  }

  /** @returns {Promise<*>} the stored value, or undefined if absent. */
  function get(key) {
    return _tx("readonly", function (store) {
      return store.get(key);
    });
  }

  /** Store a value under a key. @returns {Promise<void>} */
  function set(key, value) {
    return _tx("readwrite", function (store) {
      store.put(value, key);
    });
  }

  /** Delete one key. Deleting an absent key is not an error. */
  function remove(key) {
    return _tx("readwrite", function (store) {
      store.delete(key);
    });
  }

  /** Empty the whole store. Used when the user discards their session. */
  function clear() {
    return _tx("readwrite", function (store) {
      store.clear();
    });
  }

  return { get: get, set: set, remove: remove, clear: clear };
})();

window.App = App;
