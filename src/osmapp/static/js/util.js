/**
 * util.js - reading user preferences, reading OSM tag values, and the
 * development-only timing gate.
 *
 * The three jobs have nothing to do with each other beyond all being needed
 * almost everywhere. Nothing here depends on any other module, so this file
 * loads first and its functions are safe to call from another module's top
 * level, before init() has run.
 *
 * Preference storage
 *
 * `window.localStorage` is not a safe expression to evaluate. Firefox in
 * private mode throws on the *property access* itself rather than on the
 * method call, and Safari throws from setItem once the storage quota is
 * reached. Everything stored through here is a view preference - which
 * basemap is showing, whether the toolbar is collapsed, whether territory
 * numbers are visible - so the right response to any failure is the same one:
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
 * OSM tag text
 *
 * A tag value coming from the backend can arrive in three different shapes,
 * only one of which is a plain string. Both the map tooltips in polygons.js
 * and the locality name ranking in naming.js need all three handled the same
 * way. See tagText below for what they are.
 *
 * Timing
 *
 * timed() measures a click handler, and only when the page is served locally.
 * See there for why the gate exists rather than the measurement being
 * unconditional or absent.
 */
var App = window.App || {};

App.util = (function () {
  "use strict";

  // PREFERENCE STORAGE

  /**
   * @returns {Storage|null} the browser's localStorage, or null when it is
   *   unavailable - which includes the case where merely reading the property
   *   throws, so this is the only place that touches it directly.
   */
  function _storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
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
      // JSON.stringify throws on a circular value and on a BigInt, both of
      // which are a bug in the caller rather than a storage problem - but
      // not one worth losing the rest of the session over.
      return false;
    }
  }

  // TIMING

  // Hostnames that mean "this machine". "" is what a file:// URL reports.
  var LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", ""];

  var _local = null;

  /**
   * Is the page served from the machine it is being developed on?
   *
   * Answered once and remembered: it cannot change without a navigation, and
   * the caller is on a click path. A name ending in ".localhost" counts because
   * RFC 6761 section 6.3 reserves that suffix for loopback.
   *
   * @returns {boolean}
   */
  function isLocal() {
    if (_local === null) _local = _readIsLocal();
    return _local;
  }

  function _readIsLocal() {
    var location;
    try {
      location = window.location;
    } catch (e) {
      location = null;
    }
    // No location object at all - a stub window, a sandboxed frame - is not a
    // development host. An *empty* hostname is, and the two have to be told
    // apart: reading a missing location through `|| ""` would make the first
    // case indistinguishable from a file:// URL.
    if (!location) return false;

    var host = String(location.hostname || "").toLowerCase();
    return LOCAL_HOSTS.indexOf(host) >= 0 || /\.localhost$/.test(host);
  }

  /**
   * Run `fn`, and time it to the console only on a local host.
   *
   * Every button in the app is wired through App.dom.onRole and every context
   * menu entry through App.ui, so timing them unconditionally writes a line to
   * the console on more or less every click. That is a measurement worth having
   * while developing and worth nothing to somebody using the app, who cannot
   * switch it off and did not ask to read it.
   *
   * timeEnd is in a `finally`, so a handler that throws still closes its label.
   * Without that the label stays open and every later call for the same one is
   * answered with a "Timer already exists" warning instead of a measurement.
   *
   * @returns {*} whatever `fn` returns
   */
  function timed(label, fn) {
    if (!isLocal()) return fn();
    console.time(label);
    try {
      return fn();
    } finally {
      console.timeEnd(label);
    }
  }

  // OSM TAG TEXT

  /**
   * Turn one raw OSM tag value into readable text, or null when it says
   * nothing.
   *
   * Three shapes all arrive in normal use and have to be handled here:
   *
   *   - An **array**. When osmnx collapses several OSM ways into a single
   *     street edge it concatenates their tags, so `name` can be a list of
   *     names. These are joined with "; ", which is what the backend's own
   *     `_clean` does to the same values.
   *   - The **strings** "nan" or "none", which are a missing value that has
   *     been through a stringify step. The backend drops float NaN before
   *     serializing, but a hand-edited import or a file written by an older
   *     version can still contain the text form, and "nan" printed on a
   *     territory card is worse than an empty line.
   *   - Anything else, which is trimmed and treated as nothing if the result
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
    isLocal: isLocal,
    timed: timed,
  };
})();

window.App = App;
