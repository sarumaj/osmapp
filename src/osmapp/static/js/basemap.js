/**
 * basemap.js — the layer under everything else, and the rule about it.
 *
 * There is exactly one printable basemap: OpenStreetMap. A territory card is
 * something a person carries down a street, writes on and hands to the next
 * person, and for that it has to name roads and show house numbers. Aerial
 * imagery does neither, and a topographic map names the wrong things. So the
 * card is always composed from OSM tiles, and that is not a preference anyone
 * can toggle.
 *
 * The aid layers exist for the other half of the work — deciding which of two
 * doors on a corner plot is the actual entrance, seeing that a "street" is a
 * private drive, reading a slope before assigning a territory to someone.
 * That is worth having on screen, and worth keeping off paper.
 *
 * How the rule is enforced, in order of how much it can be relied on:
 *
 *   1. print.js builds its tile URLs from PRINT_TILE_URL below, a constant
 *      that always points at the OSM proxy route. Nothing about the on-screen
 *      selection is readable from there.
 *   2. The aid routes live at /tiles/aid/<layer>/… — a different path, so
 *      even an accidental URL rewrite in the print pipeline could not land on
 *      one by chance.
 *   3. The print dialog says so, when and only when an aid layer is on screen
 *      and the difference might otherwise be a surprise.
 *
 * Server side, config.AID_LAYERS decides which aids exist at all; an empty URL
 * removes one, and this module renders whatever arrives without knowing the
 * names in advance.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.basemap = (function () {
  "use strict";

  /**
   * The one basemap a card may be composed from. print.js reads this; nothing
   * writes it.
   */
  var PRINT_TILE_URL = "/tiles/{z}/{x}/{y}.png";

  var STORAGE_KEY = "osmapp.basemap";
  var BASE_ID = "osm";

  var _map = null;
  var _config = null;
  var _layers = {}; // id → L.TileLayer
  var _specs = {}; // id → server descriptor, for labels and attribution
  var _order = []; // ids, switcher order, base first
  var _current = BASE_ID;
  var _listeners = [];

  // ══════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Build every basemap layer and add the remembered one.
   *
   * Called before i18n has loaded — the map needs tiles under it while the
   * dictionaries arrive — so nothing here translates anything. Names are
   * resolved later, by the layer control, through labelKey.
   */
  function init(map) {
    _map = map;
    _config = window.BASEMAPS || {};

    var base = _config.base || {
      id: BASE_ID,
      labelKey: "layers.map",
      url: PRINT_TILE_URL,
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    };

    _layers[base.id] = L.tileLayer(base.url, {
      maxZoom: base.maxZoom,
      attribution: base.attribution,
    });
    _order.push(base.id);
    _specs[base.id] = base;

    (_config.aid || []).forEach(function (spec) {
      _layers[spec.id] = L.tileLayer(spec.url, {
        // The map's zoom range stays the basemap's. A layer that stops at 17
        // upscales its last level instead of going blank, so switching to it
        // never looks broken — it looks soft, which is honest.
        maxZoom: base.maxZoom,
        maxNativeZoom: spec.maxNativeZoom || spec.maxZoom || base.maxZoom,
        attribution: spec.attribution,
        // Tuned down a little so territory outlines, streets and buildings
        // stay legible over a photograph. The vectors are the point; the
        // imagery is the aid.
        className: "basemap-aid",
      });
      _order.push(spec.id);
      _specs[spec.id] = spec;
    });

    select(_remembered(), { silent: true });
    App._loaded.push("basemap");
  }

  // ══════════════════════════════════════════════════════════════════════
  // SELECTION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Show one basemap and only one.
   *
   * @param {string} id
   * @param {{silent?: boolean}} [opts] silent skips the change listeners,
   *   which is what start-up wants: nothing is listening yet, and the print
   *   dialog cannot exist to be told.
   */
  function select(id, opts) {
    if (!_layers[id]) id = BASE_ID;

    _order.forEach(function (other) {
      if (other !== id && _map.hasLayer(_layers[other])) {
        _map.removeLayer(_layers[other]);
      }
    });
    if (!_map.hasLayer(_layers[id])) _map.addLayer(_layers[id]);

    var changed = _current !== id;
    _current = id;
    _remember(id);

    // Not just cosmetic: the class is what CSS hangs the imagery treatment
    // off, and what a stylesheet would key on to strengthen overlay contrast.
    var container = _map.getContainer();
    if (container) container.classList.toggle("has-aid-basemap", isAid());

    if (changed && !(opts && opts.silent)) {
      _listeners.forEach(function (fn) {
        try {
          fn(id);
        } catch (e) {
          console.warn(">>> basemap listener failed:", e && e.message);
        }
      });
    }
  }

  function current() {
    return _current;
  }

  /** True when the visible basemap is an aid rather than the printable one. */
  function isAid() {
    return _current !== BASE_ID;
  }

  /** The Leaflet layer for an id, so the layer control can register it. */
  function layer(id) {
    return _layers[id] || null;
  }

  /**
   * [{ id, labelKey, layer, aid }] in switcher order, base first.
   *
   * The label is a key rather than a string: the layer control is rebuilt on
   * every language change and resolves them itself.
   */
  function entries() {
    return _order.map(function (id) {
      return {
        id: id,
        labelKey: (_specs[id] && _specs[id].labelKey) || "layers.map",
        layer: _layers[id],
        aid: id !== BASE_ID,
      };
    });
  }

  /** Notified after a change of basemap, but never during start-up. */
  function onChange(fn) {
    if (typeof fn === "function") _listeners.push(fn);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PERSISTENCE
  // ══════════════════════════════════════════════════════════════════════
  //
  // localStorage, next to the map view and the toolbar collapse: it is one
  // short string, it is a view preference rather than territory data, and it
  // has no business in the exported GeoJSON or the IndexedDB session.

  function _remembered() {
    // Private mode and a first visit are the same answer: the basemap.
    return App.util.readLocal(STORAGE_KEY, BASE_ID) || BASE_ID;
  }

  function _remember(id) {
    App.util.writeLocal(STORAGE_KEY, id);
  }

  return {
    PRINT_TILE_URL: PRINT_TILE_URL,
    init: init,
    select: select,
    current: current,
    isAid: isAid,
    layer: layer,
    entries: entries,
    onChange: onChange,
  };
})();

window.App = App;
