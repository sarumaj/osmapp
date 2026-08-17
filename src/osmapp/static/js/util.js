/**
 * util.js — reading user preferences, and reading OSM tag values.
 *
 * These two jobs have nothing to do with each other beyond both being needed
 * almost everywhere. Nothing here depends on any other module, so this file
 * loads first and its functions are safe to call from another module's top
 * level, before init() has run.
 *
 * ── Preference storage ───────────────────────────────────────────────────
 *
 * `window.localStorage` is not a safe expression to evaluate. Firefox in
 * private mode throws on the *property access* itself rather than on the
 * method call, and Safari throws from setItem once the storage quota is
 * reached. Everything stored through here is a view preference — which
 * basemap is showing, whether the toolbar is collapsed, whether territory
 * numbers are visible — so the right response to any failure is the same one:
 * carry on without remembering. Callers therefore never have to handle an
 * error, and the functions below return a fallback or `false` instead of
 * throwing.
 *
 * Document state does not belong here. The territories, the downloaded street
 * and building data and the uploaded print template are stored in IndexedDB
 * through store.js, because losing any of those silently would be a data loss
 * bug, and a helper whose entire contract is "shrug and continue" is the wrong
 * shape for them.
 *
 * ── OSM tag text ─────────────────────────────────────────────────────────
 *
 * A tag value coming from the backend can arrive in three different shapes,
 * only one of which is a plain string. Both the map tooltips in polygons.js
 * and the locality name ranking in naming.js need all three handled the same
 * way. See tagText below for what they are.
 */
var App = window.App || {};

App.util = (function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════
  // PREFERENCE STORAGE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @returns {Storage|null} the browser's localStorage, or null when it is
   *   unavailable — which includes the case where merely reading the property
   *   throws, so this is the only place that touches it directly.
   */
  function _storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null; // some private browsing modes throw on the access itself
    }
  }

  /**
   * Read a stored preference as a string.
   *
   * @param {string} key
   * @param {string|null} [fallback] returned both when the key is absent and
   *   when storage is unavailable. Callers have no reason to distinguish the
   *   two, since neither one gives them a value to use.
   * @returns {string|null} the stored value, or the fallback, or null when no
   *   fallback was given
   */
  function readLocal(key, fallback) {
    var store = _storage();
    if (!store) return fallback === undefined ? null : fallback;
    var value;
    try {
      value = store.getItem(key);
    } catch (e) {
      return fallback === undefined ? null : fallback;
    }
    if (value === null) return fallback === undefined ? null : fallback;
    return value;
  }

  /**
   * Store a preference, converting it to a string first.
   *
   * @returns {boolean} whether the value was actually persisted. Callers may
   *   ignore this; it exists for the few that show the user a warning when
   *   their settings will not survive a reload.
   */
  function writeLocal(key, value) {
    var store = _storage();
    if (!store) return false;
    try {
      store.setItem(key, String(value));
      return true;
    } catch (e) {
      return false; // the quota is full, or this mode refuses writes
    }
  }

  function removeLocal(key) {
    var store = _storage();
    if (!store) return false;
    try {
      store.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Read a preference that was stored as JSON.
   *
   * Unparsable JSON yields the fallback rather than an exception. A value can
   * only be unparsable if it was written by a different version of the app or
   * edited by hand, and neither case justifies breaking the page over a
   * remembered checkbox.
   *
   * @param {string} key
   * @param {*} fallback returned when the key is absent, unparsable, or null
   * @returns {*}
   */
  function readJson(key, fallback) {
    var raw = readLocal(key, null);
    if (raw === null) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  /** Store a preference as JSON. @returns {boolean} whether it persisted. */
  function writeJson(key, value) {
    try {
      return writeLocal(key, JSON.stringify(value));
    } catch (e) {
      // JSON.stringify only throws on a value that refers to itself, which
      // would be a bug in the caller rather than a storage problem — but not
      // one worth losing the rest of the session over.
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // OSM TAG TEXT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Turn one raw OSM tag value into readable text, or null when it says
   * nothing.
   *
   * Three shapes all arrive in normal use and have to be handled here:
   *
   *   • An **array**. When osmnx collapses several OSM ways into a single
   *     street edge it concatenates their tags, so `name` can be a list of
   *     names. These are joined with "; ", which is what the backend's own
   *     `_clean` does to the same values.
   *   • The **strings** "nan" or "none", which are a missing value that has
   *     been through a stringify step. The backend drops float NaN before
   *     serializing, but a hand-edited import or a file written by an older
   *     version can still contain the text form, and "nan" printed on a
   *     territory card is worse than an empty line.
   *   • Anything else, which is trimmed and treated as nothing if the result
   *     is empty.
   *
   * @param {*} value the raw property value
   * @returns {string|null}
   */
  function tagText(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) value = value.filter(Boolean).join("; ");
    var text = String(value).trim();
    if (!text) return null;
    var lower = text.toLowerCase();
    return lower === "nan" || lower === "none" ? null : text;
  }

  /**
   * tagText applied to one property of a GeoJSON feature, tolerating a feature
   * that has no properties at all.
   *
   * @param {Object} feature
   * @param {string} key the OSM tag name, e.g. "name" or "addr:street"
   * @returns {string|null}
   */
  function tagOf(feature, key) {
    var props = feature && feature.properties;
    if (!props) return null;
    return tagText(props[key]);
  }

  return {
    readLocal: readLocal,
    writeLocal: writeLocal,
    removeLocal: removeLocal,
    readJson: readJson,
    writeJson: writeJson,
    tagText: tagText,
    tagOf: tagOf,
  };
})();

window.App = App;
