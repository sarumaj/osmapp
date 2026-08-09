/**
 * util.js — two things every other module was reimplementing.
 *
 * Neither is interesting on its own, which is exactly why both had drifted
 * into six and two slightly different copies respectively. Neither depends on
 * anything else in the app, so this loads first and is safe to call from any
 * module's top level.
 *
 * ── Preference storage ───────────────────────────────────────────────────
 *
 * `window.localStorage` is not a safe expression. Firefox in private mode
 * throws on the *property access*, not on the call, and Safari throws on
 * setItem once the quota is reached. Every caller here stores a view
 * preference — which basemap, is the toolbar collapsed, are the numbers on —
 * so the correct response to a failure is always the same: carry on without
 * remembering. That answer belongs in one place rather than in six try/catch
 * blocks that each have to get it right.
 *
 * What does *not* go through here is anything that is document state. The
 * territories, the downloaded streets and the uploaded template live in
 * IndexedDB via store.js, because losing those silently is not acceptable and
 * a helper whose whole contract is "shrug and continue" is the wrong shape for
 * them.
 *
 * ── OSM tag text ─────────────────────────────────────────────────────────
 *
 * A tag value arriving from the backend has three shapes worth normalizing,
 * and both the tooltips in polygons.js and the locality ranking in naming.js
 * had to know all three. See tagText below.
 */
var App = window.App || {};

App.util = (function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════
  // PREFERENCE STORAGE
  // ══════════════════════════════════════════════════════════════════════

  /** @returns {Storage|null} null whenever storage is unavailable at all. */
  function _storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null; // private mode: the property access itself throws
    }
  }

  /**
   * @param {string} key
   * @param {string|null} [fallback] returned when the key is absent or
   *   storage is unavailable — the two cases callers treat identically.
   * @returns {string|null}
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

  /** @returns {boolean} whether the value was actually persisted. */
  function writeLocal(key, value) {
    var store = _storage();
    if (!store) return false;
    try {
      store.setItem(key, String(value));
      return true;
    } catch (e) {
      return false; // quota, or a mode that refuses writes
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
   * Read a JSON-encoded preference.
   *
   * Corrupt JSON returns the fallback rather than throwing: the value was
   * written by an older build or edited by hand, and neither is worth taking
   * the app down for.
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

  function writeJson(key, value) {
    try {
      return writeLocal(key, JSON.stringify(value));
    } catch (e) {
      return false; // a cyclic value: a caller bug, but not a fatal one
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // OSM TAG TEXT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * One raw tag value as text a person can read, or null when it carries
   * nothing.
   *
   * Three shapes, all of which arrive routinely:
   *
   *   • A merged way carries a *list* — osmnx concatenates the tags of every
   *     OSM way it collapsed into one edge. Joined with "; ", matching what
   *     the backend's own `_clean` does to the same values.
   *   • A missing tag can arrive as the *string* "nan" or "none". The backend
   *     drops float NaN before serializing, but a hand-edited import or an
   *     older export can still carry the stringified form, and "nan" printed
   *     on a territory card is worse than a blank.
   *   • Anything else is trimmed, and an empty result is nothing.
   */
  function tagText(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) value = value.filter(Boolean).join("; ");
    var text = String(value).trim();
    if (!text) return null;
    var lower = text.toLowerCase();
    return lower === "nan" || lower === "none" ? null : text;
  }

  /** tagText applied to one property of a GeoJSON feature. */
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
