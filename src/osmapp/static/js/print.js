/**
 * print.js - territory card printing.
 *
 * Rather than screenshotting the live Leaflet map, this renders a fresh map
 * onto a canvas: basemap tiles, then this cluster's border, and nothing else.
 * That guarantees no buildings, no streets and no neighboring borders, and it
 * decouples output resolution from the screen, so the card prints at 300 dpi
 * regardless of window size.
 *
 * Layout
 *   Where the map goes on the card is measured from the template, not
 *   hardcoded. App.pdfdoc.inspectTemplate finds the placeholder rectangle and
 *   the field anchors; the placement dialog corrects that guess by hand; the
 *   result is remembered per template, keyed on a hash of its bytes. The
 *   canvas takes its aspect ratio from the resolved placeholder, so editing
 *   the card cannot silently letterbox the map.
 *
 * Tiles
 *   Tiles are fetched below the display zoom and upscaled, so the basemap is
 *   deliberately soft. OSM sets label text at ~11 px for a ~96 dpi screen; at
 *   300 dpi that prints as a 2.6 pt street name. TILE_ZOOM_OFFSET controls the
 *   trade: higher means larger, more readable labels on a softer map. The
 *   result is quantized - tiles exist only at integer zooms - so the ladder
 *   steps by 2x and the readout shows the tile zoom alongside the point size.
 *
 *   Every tile is kept as a decoded Image in _tiles, so panning and small zoom
 *   changes re-composite from memory. Only crossing into a different tile zoom
 *   refetches, which _maybeRetile decides.
 *
 * Framing
 *   The canvas is fixed at the placeholder's aspect ratio, so the ratio cannot
 *   drift. Framing chooses which slice of the world lands on it: drag to pan,
 *   scroll or the slider to zoom, and the rotation slider to turn. The frame
 *   never turns - the map turns inside it.
 *
 * Erase strokes are stored in lng/lat with a width in meters, not canvas
 * pixels, so they stay pinned to the street name they were drawn over when the
 * frame is panned, zoomed or rotated afterwards.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.print = (function () {
  "use strict";

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  // Output geometry
  // Only the no-template fallback. A loaded template replaces all of this.
  var DEFAULT_LAYOUT = {
    page: 0,
    pageWidth: 595.32,
    pageHeight: 841.92,
    placeholder: { x: 30.72, y: 401.69, width: 534.0, height: 350.09 },
    fields: {
      locality: { x: 122.3, y: 761.88, size: 14 },
      territory: { x: 479.0, y: 761.88, size: 14 },
    },
    candidates: [],
  };

  /**
   * Bump whenever the detector's geometry or output shape changes.
   *
   * Saved layouts are keyed on the template's bytes, so a detector improvement
   * would otherwise never reach anyone who had already loaded that template --
   * the cached numbers pin the old behavior forever. Layouts positioned by
   * hand carry source "manual" and survive the bump: a box someone aligned
   * against a loupe is better evidence than anything detection produces.
   */
  var LAYOUT_VERSION = 2;

  var _layout = DEFAULT_LAYOUT;
  var _layoutId = null;
  var _candidates = [];

  // Reassigned by _applyLayout - never captured by reference outside it.
  var PLACEHOLDER = _layout.placeholder;
  var FIELDS = _layout.fields;

  var DPI = 300;
  var PT_PER_INCH = 72;
  var PX_PER_PT = DPI / PT_PER_INCH;
  var RENDER_W = Math.round((PLACEHOLDER.width / PT_PER_INCH) * DPI);
  var RENDER_H = Math.round((PLACEHOLDER.height / PT_PER_INCH) * DPI);

  var DEG = Math.PI / 180;

  var TILE_SIZE = 256;

  /**
   * The basemap a card is composed from - always OpenStreetMap, whatever is
   * on screen.
   *
   * A card is carried down a street, written on and handed to the next
   * person, so it has to name roads and show house numbers. The aid layers
   * (aerial imagery, terrain) do neither, which is why they are on screen only
   * and why this reads a constant rather than the current selection. Resolved
   * per call rather than captured at load: it costs nothing and it keeps this
   * file independent of script order.
   */
  function _tileUrl() {
    return App.basemap.PRINT_TILE_URL;
  }
  var TILE_CONCURRENCY = 8;
  var TILE_MARGIN = 2; // rings of tiles prefetched around the opening view
  var MAX_TILES = 900;

  /**
   * How many zoom levels below the display zoom the tiles are fetched from.
   *
   * This is the only knob that exists. Tiles are published at integer zooms
   * only, so label size is quantized: each step doubles it. A continuous
   * control here would be a lie - most of its range maps to the same integer
   * and does nothing, and the positions that do change jump by a factor of two.
   *
   * 0 = tiles at display zoom, sharp, labels near 2.6 pt (unreadable in hand)
   * 1 = one level down, labels near 5.3 pt
   * 2 = two levels down, labels near 10.6 pt on a visibly soft map
   */
  var TILE_ZOOM_OFFSET = 1;
  var TILE_ZOOM_OFFSET_MAX = 2;
  var TILE_LABEL_PX = 11; // OSM's street-label height, in tile pixels

  // Below this tile zoom OSM stops naming minor roads, so going softer
  // removes the labels instead of enlarging them.
  var TILE_ZOOM_WARN = 14;

  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var ZOOM_OUT_HEADROOM = 0.5; // how far below fit the slider reaches
  var ZOOM_IN_HEADROOM = 2;
  var PADDING = 0.05; // fraction of the frame kept clear when fitting

  var ROTATION_STEP = 90; // the quarter-turn buttons
  var ROTATION_SNAP_DEG = 15; // magnetism while dragging the slider
  var ROTATION_SNAP_TOL = 3;

  var EARTH_CIRCUMFERENCE_M = 40075016.686;
  var ATTRIBUTION = "© OpenStreetMap contributors";

  /**
   * Card furniture - the scale bar and the compass rose.
   *
   * Both are off by default and both are drawn last, on top of the finished
   * card. Everything here is in points, because that is the unit the numbers
   * were chosen in: a bar 5 pt high and 9 pt lettering are readable in the
   * hand at arm's length, and they stay that size whatever the placeholder
   * turns out to be. Multiplying by PX_PER_PT at draw time is what keeps a
   * 300 dpi canvas from making them a third of a millimeter tall.
   */
  var DECOR_MARGIN_PT = 12;
  var SCALE_MAX_FRACTION = 0.3; // of the card's width the bar may claim
  var SCALE_SEGMENTS = 4; // alternating light and dark, as on a paper map
  var SCALE_BAR_PT = 5;
  var SCALE_FONT_PT = 9;
  var COMPASS_RADIUS_PT = 20;
  var COMPASS_FONT_PT = 9;
  var COMPASS_NEEDLE = "#c0392b";
  var HALO = "rgba(255,255,255,0.9)";
  var INK = "#333";

  /** The four points, clockwise from north. The letters are translated. */
  var COMPASS_POINTS = [
    { key: "print.compassN", bearing: 0, needle: true },
    { key: "print.compassE", bearing: 90, needle: false },
    { key: "print.compassS", bearing: 180, needle: false },
    { key: "print.compassW", bearing: 270, needle: false },
  ];

  // Session state
  var _dialog = null;
  var _feature = null;
  var _preview = null;
  var _borderCanvas = null;
  var _filterCanvas = null; // tiles are mosaicked here, then filtered in one go
  var _eraseCursor = null;
  var _eraseRO = null;

  var _view = null; // { ez, lng, lat, rotation } - rotation in (-180, 180]
  var _desiredEz = null; // what the user asked for, before rotation clamping
  var _tiles = null; // "x/y" -> { img, done }
  var _tileZoom = 0;
  var _inFlight = 0;
  var _paintQueued = false;
  var _retileTimer = null;

  var _strokes = [];
  var _redoStack = [];
  var _stroke = null;
  var _pan = null;

  var _rotate = null; // shift-drag rotation gesture
  var _rotationDragging = false; // true only while the slider handle is held

  var _templateFile = null;
  // blob: URL of the last card composed here, whichever format it came out
  // in. One at a time: composing again replaces it.
  var _outUrl = null;
  var _busy = false;

  /**
   * Extra vector layers drawn between the basemap and the border.
   *
   * Null in normal use, and it has to stay that way. A card's street names and
   * house numbers come from the OpenStreetMap basemap itself; drawing the
   * app's own copy of the same streets on top would thicken every road and
   * double nothing useful, which is why a card is tiles and one border and
   * nothing else.
   *
   * The guided tour is the single exception, and the reason this exists. Its
   * sample village is GeoJSON the app is holding - no tile server has ever
   * heard of it - so a preview composed from tiles alone is an empty field
   * with a red rectangle on it, while the map two centimeters behind the
   * dialog shows a village. Whatever else a print preview is for, it is
   * supposed to be a preview. demo.js hands its streets and buildings in for
   * as the sample is loaded, and takes them away again with it.
   *
   * @type {{streets?: Object, buildings?: Object}|null}
   */
  var _overlay = null;

  function init() {
    s = App.state;
    G = App.geometry;
    D = App.dom;
    T = App.i18n.t;
    App._loaded.push("print");
  }

  function isOpen() {
    return _dialog !== null;
  }

  // PREFERENCES

  var PREFERENCES_KEY = "osm.print.preferences.v1";

  var PREFERENCES_ROLES = [
    "color",
    "width",
    "opacity",
    "detail",
    "sharpen",
    "contrast",
    "grayscale",
    "scale",
    "compass",
    "erase-size",
    "locality",
    "attach",
  ];

  /**
   * How many previously printed localities are remembered for autocomplete.
   *
   * Distinct from the `locality` preference above, which is the *last* one and
   * comes back in the field itself. This is the list behind the dropdown, and
   * it exists for the congregation that works three villages in rotation: OSM
   * suggests what the addresses say, this suggests what you actually wrote on
   * the last card for each of them.
   *
   * Eight is a round of villages, not an archive. A longer list would start
   * offering typos from months ago with the same prominence as last week's.
   */
  var RECENT_LOCALITIES_MAX = 8;

  /** Sequence for the runtime datalist ids. See _fillOptions. */
  var _optionsSeq = 0;

  function _readPreferences() {
    // Corrupt JSON, an absent key and unavailable storage are one answer:
    // no preferences yet.
    var saved = App.util.readJson(PREFERENCES_KEY, null);
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? saved
      : {};
  }

  function _writePreferences(preferences) {
    App.util.writeJson(PREFERENCES_KEY, preferences);
  }

  function _loadPreferences() {
    var saved = _readPreferences();
    PREFERENCES_ROLES.forEach(function (role) {
      if (saved[role] === undefined) return;
      var input = D.role(_dialog, role);
      if (!input) return;

      if (input.type === "checkbox") {
        input.checked = saved[role] === "1";
      } else {
        input.value = saved[role]; // ranges clamp, color ignores junk
      }
      // A select given a value it has no option for goes blank; a range given
      // an out-of-bounds value clamps silently. Both are better than showing
      // an empty control.
      if (input.tagName === "SELECT" && input.selectedIndex < 0) {
        input.selectedIndex = 0;
      }
    });
  }

  function _savePreferences() {
    // Merge rather than replace: per-template layouts live in the same record,
    // and rebuilding from PREFERENCES_ROLES alone would drop every one of them
    // on the next slider nudge.
    var preferences = _readPreferences();
    PREFERENCES_ROLES.forEach(function (role) {
      var input = D.role(_dialog, role);
      if (!input) return;
      preferences[role] =
        input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value;
    });
    _writePreferences(preferences);
  }

  /** Localities printed before, most recent first. Never throws. */
  function _recentLocalities() {
    var saved = _readPreferences().localities;
    if (!Array.isArray(saved)) return [];
    return saved
      .map(function (value) {
        return typeof value === "string" ? value.trim() : "";
      })
      .filter(Boolean);
  }

  /**
   * Record a locality that made it onto a card.
   *
   * Written on a successful print rather than on the field's change event: a
   * name typed, reconsidered and corrected before printing is not a name this
   * congregation uses, and the dropdown is only worth having if everything in
   * it is something that was actually printed.
   */
  function _rememberLocality(value) {
    value = (value || "").trim();
    if (!value) return;

    var id = value.toLowerCase();
    var list = _recentLocalities().filter(function (previous) {
      return previous.toLowerCase() !== id;
    });
    list.unshift(value);

    // Merge, for the same reason _savePreferences merges: the layouts record
    // lives alongside this one.
    var preferences = _readPreferences();
    preferences.localities = list.slice(0, RECENT_LOCALITIES_MAX);
    _writePreferences(preferences);
  }

  function _layoutIsCurrent(layout) {
    if (!layout) return false;
    return layout.source === "manual" || layout.v === LAYOUT_VERSION;
  }

  function _savedLayout(id) {
    var saved = (_readPreferences().layouts || {})[id];
    return _layoutIsCurrent(saved) ? saved : null;
  }

  function _saveLayout(id, layout) {
    if (!id || !layout) return;
    layout.v = LAYOUT_VERSION;
    var preferences = _readPreferences();
    preferences.layouts = preferences.layouts || {};
    preferences.layouts[id] = layout;
    _writePreferences(preferences);
  }

  // LAYOUT

  /**
   * Adopt a layout: resize the canvases, refit, and restart the tile cache.
   *
   * Safe to call before the canvases exist: it then only updates the numbers.
   */
  function _applyLayout(layout) {
    _layout = layout || DEFAULT_LAYOUT;
    PLACEHOLDER = _layout.placeholder;
    FIELDS = _layout.fields || DEFAULT_LAYOUT.fields;
    _candidates = _layout.candidates || [];

    RENDER_W = Math.round((PLACEHOLDER.width / PT_PER_INCH) * DPI);
    RENDER_H = Math.round((PLACEHOLDER.height / PT_PER_INCH) * DPI);

    if (!_dialog || !_preview || !_feature) return;

    _preview.width = RENDER_W;
    _preview.height = RENDER_H;
    _borderCanvas.width = RENDER_W;
    _borderCanvas.height = RENDER_H;
    _filterCanvas.width = RENDER_W;
    _filterCanvas.height = RENDER_H;

    _view = _fitViewFor(_feature, _view ? _view.rotation : 0);
    _desiredEz = _view.ez;

    _syncFrameControls();
    _sizeEraseCursor();
    _retile();
  }

  // TEMPLATE FILE

  var TEMPLATE_KEY = "print:template";

  /**
   * Stable id for a template file. Survives renaming and re-export; changes
   * when the template is actually edited, which is exactly when a saved map
   * box becomes suspect.
   */
  function _templateId(file) {
    if (!window.crypto || !crypto.subtle) {
      // Insecure context - crypto.subtle is undefined on http://0.0.0.0:5000.
      // Weaker, but enough to tell two templates apart on one machine.
      return Promise.resolve(
        "n" +
        [file.name, file.size, file.lastModified]
          .join(":")
          .replace(/\W+/g, "_"),
      );
    }
    return file.arrayBuffer().then(function (buf) {
      return crypto.subtle.digest("SHA-256", buf).then(function (hash) {
        var bytes = new Uint8Array(hash);
        var hex = "";
        for (var i = 0; i < 8; i++) {
          hex += bytes[i].toString(16).padStart(2, "0");
        }
        return hex;
      });
    });
  }

  function _detectLayout(file) {
    return App.pdfdoc.inspectTemplate(file);
  }

  /** A saved box wins; otherwise detect one and remember it. */
  function _resolveLayout(file) {
    return _templateId(file)
      .then(function (id) {
        _layoutId = id;
        var saved = _savedLayout(id);
        if (saved) {
          _applyLayout(saved);
          return saved;
        }
        return _detectLayout(file).then(function (detected) {
          _applyLayout(detected);
          _saveLayout(id, detected);
          return detected;
        });
      })
      .catch(function (err) {
        console.warn(">>> Template layout unresolved:", err && err.message);
        _applyLayout(DEFAULT_LAYOUT);
        _setStatus(T("print.errTemplateLayout"), false);
        return null;
      })
      .then(function (layout) {
        return App.store.set(TEMPLATE_KEY, {
          file: file,
          id: _layoutId,
          layout: layout,
        });
      });
  }

  function _restoreTemplate() {
    return App.store.get(TEMPLATE_KEY).then(function (stored) {
      if (!stored || !_dialog) return;

      // Records written before layouts existed held the File itself.
      var file = stored.file || stored;
      if (!file || !file.name) return;

      _templateFile = file;
      D.text(
        _dialog,
        "template-name",
        T("print.withTemplate", { name: file.name }),
      );
      D.toggle(D.role(_dialog, "clear-template"), true);
      D.toggle(D.role(_dialog, "adjust-template"), true);
      _syncAttach();

      if (_layoutIsCurrent(stored.layout)) {
        _layoutId = stored.id || null;
        _applyLayout(stored.layout);
        return;
      }
      return _resolveLayout(file);
    });
  }

  /**
   * Show the embed option only when there is a PDF to embed into.
   *
   * The attachment is written by App.pdfdoc.compose, which only runs on the
   * template path - without one the card goes to the browser's own print
   * dialog as an image and there is no file of this app's to carry anything.
   * A checkbox that is ticked, remembered, and quietly does nothing is worse
   * than no checkbox: it promises the card is a restore point when it is not.
   */
  function _syncAttach() {
    var row = D.role(_dialog, "attach-row");
    if (row) D.toggle(row, !!_templateFile);
    var hint = D.role(_dialog, "attach-hint");
    if (hint) D.toggle(hint, !!_templateFile);
  }

  /** Owns the template label - callers must not write it themselves. */
  function _setTemplate(file) {
    _templateFile = file || null;
    D.text(
      _dialog,
      "template-name",
      file
        ? T("print.withTemplate", { name: file.name })
        : T("print.noTemplate"),
    );
    D.toggle(D.role(_dialog, "clear-template"), !!file);
    D.toggle(D.role(_dialog, "adjust-template"), !!file);
    _syncAttach();

    if (!file) {
      _layoutId = null;
      _applyLayout(DEFAULT_LAYOUT);
      return App.store.remove(TEMPLATE_KEY);
    }
    return _resolveLayout(file);
  }

  // PLACEMENT - drag the map box onto a render of the template
  //
  // Ordered dependency-first: constants, feedback, coordinate mapping, the
  // loupe, input handling, then open/show/save/close at the end.

  var SNAP_PT = 4;
  var MIN_BOX_PT = 10;
  var LOUPE_SIZE = 160; // re-read from .place-loupe on mount
  var LOUPE_ZOOM = 4;
  var NUDGE_PT = 1;
  var NUDGE_COARSE_PT = 10;
  var NUDGE_FINE_PT = 0.1;
  var NOTICE_MS = 4000;

  var _placeDialog = null;
  var _place = null;
  var _placeResize = null;
  var _placeKeys = null;
  var _noticeTimer = null;

  /**
   * Transient feedback under the readout.
   *
   * Every action reports something. A click that changes nothing has to say so
   * - silence is indistinguishable from a broken button.
   */
  function _placeNotice(text, warn) {
    if (!_placeDialog) return;
    var node = D.role(_placeDialog, "notice");
    if (!node) {
      console.warn(">>> Placement notice element missing:", text);
      return;
    }

    node.textContent = text;
    node.classList.toggle("is-warn", !!warn);
    D.toggle(node, !!text);

    if (_noticeTimer) {
      clearTimeout(_noticeTimer);
      _noticeTimer = null;
    }
    if (!text) return;
    _noticeTimer = setTimeout(function () {
      if (_placeDialog) D.toggle(D.role(_placeDialog, "notice"), false);
      _noticeTimer = null;
    }, NOTICE_MS);
  }

  /** PDF points -> screen px. PDF y grows upward from the bottom-left. */
  function _toScreen(ph) {
    var k = _place.scale;
    return {
      left: ph.x * k,
      top: (_layout.pageHeight - ph.y - ph.height) * k,
      width: ph.width * k,
      height: ph.height * k,
    };
  }

  function _toPage(rect) {
    var k = _place.scale;
    return {
      x: rect.left / k,
      y: _layout.pageHeight - rect.top / k - rect.height / k,
      width: rect.width / k,
      height: rect.height / k,
    };
  }

  /** The screen-space equivalent of MIN_BOX_PT, so drag and nudge agree. */
  function _minBoxPx() {
    return MIN_BOX_PT * _place.scale;
  }

  function _clampBox(b) {
    b.width = Math.max(MIN_BOX_PT, Math.min(b.width, _layout.pageWidth));
    b.height = Math.max(MIN_BOX_PT, Math.min(b.height, _layout.pageHeight));
    b.x = Math.max(0, Math.min(b.x, _layout.pageWidth - b.width));
    b.y = Math.max(0, Math.min(b.y, _layout.pageHeight - b.height));
    return b;
  }

  /**
   * Pull each edge onto a detected rectangle when it is within a few points.
   * The card's own box is what people are aiming for, and landing one point
   * short shows on the printed card as a hairline gap.
   */
  function _snap(ph) {
    _candidates.forEach(function (c) {
      if (Math.abs(ph.x - c.x) < SNAP_PT) ph.x = c.x;
      if (Math.abs(ph.y - c.y) < SNAP_PT) ph.y = c.y;
      if (Math.abs(ph.x + ph.width - (c.x + c.width)) < SNAP_PT) {
        ph.width = c.x + c.width - ph.x;
      }
      if (Math.abs(ph.y + ph.height - (c.y + c.height)) < SNAP_PT) {
        ph.height = c.y + c.height - ph.y;
      }
    });
    return ph;
  }

  /**
   * Magnify the page render around a point, with the frame's edge drawn in at
   * the same magnification.
   *
   * The page renders at roughly 0.15 pt per screen pixel, so a one-point
   * misalignment - which is visible on the printed card - cannot be seen on
   * the stage at all. Showing the frame edge inside the loupe rather than just
   * the template is the part that makes it useful: what matters is the gap
   * between the two, not either one alone.
   */
  function _drawLoupe() {
    if (!_placeDialog || !_place || !_place.focus) return;

    var loupe = D.role(_placeDialog, "loupe");
    var inner = D.role(_placeDialog, "loupe-inner");
    var mark = D.role(_placeDialog, "loupe-box");
    var img = D.role(_placeDialog, "page");
    if (!loupe || !inner || !mark || !img) return;

    var w = img.clientWidth;
    var h = img.clientHeight;
    if (!w || !h) return;

    var half = LOUPE_SIZE / 2;
    var ox = _place.focus[0] * LOUPE_ZOOM - half;
    var oy = _place.focus[1] * LOUPE_ZOOM - half;

    inner.style.backgroundImage = "url(" + _place.url + ")";
    inner.style.backgroundSize = w * LOUPE_ZOOM + "px " + h * LOUPE_ZOOM + "px";
    inner.style.backgroundPosition = -ox + "px " + -oy + "px";

    var r = _toScreen(_place.box);
    mark.style.left = r.left * LOUPE_ZOOM - ox + "px";
    mark.style.top = r.top * LOUPE_ZOOM - oy + "px";
    mark.style.width = r.width * LOUPE_ZOOM + "px";
    mark.style.height = r.height * LOUPE_ZOOM + "px";

    // Move to whichever corner is furthest from the point being inspected.
    loupe.classList.toggle("is-left", _place.focus[0] > w / 2);
    loupe.classList.toggle("is-bottom", _place.focus[1] < h / 2);
    D.toggle(loupe, true);
  }

  function _setLoupeFocus(sx, sy) {
    if (!_place) return;
    _place.focus = [sx, sy];
    _drawLoupe();
  }

  /**
   * Keyboard nudging moves the box but not the pointer, so the loupe would
   * keep magnifying wherever the mouse was last left. Follow the corner
   * closest to it instead - that is the one being adjusted.
   */
  function _focusNearestCorner() {
    if (!_place) return;
    var r = _toScreen(_place.box);
    var corners = [
      [r.left, r.top],
      [r.left + r.width, r.top],
      [r.left, r.top + r.height],
      [r.left + r.width, r.top + r.height],
    ];
    var from = _place.focus || corners[0];
    var best = corners[0];
    var bestD = Infinity;
    corners.forEach(function (c) {
      var d =
        (c[0] - from[0]) * (c[0] - from[0]) +
        (c[1] - from[1]) * (c[1] - from[1]);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    });
    _place.focus = best;
  }

  function _drawPlacement() {
    if (!_placeDialog || !_place) return;

    var box = D.role(_placeDialog, "box");
    var r = _toScreen(_place.box);
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";

    D.text(
      _placeDialog,
      "readout",
      T("place.readout", {
        x: _place.box.x.toFixed(1),
        y: _place.box.y.toFixed(1),
        w: _place.box.width.toFixed(1),
        h: _place.box.height.toFixed(1),
      }),
    );

    _drawLoupe();
  }

  function _bindPlacement(box) {
    var drag = null;

    box.addEventListener("pointerdown", function (e) {
      var handle = e.target.getAttribute("data-h");
      box.setPointerCapture(e.pointerId);
      drag = {
        mode: handle || "move",
        x0: e.clientX,
        y0: e.clientY,
        start: {
          left: box.offsetLeft,
          top: box.offsetTop,
          width: box.offsetWidth,
          height: box.offsetHeight,
        },
      };
      e.preventDefault();
    });

    box.addEventListener("pointermove", function (e) {
      if (!drag || !_place) return;
      e.preventDefault();

      var dx = e.clientX - drag.x0;
      var dy = e.clientY - drag.y0;
      var r = {
        left: drag.start.left,
        top: drag.start.top,
        width: drag.start.width,
        height: drag.start.height,
      };

      if (drag.mode === "move") {
        r.left += dx;
        r.top += dy;
      } else {
        if (drag.mode.indexOf("w") >= 0) {
          r.left += dx;
          r.width -= dx;
        }
        if (drag.mode.indexOf("e") >= 0) r.width += dx;
        if (drag.mode.indexOf("n") >= 0) {
          r.top += dy;
          r.height -= dy;
        }
        if (drag.mode.indexOf("s") >= 0) r.height += dy;
      }

      var maxW = _layout.pageWidth * _place.scale;
      var maxH = _layout.pageHeight * _place.scale;
      var floor = _minBoxPx();
      r.width = Math.max(floor, Math.min(r.width, maxW));
      r.height = Math.max(floor, Math.min(r.height, maxH));
      r.left = Math.max(0, Math.min(r.left, maxW - r.width));
      r.top = Math.max(0, Math.min(r.top, maxH - r.height));

      _place.box = _snap(_toPage(r));
      _drawPlacement();
    });

    function stop() {
      drag = null;
    }
    box.addEventListener("pointerup", stop);
    box.addEventListener("pointercancel", stop);
  }

  var NUDGE = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1], // PDF y grows upward
    ArrowDown: [0, -1],
  };

  function _onPlaceKey(e) {
    if (!_place) return;

    if (e.key === "Escape") {
      e.preventDefault();
      _closePlacement();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      _savePlacement();
      return;
    }

    var d = NUDGE[e.key];
    if (!d) return;

    // Leaflet pans the map on arrow keys and this dialog lives inside the map
    // container, so the event has to be stopped, not merely handled.
    e.preventDefault();
    e.stopPropagation();

    var step = e.shiftKey
      ? NUDGE_COARSE_PT
      : e.altKey
        ? NUDGE_FINE_PT
        : NUDGE_PT;
    var b = _place.box;

    if (e.ctrlKey || e.metaKey) {
      b.width += d[0] * step;
      b.height += d[1] * step;
    } else {
      b.x += d[0] * step;
      b.y += d[1] * step;
    }

    // Deliberately not snapped. Keyboard nudging exists for the cases where
    // snapping is the thing getting in the way.
    _clampBox(b);
    _focusNearestCorner();
    _drawPlacement();
  }

  /** Step to the next detected rectangle, reporting either way. */
  function _cycleSnap() {
    if (!_place) return;

    if (_place.snapOrder.length === 0) {
      // Templates that draw their box as four separate lines, or inside a form
      // XObject, yield no rectangles at all. A dead button with no explanation
      // reads as a bug rather than a limitation.
      _placeNotice(T("place.snapNone"), true);
      return;
    }

    // Cycle rather than always picking the smallest. Which rectangle is the
    // map box is a guess; stepping through turns a wrong guess into one more
    // click instead of a dead end.
    var n = _place.snapOrder.length;
    _place.snapIndex = (_place.snapIndex + 1) % n;
    var c = _place.snapOrder[_place.snapIndex];

    _place.box = _clampBox({
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
    });
    _focusNearestCorner();
    _drawPlacement();

    _placeNotice(
      n === 1
        ? T("place.snapOne")
        : T("place.snapCycled", { i: _place.snapIndex + 1, n: n }),
    );
  }

  function _savePlacement() {
    if (!_place) return;
    var layout = {
      page: _layout.page,
      pageWidth: _layout.pageWidth,
      pageHeight: _layout.pageHeight,
      placeholder: _place.box,
      fields: _layout.fields,
      candidates: _candidates,
      // Exempts this layout from LAYOUT_VERSION invalidation: a box positioned
      // by hand should outlive detector changes.
      source: "manual",
    };
    _saveLayout(_layoutId, layout);
    _applyLayout(layout);
    _closePlacement();
    _setStatus(T("place.applied"), false);
  }

  function _closePlacement() {
    if (_placeResize) {
      window.removeEventListener("resize", _placeResize);
      _placeResize = null;
    }
    if (_placeKeys) {
      document.removeEventListener("keydown", _placeKeys, true);
      _placeKeys = null;
    }
    if (_noticeTimer) {
      clearTimeout(_noticeTimer);
      _noticeTimer = null;
    }
    if (_place && _place.url) URL.revokeObjectURL(_place.url);
    App.shortcuts.pop("place");
    _placeDialog = D.remove(_placeDialog);
    _place = null;
  }

  function _openPlacement() {
    if (_placeDialog) return; // already open - self-evident, no notice needed
    if (!_templateFile) {
      _setStatus(T("print.errNoTemplate"), false);
      return;
    }

    _setStatus(T("print.renderingTemplate"));
    App.pdfdoc
      .renderPage(_templateFile, _layout.page || 0)
      .then(function (blob) {
        _setStatus("");
        if (_dialog) _showPlacement(URL.createObjectURL(blob));
      })
      .catch(function (err) {
        console.error(">>> Placement dialog failed:", err);
        _setStatus(
          T("print.errTemplatePreview", { message: err.message }),
          false,
        );
      });
  }

  function _showPlacement(url) {
    // Mounted directly, not through App.ui.openDialog - that closes whatever
    // dialog is already on screen, and the print dialog has to stay underneath.
    _placeDialog = D.mountOnMap("tpl-place-dialog", s.leafletMap);
    App.i18n.apply(_placeDialog);
    // openDialog() adds this to everything it mounts; this one is mounted by
    // hand, and it is the screen in the app with the most gestures and the
    // least room to write them down.
    App.ui.addHelpButton(_placeDialog);

    var loupe = D.role(_placeDialog, "loupe");
    if (loupe) LOUPE_SIZE = loupe.offsetWidth || LOUPE_SIZE;

    var img = D.role(_placeDialog, "page");
    var box = D.role(_placeDialog, "box");

    _place = {
      url: url,
      scale: 1,
      focus: null,
      // Smallest first: on a card template the larger rectangles are the page
      // frame and the card outline, not the map box.
      snapOrder: _candidates.slice().sort(function (a, b) {
        return a.width * a.height - b.width * b.height;
      }),
      snapIndex: -1,
      box: {
        x: PLACEHOLDER.x,
        y: PLACEHOLDER.y,
        width: PLACEHOLDER.width,
        height: PLACEHOLDER.height,
      },
    };

    // Buttons first: everything below is enhancement, and a throw in any of it
    // would otherwise leave the dialog on screen with no working actions.
    D.onRole(_placeDialog, "cancel", _closePlacement);
    D.onRole(_placeDialog, "save", _savePlacement);
    D.onRole(_placeDialog, "snap", _cycleSnap);

    if (_place.snapOrder.length > 1) {
      // Say how many there are, so cycling is discoverable without a tooltip.
      D.text(
        _placeDialog,
        "snap",
        T("place.snapN", { n: _place.snapOrder.length }),
      );
    }

    var stage = D.role(_placeDialog, "stage");

    function rescale() {
      if (!_place) return;
      // clientWidth is 0 until the image has been laid out, which is a frame
      // after load - a zero scale would put the box at infinity.
      var shown = img.clientWidth || img.naturalWidth || _layout.pageWidth;
      _place.scale = shown / _layout.pageWidth;
      // max-height caps the image's height, so its width comes out of the
      // aspect ratio and intrinsic sizing cannot be relied on to match it.
      // Pinning removes the guesswork: stage box === image box, so the origin
      // .place-box measures from is the page's top-left corner.
      if (stage && img.clientWidth) stage.style.width = img.clientWidth + "px";
      _drawPlacement();
    }

    img.onload = function () {
      // The real map inside the frame, so a wrong aspect ratio is visible here
      // rather than discovered on the printed card.
      if (_preview) {
        box.style.backgroundImage =
          "url(" + _preview.toDataURL("image/png") + ")";
      }
      requestAnimationFrame(rescale);
    };
    img.onerror = function () {
      _placeNotice(T("place.errPage"), true);
    };
    img.src = url;

    _placeResize = rescale;
    window.addEventListener("resize", _placeResize);

    _bindPlacement(box);

    if (stage) {
      stage.addEventListener("pointermove", function (e) {
        var rect = img.getBoundingClientRect();
        _setLoupeFocus(e.clientX - rect.left, e.clientY - rect.top);
      });
      stage.addEventListener("pointerleave", function () {
        if (_placeDialog) D.toggle(D.role(_placeDialog, "loupe"), false);
      });
    } else {
      console.warn('>>> tpl-place-dialog is missing data-role="stage"');
    }

    // Capture phase: this dialog sits inside the Leaflet map container, whose
    // own keyboard handler would otherwise pan the map on every arrow press.
    _placeKeys = _onPlaceKey;
    document.addEventListener("keydown", _placeKeys, true);
    App.shortcuts.push(PLACE_KEYS);
    _placeDialog.focus();
  }

  // PROJECTION

  function _project(lng, lat, ez) {
    var scale = TILE_SIZE * Math.pow(2, ez);
    var x = ((lng + 180) / 360) * scale;
    var sinLat = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * DEG)));
    var y =
      (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return [x, y];
  }

  function _unproject(x, y, ez) {
    var scale = TILE_SIZE * Math.pow(2, ez);
    var lng = (x / scale) * 360 - 180;
    var n = Math.PI - 2 * Math.PI * (y / scale);
    var lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lng, lat];
  }

  /**
   * World pixels -> canvas pixels, about the frame centre. A positive rotation
   * turns the map counter-clockwise inside a frame that itself never moves.
   */
  function _worldToCanvas(x, y, view) {
    var centre = _project(view.lng, view.lat, view.ez);
    var dx = x - centre[0];
    var dy = y - centre[1];
    var r = -view.rotation * DEG;
    var cos = Math.cos(r);
    var sin = Math.sin(r);
    return [
      RENDER_W / 2 + dx * cos - dy * sin,
      RENDER_H / 2 + dx * sin + dy * cos,
    ];
  }

  function _canvasToWorld(px, py, view) {
    var centre = _project(view.lng, view.lat, view.ez);
    var dx = px - RENDER_W / 2;
    var dy = py - RENDER_H / 2;
    var r = view.rotation * DEG;
    var cos = Math.cos(r);
    var sin = Math.sin(r);
    return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos];
  }

  function _toCanvas(lng, lat, view) {
    var p = _project(lng, lat, view.ez);
    return _worldToCanvas(p[0], p[1], view);
  }

  function _fromCanvas(px, py, view) {
    var w = _canvasToWorld(px, py, view);
    return _unproject(w[0], w[1], view.ez);
  }

  function _metersPerPixel(view) {
    return (
      (EARTH_CIRCUMFERENCE_M * Math.cos(view.lat * DEG)) /
      (TILE_SIZE * Math.pow(2, view.ez))
    );
  }

  /** Apply the world->canvas transform, then run fn to draw in world pixels. */
  function _withMapTransform(ctx, view, fn) {
    var centre = _project(view.lng, view.lat, view.ez);
    ctx.save();
    ctx.translate(RENDER_W / 2, RENDER_H / 2);
    ctx.rotate(-view.rotation * DEG);
    ctx.translate(-centre[0], -centre[1]);
    fn();
    ctx.restore();
  }

  function _featureCoords(feature) {
    var out = [];
    G.polygonParts(feature).forEach(function (part) {
      part.geometry.coordinates.forEach(function (ring) {
        for (var i = 0; i < ring.length; i++) out.push(ring[i]);
      });
    });
    return out;
  }

  /**
   * The view that fits the whole feature inside the frame at a given rotation.
   * The extent is measured in the rotated frame, so refitting after a turn
   * genuinely tightens rather than leaving the old slack.
   */
  function _fitViewFor(feature, rotation) {
    var coords = _featureCoords(feature);
    var r = -rotation * DEG;
    var cos = Math.cos(r);
    var sin = Math.sin(r);

    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (var i = 0; i < coords.length; i++) {
      var p = _project(coords[i][0], coords[i][1], 0);
      var rx = p[0] * cos - p[1] * sin;
      var ry = p[0] * sin + p[1] * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }

    var w = Math.max(1e-9, maxX - minX);
    var h = Math.max(1e-9, maxY - minY);
    var ez =
      Math.log(
        Math.min(
          (RENDER_W * (1 - 2 * PADDING)) / w,
          (RENDER_H * (1 - 2 * PADDING)) / h,
        ),
      ) / Math.LN2;
    ez = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, ez));

    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    var back = rotation * DEG;
    var centre = _unproject(
      cx * Math.cos(back) - cy * Math.sin(back),
      cx * Math.sin(back) + cy * Math.cos(back),
      0,
    );

    return { ez: ez, lng: centre[0], lat: centre[1], rotation: rotation };
  }

  // TILE CACHE

  /**
   * Tiles for a view, in world pixels at the session tile zoom.
   * @returns {{tilePx:number, jobs:Array<{x:number,y:number,wx:number,wy:number}>}}
   */
  function _tilesFor(view) {
    var scale = Math.pow(2, view.ez - _tileZoom);
    var tilePx = TILE_SIZE * scale;
    var span = Math.pow(2, _tileZoom);

    // A rotated frame covers a larger axis-aligned area, so the range comes
    // from the frame's four corners rather than its width and height.
    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    [
      [0, 0],
      [RENDER_W, 0],
      [0, RENDER_H],
      [RENDER_W, RENDER_H],
    ].forEach(function (c) {
      var w = _canvasToWorld(c[0], c[1], view);
      if (w[0] < minX) minX = w[0];
      if (w[0] > maxX) maxX = w[0];
      if (w[1] < minY) minY = w[1];
      if (w[1] > maxY) maxY = w[1];
    });

    var jobs = [];
    var y0 = Math.max(0, Math.floor(minY / tilePx));
    var y1 = Math.min(span - 1, Math.floor(maxY / tilePx));
    for (
      var tx = Math.floor(minX / tilePx);
      tx <= Math.floor(maxX / tilePx);
      tx++
    ) {
      for (var ty = y0; ty <= y1; ty++) {
        jobs.push({
          x: ((tx % span) + span) % span,
          y: ty,
          wx: tx * tilePx,
          wy: ty * tilePx,
        });
      }
    }
    return { tilePx: tilePx, jobs: jobs };
  }

  /** Tile zoom for a display zoom at a given offset. */
  function _tileZoomForOffset(ez, offset) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(ez) - offset));
  }

  function _tileZoomFor(ez) {
    return _tileZoomForOffset(ez, TILE_ZOOM_OFFSET);
  }

  /** Slider position: the offset itself, 0 to TILE_ZOOM_OFFSET_MAX. */
  function _detailOffset() {
    var input = _dialog && D.role(_dialog, "detail");
    if (!input) return TILE_ZOOM_OFFSET;
    var v = parseInt(input.value, 10);
    if (isNaN(v)) return TILE_ZOOM_OFFSET;
    return Math.max(0, Math.min(TILE_ZOOM_OFFSET_MAX, v));
  }

  /**
   * Printed height of a basemap label, in points, for an actual view.
   *
   * Derived from the real upscale factor rather than a nominal one, because
   * the display zoom is fractional while the tile zoom is not - the same
   * offset gives a label anywhere within a factor of root-two as you move the
   * zoom slider. Showing the computed value keeps the readout honest.
   */
  function _labelPt(ez, tileZoom) {
    return ((TILE_LABEL_PX * PT_PER_INCH) / DPI) * Math.pow(2, ez - tileZoom);
  }

  /**
   * Re-pick the tile zoom and drop the cache, keeping the current framing.
   *
   * Separate from _applyLayout because changing detail must not refit: the
   * user's pan, zoom and rotation are theirs, and only the basemap resolution
   * is in question.
   */
  function _retile() {
    if (!_dialog || !_view) return;

    TILE_ZOOM_OFFSET = _detailOffset();
    _tileZoom = _tileZoomFor(_view.ez);
    _tiles = new Map();
    _inFlight = 0;

    _syncOutputs();
    _setStatus(T("print.loadingTiles"));
    _prefetch(_view);
    _schedulePaint();
  }

  /**
   * Re-tile only if the view has drifted onto a different tile zoom.
   *
   * Compares the zoom in use against the one the current view wants - not the
   * gap between ez and its own derived zoom, which is structurally bounded at
   * about 1.9 and so could never trigger anything.
   */
  function _maybeRetile() {
    if (!_dialog || !_view) return;
    if (_tileZoomFor(_view.ez) !== _tileZoom) _retile();
  }

  /** Debounced _maybeRetile, for continuous inputs that fire in bursts. */
  function _queueRetile() {
    if (_retileTimer) clearTimeout(_retileTimer);
    _retileTimer = setTimeout(function () {
      _retileTimer = null;
      _maybeRetile();
    }, 250);
  }

  /**
   * Cached tile, starting a fetch on first request. Returns immediately so
   * painting never blocks; arrivals trigger a repaint.
   */
  function _tile(x, y) {
    var key = x + "/" + y;
    var entry = _tiles.get(key);
    if (entry) return entry;

    entry = { img: null, done: false };
    _tiles.set(key, entry);

    if (_inFlight >= TILE_CONCURRENCY) {
      // Defer rather than opening dozens of sockets at once; the next paint
      // will ask again.
      _tiles.delete(key);
      return { img: null, done: false, deferred: true };
    }

    _inFlight++;
    var img = new Image();
    img.onload = function () {
      entry.img = img;
      entry.done = true;
      _inFlight--;
      _schedulePaint();
    };
    img.onerror = function () {
      entry.done = true; // a missing tile leaves the background color
      _inFlight--;
      _schedulePaint();
    };
    // Same-origin proxy, so the canvas stays untainted and exportable.
    img.src = _tileUrl()
      .replace("{z}", _tileZoom)
      .replace("{x}", x)
      .replace("{y}", y);
    return entry;
  }

  /** Warm the cache around the opening view so early panning is instant. */
  function _prefetch(view) {
    var result = _tilesFor(view);
    var seen = {};
    var span = Math.pow(2, _tileZoom);

    result.jobs.forEach(function (job) {
      for (var dx = -TILE_MARGIN; dx <= TILE_MARGIN; dx++) {
        for (var dy = -TILE_MARGIN; dy <= TILE_MARGIN; dy++) {
          var x = (((job.x + dx) % span) + span) % span;
          var y = job.y + dy;
          if (y < 0 || y >= span) continue;
          var key = x + "/" + y;
          if (seen[key]) continue;
          seen[key] = true;
          if (_tiles.size < MAX_TILES) _tile(x, y);
        }
      }
    });
  }

  function _pendingCount(view) {
    var result = _tilesFor(view);
    var pending = 0;
    result.jobs.forEach(function (job) {
      var entry = _tiles.get(job.x + "/" + job.y);
      if (!entry || !entry.done) pending++;
    });
    return pending;
  }

  // ERASE CURSOR

  /**
   * Brush diameter in CSS pixels. The canvas renders at RENDER_W but displays
   * scaled to fit, so the render-space size means nothing on screen until it
   * is converted.
   */
  function _eraseCursorPx() {
    if (!_preview) return 0;
    var rect = _preview.getBoundingClientRect();
    if (!rect.width) return 0;
    return (
      Math.max(2, _opts().eraseSizePt * PX_PER_PT) * (rect.width / RENDER_W)
    );
  }

  function _sizeEraseCursor() {
    if (!_eraseCursor || !_preview) return;
    var d = Math.max(4, _eraseCursorPx());
    _eraseCursor.style.width = d + "px";
    _eraseCursor.style.height = d + "px";
  }

  function _moveEraseCursor(e) {
    if (!_eraseCursor || _eraseCursor.hidden) return;
    var rect = _preview.parentNode.getBoundingClientRect();
    _eraseCursor.style.transform =
      "translate(" +
      (e.clientX - rect.left) +
      "px," +
      (e.clientY - rect.top) +
      "px) translate(-50%,-50%)";
  }

  // PAINT

  function _schedulePaint() {
    if (_paintQueued || !_dialog) return;
    _paintQueued = true;
    requestAnimationFrame(function () {
      _paintQueued = false;
      _paint();
    });
  }

  function _paint() {
    if (!_dialog || !_view) return;

    var ctx = _preview.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#f2efe9"; // OSM land color, so gaps are not stark white
    ctx.fillRect(0, 0, RENDER_W, RENDER_H);

    var result = _tilesFor(_view);
    var missing = 0;

    var support = App.printFilters.support();
    var sharpen = D.role(_dialog, "sharpen");
    var contrast = D.role(_dialog, "contrast");
    var grayscale = D.role(_dialog, "grayscale");
    // One capability question, not three: either the browser runs the SVG
    // filters natively or the software path reproduces them exactly.
    // _applyFilterSupport() has already switched all three off in the rare
    // case that neither is available.
    var can = support.svg || support.pixels;
    var wantSharp = (!sharpen || sharpen.checked) && can;
    var wantContrast = contrast && contrast.checked && can;
    var wantGrayscale = grayscale && grayscale.checked && can;

    // Upright frames keep tile edges on the pixel grid, so they need almost no
    // overlap; a rotated or fractionally scaled frame does, or seams show.
    var upright = Math.abs(_wrap180(_view.rotation) % 90) < 0.01;
    var bleed = upright ? 0.05 : 0.5;

    // Applied to the basemap only. The border and attribution are drawn as
    // vectors at full canvas resolution and are already sharp - running them
    // through the same filter would just add halos.
    var filters = [];
    if (wantSharp) filters.push("url(#tile-sharpen)");
    if (wantContrast) filters.push("url(#tile-contrast)");
    if (wantGrayscale) filters.push("url(#tile-grayscale)");

    // ctx.filter applies per drawing operation, and every filter here samples
    // neighboring pixels: a 3x3 convolution at a tile's edge reads the
    // transparent black outside that single drawImage, not the tile next door.
    // Filtering tile by tile therefore prints a seam along every tile border.
    // So the mosaic is assembled unfiltered on a scratch canvas first and the
    // filter runs once over the finished, seamless image.
    var mosaic = filters.length ? _filterCanvas : null;
    // Through printFilters rather than getContext directly: this is the first
    // call on the mosaic canvas, and the readback hint the software filter
    // path needs is honored on the first call only.
    var target = mosaic ? App.printFilters.mosaicContext(mosaic) : ctx;

    if (mosaic) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, RENDER_W, RENDER_H);
      target.imageSmoothingQuality = "high";
    }

    _withMapTransform(target, _view, function () {
      result.jobs.forEach(function (job) {
        var entry = _tile(job.x, job.y);
        if (entry.img) {
          target.drawImage(
            entry.img,
            job.wx,
            job.wy,
            result.tilePx + bleed,
            result.tilePx + bleed,
          );
        } else if (!entry.done) {
          missing++;
        }
      });
    });

    if (mosaic) {
      if (support.svg) {
        ctx.save();
        ctx.filter = filters.join(" ");
        ctx.drawImage(mosaic, 0, 0);
        ctx.restore(); // restores filter to "none" along with everything else
      } else {
        // Same filters, same order, done by hand. Applied to the scratch
        // canvas rather than the page so the background fill underneath is
        // left alone, exactly as ctx.filter on a single drawImage would.
        App.printFilters.drawFilteredMosaic(ctx, mosaic, {
          sharpen: wantSharp,
          contrast: wantContrast,
          grayscale: wantGrayscale,
        });
      }
    }

    // Between the basemap and the attribution: it stands in for tiles, so it
    // belongs under the credit line and under the border, exactly where the
    // real roads would be.
    _drawOverlay(ctx);

    _drawAttribution(ctx);
    _drawBorder();

    ctx.save();
    ctx.globalAlpha = _opts().opacity;
    ctx.drawImage(_borderCanvas, 0, 0);
    ctx.restore();

    // Last, on top of everything including the border. A scale bar with a red
    // territory outline drawn through it is not a scale bar, and the eraser
    // is aimed at the border rather than at the furniture.
    _drawDecorations(ctx);

    if (missing > 0) {
      _setStatus(
        T("print.loadingProgress", {
          done: result.jobs.length - missing,
          total: result.jobs.length,
        }),
      );
      // Deferred tiles need another pass once a slot frees up.
      if (_inFlight < TILE_CONCURRENCY) _schedulePaint();
    } else {
      _setStatus("");
    }

    _syncHistoryButtons();
  }

  // The sample overlay

  /**
   * On screen the street layer is drawn at a quarter opacity, because there it
   * is a hint laid over a basemap that already shows the roads. Here it *is*
   * the basemap, so it is drawn to be read rather than to be seen through.
   */
  var OVERLAY_STREET_ALPHA = 0.7;
  var OVERLAY_STREET_PT = 1.4;
  var OVERLAY_BUILDING_PT = 0.35;

  function setBasemapOverlay(spec) {
    _overlay = spec && (spec.streets || spec.buildings) ? spec : null;
    if (_dialog) _schedulePaint();
  }

  /**
   * Walk a FeatureCollection down to individual rings and lines.
   *
   * Polygon and LineString differ by one level of nesting and the Multi
   * variants by one more, which is exactly the sort of thing that gets written
   * out four times and then diverges. One walker, four shapes.
   */
  function _eachPath(collection, types, fn) {
    var features = (collection && collection.features) || [];
    features.forEach(function (feature) {
      var geometry = feature && feature.geometry;
      if (!geometry || types.indexOf(geometry.type) < 0) return;

      var isMulti = geometry.type.indexOf("Multi") === 0;
      var isArea = geometry.type.indexOf("Polygon") >= 0;
      var parts = isMulti ? geometry.coordinates : [geometry.coordinates];

      parts.forEach(function (part) {
        (isArea ? part : [part]).forEach(fn);
      });
    });
  }

  /** @returns {boolean} whether a path was actually opened */
  function _trace(ctx, points, close) {
    if (!points || points.length < 2) return false;
    ctx.beginPath();
    var p = _toCanvas(points[0][0], points[0][1], _view);
    ctx.moveTo(p[0], p[1]);
    for (var i = 1; i < points.length; i++) {
      p = _toCanvas(points[i][0], points[i][1], _view);
      ctx.lineTo(p[0], p[1]);
    }
    if (close) ctx.closePath();
    return true;
  }

  /**
   * Colors come from App.polygons rather than being repeated here, so the
   * preview matches the map by construction. Widths do not: those are screen
   * pixels over there and points on paper here, and a 4 px road at 300 dpi is
   * a hairline.
   */
  function _drawOverlay(ctx) {
    if (!_overlay || !_view) return;

    var streetStyle = (App.polygons && App.polygons.STREET_STYLE) || {};
    var buildingStyle = (App.polygons && App.polygons.BUILDING_STYLE) || {};

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Streets first, then buildings - the same order the map's panes stack in,
    // so a house on a corner covers the road rather than the other way round.
    ctx.globalAlpha = OVERLAY_STREET_ALPHA;
    ctx.strokeStyle = streetStyle.color || "#e74c3c";
    ctx.lineWidth = Math.max(1, OVERLAY_STREET_PT * PX_PER_PT);
    _eachPath(
      _overlay.streets,
      ["LineString", "MultiLineString"],
      function (line) {
        if (_trace(ctx, line, false)) ctx.stroke();
      },
    );

    ctx.globalAlpha = 1;
    ctx.fillStyle = buildingStyle.fillColor || "#7f8c8d";
    ctx.strokeStyle = buildingStyle.color || "#555555";
    ctx.lineWidth = Math.max(1, OVERLAY_BUILDING_PT * PX_PER_PT);
    _eachPath(
      _overlay.buildings,
      ["Polygon", "MultiPolygon"],
      function (ring) {
        if (!_trace(ctx, ring, true)) return;
        ctx.save();
        ctx.globalAlpha = buildingStyle.fillOpacity || 0.5;
        ctx.fill();
        ctx.restore();
        ctx.stroke();
      },
    );

    ctx.restore();
  }

  /** OSM's license requires visible attribution, upright regardless of rotation. */
  function _drawAttribution(ctx) {
    var size = Math.round(11 * PX_PER_PT);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = size + "px Arial, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    var x = RENDER_W - size * 0.6;
    var y = RENDER_H - size * 0.5;
    ctx.lineWidth = size * 0.28;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineJoin = "round";
    ctx.strokeText(ATTRIBUTION, x, y);
    ctx.fillStyle = "#333";
    ctx.fillText(ATTRIBUTION, x, y);
    ctx.restore();
  }

  // Card furniture

  /**
   * The largest 1, 2 or 5 x 10^n metres that fits inside `maxMeters`.
   *
   * A scale bar whose end reads "just under 437 m" is a bar nobody measures
   * with. The round number comes first and the bar is then drawn to whatever
   * length that distance happens to be, rather than the other way round.
   *
   * @param {number} maxMeters
   * @returns {number} 0 when there is no sensible answer
   */
  function _niceDistance(maxMeters) {
    if (!(maxMeters > 0) || !isFinite(maxMeters)) return 0;
    var decade = Math.pow(10, Math.floor(Math.log(maxMeters) / Math.LN10));
    var best = decade; // 1 x 10^n always fits: the decade is <= maxMeters
    [2, 5].forEach(function (step) {
      if (step * decade <= maxMeters) best = step * decade;
    });
    return best;
  }

  /**
   * What the scale bar should say and how long it should be.
   *
   * Pure, and exported, because it is the half of the bar that can be wrong
   * without looking wrong: a bar of the correct length under the wrong number
   * is a card that measures distances incorrectly and says so confidently.
   *
   * @param {number} metersPerPixel
   * @param {number} widthPx the full width of the card
   * @returns {{meters: number, px: number, label: string}|null}
   */
  function scaleFor(metersPerPixel, widthPx) {
    if (!(metersPerPixel > 0) || !(widthPx > 0)) return null;
    var meters = _niceDistance(widthPx * SCALE_MAX_FRACTION * metersPerPixel);
    if (!meters) return null;
    return {
      meters: meters,
      px: meters / metersPerPixel,
      label:
        meters >= 1000
          ? T("print.scaleKm", { value: App.i18n.n(meters / 1000) })
          : T("print.scaleM", { value: App.i18n.n(meters) }),
    };
  }

  /**
   * The canvas direction a compass bearing points in, as a unit vector.
   *
   * The frame never turns - the map turns inside it - so a bearing has to be
   * counter-rotated by the same angle the map was turned through. Exported
   * for the same reason as scaleFor: a compass that is confidently wrong is
   * worse than no compass, and off-by-a-sign is the whole failure mode.
   *
   * @param {number} bearingDeg clockwise from north
   * @param {number} rotationDeg the frame's rotation, positive counter-clockwise
   * @returns {[number, number]} +x is right, +y is down
   */
  function compassVector(bearingDeg, rotationDeg) {
    var a = (bearingDeg - (rotationDeg || 0)) * DEG;
    return [Math.sin(a), -Math.cos(a)];
  }

  /** Text with the same white halo the attribution uses, so it reads anywhere. */
  function _haloText(ctx, text, x, y, size) {
    ctx.lineWidth = Math.max(1, size * 0.28);
    ctx.strokeStyle = HALO;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = INK;
    ctx.fillText(text, x, y);
  }

  /**
   * A scale bar in the bottom-left corner.
   *
   * Drawn in canvas space rather than through the map transform: a scale bar
   * that turned with the frame would be a diagonal ruler with sideways
   * lettering. The distance it represents is still measured through the view,
   * so it stays correct at any rotation.
   */
  function _drawScaleBar(ctx) {
    var bar = scaleFor(_metersPerPixel(_view), RENDER_W);
    if (!bar) return;

    var margin = DECOR_MARGIN_PT * PX_PER_PT;
    var height = SCALE_BAR_PT * PX_PER_PT;
    var size = SCALE_FONT_PT * PX_PER_PT;
    var x = margin;
    var y = RENDER_H - margin - height;
    var segment = bar.px / SCALE_SEGMENTS;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // A light backing first: OSM's forest green and water blue are dark
    // enough to swallow a thin black outline on their own.
    ctx.fillStyle = HALO;
    ctx.fillRect(
      x - height * 0.4,
      y - height * 0.4,
      bar.px + height * 0.8,
      height * 1.8,
    );

    for (var i = 0; i < SCALE_SEGMENTS; i++) {
      ctx.fillStyle = i % 2 === 0 ? INK : "#ffffff";
      ctx.fillRect(x + i * segment, y, segment, height);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, height * 0.12);
    ctx.strokeRect(x, y, bar.px, height);

    ctx.font = size + "px Arial, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.textAlign = "left";
    _haloText(ctx, "0", x, y - height * 0.5, size);
    ctx.textAlign = "right";
    _haloText(ctx, bar.label, x + bar.px, y - height * 0.5, size);

    ctx.restore();
  }

  /**
   * A compass rose in the top-right corner, opposite the attribution.
   *
   * The arms turn with the map and the letters do not. A rose whose lettering
   * turned too would put an upside-down N on every card framed at 180 deg, and
   * the one thing a compass has to be is legible.
   */
  function _drawCompass(ctx) {
    var r = COMPASS_RADIUS_PT * PX_PER_PT;
    var margin = DECOR_MARGIN_PT * PX_PER_PT;
    var size = COMPASS_FONT_PT * PX_PER_PT;
    var cx = RENDER_W - margin - r;
    var cy = margin + r;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = HALO;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, r * 0.04);
    ctx.stroke();

    ctx.font = "bold " + size + "px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    COMPASS_POINTS.forEach(function (point) {
      var v = compassVector(point.bearing, _view.rotation);
      var arm = r * 0.6;

      if (point.needle) {
        // A filled triangle rather than a line: north is the only direction
        // anyone actually looks for, and it has to survive a greyscale card.
        ctx.beginPath();
        ctx.moveTo(cx + v[0] * arm, cy + v[1] * arm);
        ctx.lineTo(cx - v[1] * r * 0.16, cy + v[0] * r * 0.16);
        ctx.lineTo(cx + v[1] * r * 0.16, cy - v[0] * r * 0.16);
        ctx.closePath();
        ctx.fillStyle = COMPASS_NEEDLE;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + v[0] * arm, cy + v[1] * arm);
        ctx.strokeStyle = INK;
        ctx.lineWidth = Math.max(1, r * 0.05);
        ctx.stroke();
      }

      _haloText(
        ctx,
        T(point.key),
        cx + v[0] * r * 0.82,
        cy + v[1] * r * 0.82,
        size,
      );
    });

    ctx.restore();
  }

  function _drawDecorations(ctx) {
    if (!_view) return;
    var o = _opts();
    if (o.scale) _drawScaleBar(ctx);
    if (o.compass) _drawCompass(ctx);
  }

  function _drawBorder() {
    var o = _opts();
    var ctx = _borderCanvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, RENDER_W, RENDER_H);

    // Drawn fully opaque here; opacity is applied once at composite time so
    // overlapping segments do not stack into a darker line.
    ctx.save();
    ctx.strokeStyle = o.color;
    ctx.lineWidth = Math.max(1, o.widthPt * PX_PER_PT);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    G.polygonParts(_feature).forEach(function (part) {
      part.geometry.coordinates.forEach(function (ring) {
        if (ring.length < 2) return;
        ctx.beginPath();
        var p = _toCanvas(ring[0][0], ring[0][1], _view);
        ctx.moveTo(p[0], p[1]);
        for (var i = 1; i < ring.length; i++) {
          p = _toCanvas(ring[i][0], ring[i][1], _view);
          ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
        ctx.stroke();
      });
    });
    ctx.restore();

    // Erased spans punch through the border only - the map beneath is intact.
    var mpp = _metersPerPixel(_view);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    _strokes.forEach(function (stroke) {
      var widthPx = Math.max(2, stroke.sizeM / mpp);
      var pts = stroke.points.map(function (c) {
        return _toCanvas(c[0], c[1], _view);
      });
      ctx.lineWidth = widthPx;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], widthPx / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    });
    ctx.restore();
  }

  // DIALOG

  function _setBusy(busy) {
    _busy = busy;
    D.toggleClass(D.role(_dialog, "print"), "is-disabled", busy);
    D.toggleClass(D.role(_dialog, "download"), "is-disabled", busy);
    D.toggleClass(D.role(_dialog, "cancel"), "is-disabled", busy);
    _preview.classList.toggle("is-busy", busy);
  }

  function _teardown() {
    _closePlacement();
    _releaseOutput();
    if (_eraseRO) {
      _eraseRO.disconnect();
      _eraseRO = null;
    }
    if (_retileTimer) {
      clearTimeout(_retileTimer);
      _retileTimer = null;
    }
    App.history.popScope("erase");
    App.shortcuts.pop("print");
    _dialog = null;
    _feature = null;
    _eraseCursor = null;
    _preview = _borderCanvas = _filterCanvas = null;
    _view = null;
    _desiredEz = null;
    _tiles = null;
    _strokes = [];
    _redoStack = [];
    _stroke = null;
    _pan = null;
    _rotate = null;
    _rotationDragging = false;
    _templateFile = null;
    _layoutId = null;
    _busy = false;
  }

  function printCluster(feature) {
    if (!feature || !feature.geometry) {
      alert(T("print.errNoGeometry"));
      return;
    }

    // openDialog closes whatever is already open, and that teardown clears
    // module state - so nothing may be assigned before this line.
    _dialog = App.ui.openDialog("tpl-print-dialog", _teardown);

    _feature = feature;
    _strokes = [];
    _redoStack = [];
    App.history.pushScope(ERASE_SCOPE);
    _stroke = null;
    _pan = null;
    _templateFile = null;
    _layoutId = null;
    _tiles = new Map();
    _inFlight = 0;
    _view = null;
    _desiredEz = null;

    _preview = D.role(_dialog, "canvas");
    _eraseCursor = D.role(_dialog, "erase-cursor");
    _borderCanvas = document.createElement("canvas");
    _filterCanvas = document.createElement("canvas");

    _wireControls();
    // Only when it would be a surprise. Someone printing from the OSM view
    // gets what they see and needs no explanation; someone who has been
    // looking at satellite imagery for the last ten minutes is about to get
    // something else, and should hear it here rather than off the printer.
    D.toggleRole(_dialog, "osm-only", App.basemap.isAid());
    _loadPreferences();
    _suggestNames();
    // After _loadPreferences, so a preference saved in a browser that could
    // sharpen does not come back checked in one that cannot.
    _applyFilterSupport();

    // Sizes both canvases, fits the view, picks the tile zoom and starts the
    // prefetch - everything downstream of the frame's aspect ratio.
    _applyLayout(DEFAULT_LAYOUT);

    // May replace the layout a moment later, which redoes all of the above.
    _restoreTemplate();
  }

  /**
   * Fill both card fields with what the map already knows.
   *
   * The number is the easy half: the chip on the shape says 7, so the field
   * says 7. The locality is the half that would otherwise be retyped once per
   * card for a whole round, and it is never actually unknown - it is in the
   * addr:city and addr:place tags of the buildings inside the shape, which the
   * app has already downloaded, drawn and counted. App.naming tallies them.
   *
   * Both are suggestions rather than facts, which is why the guess goes in the
   * placeholder and everything else goes in a datalist. The number is this
   * session's index into s.clusters and a congregation's S-13 numbering is its
   * own thing; the locality tagged on a building is whatever a mapper wrote
   * there, and a congregation that says "Mainz-Süd" where OSM says "Mainz"
   * should be typing over a hint rather than deleting an answer. Anything
   * already typed always wins - the field is the user's, not ours.
   *
   * Locality is a preference and comes back filled from the last card, so most
   * of the time the placeholder is never seen. That is the point: the
   * suggestion is for the first card of a round and for the round after the
   * congregation moves to the next village.
   */
  function _suggestNames() {
    var localityInput = D.role(_dialog, "locality");
    var territoryInput = D.role(_dialog, "territory");
    if (!localityInput || !territoryInput) return;

    var localities = App.naming ? App.naming.localityCandidates(_feature) : [];
    var recent = _recentLocalities();
    var best = localities.length ? localities[0].value : recent[0] || "";

    if (!localityInput.value.trim() && best) localityInput.placeholder = best;
    _fillOptions("locality-options", localityInput, _values(localities).concat(recent));

    _suggestTerritory(territoryInput, localityInput.value.trim() || best);

    // Nominatim is the answer where the buildings have no addresses at all,
    // which is most of the world. It arrives late and only ever adds to the
    // list - the tags inside the shape stay ahead of it, because they describe
    // this territory while a reverse lookup describes one point in it.
    if (!App.naming) return;
    var target = _feature;
    App.naming.reverse(_feature).then(function (extra) {
      // The dialog may have been closed, or reopened on another territory,
      // while the lookup was in flight.
      if (!_dialog || _feature !== target || !extra.length) return;

      var merged = _values(localities).concat(_values(extra), recent);
      _fillOptions("locality-options", localityInput, merged);

      var top = best || extra[0].value;
      if (!localityInput.value.trim() && !localityInput.placeholder)
        localityInput.placeholder = top;
      _suggestTerritory(territoryInput, localityInput.value.trim() || top);
    });
  }

  /** The number, its zero-padded form, and the locality-qualified form. */
  function _suggestTerritory(input, locality) {
    var candidates = App.naming
      ? App.naming.territoryCandidates(_feature, locality)
      : [];
    if (!candidates.length) return;
    if (!input.value.trim()) input.placeholder = candidates[0].value;
    _fillOptions("territory-options", input, _values(candidates));
  }

  function _values(candidates) {
    return (candidates || []).map(function (candidate) {
      return candidate.value;
    });
  }

  /**
   * Point an input at a datalist and rebuild the options in it.
   *
   * The id is assigned here rather than written into the template because the
   * template is cloned: a hardcoded id would be duplicated the moment two
   * dialogs ever coexisted, and `list=` is the one attribute in this dialog
   * that cannot be expressed as a data-role lookup.
   */
  function _fillOptions(role, input, values) {
    var list = D.role(_dialog, role);
    if (!list || !input) return;

    if (!list.id) list.id = "print-" + role + "-" + ++_optionsSeq;
    if (input.getAttribute("list") !== list.id)
      input.setAttribute("list", list.id);

    var seen = Object.create(null);
    list.textContent = "";
    (values || []).forEach(function (value) {
      var text = (value == null ? "" : String(value)).trim();
      var id = text.toLowerCase();
      if (!text || seen[id]) return;
      seen[id] = true;
      var option = document.createElement("option");
      option.value = text;
      list.appendChild(option);
    });
  }

  function close() {
    if (!_dialog) return;
    App.ui.closeDialog();
  }

  /**
   * Switch off whichever basemap filters this browser cannot run, and say so.
   *
   * Leaving a checkbox live that does nothing is the failure worth avoiding:
   * the user ticks "Sharpen the map", sees no change, and has no way to tell
   * a broken feature from a subtle one.
   */
  function _applyFilterSupport() {
    var support = App.printFilters.support();
    if (support.svg) return; // native path; nothing to explain

    if (!support.pixels) {
      _disableFilterCheck("sharpen");
      _disableFilterCheck("contrast");
      _disableFilterCheck("grayscale");
    }

    var note = D.role(_dialog, "filter-note");
    if (!note) return;
    var key = support.pixels ? "print.filterSoftware" : "print.filterNone";
    // Re-target data-i18n too, so a language change keeps the right message.
    note.setAttribute("data-i18n", key);
    note.textContent = T(key);
    D.toggle(note, true);
  }

  function _disableFilterCheck(role) {
    var input = D.role(_dialog, role);
    if (!input) return;
    input.checked = false;
    input.disabled = true;
    var label = input.parentNode;
    if (label && label.classList) label.classList.add("is-disabled");
  }

  function _wireControls() {
    ["color", "width", "opacity"].forEach(function (role) {
      D.role(_dialog, role).addEventListener("input", function () {
        _syncOutputs();
        _savePreferences();
        _schedulePaint();
      });
    });

    D.role(_dialog, "erase-size").addEventListener("input", function () {
      _syncOutputs();
      _sizeEraseCursor();
      _savePreferences();
    });

    D.role(_dialog, "locality").addEventListener("change", _savePreferences);
    D.role(_dialog, "erase").addEventListener("change", _syncEraseMode);

    var zoomInput = D.role(_dialog, "zoom");
    zoomInput.addEventListener("input", function (e) {
      _view.ez = _desiredEz = parseFloat(e.target.value);
      _schedulePaint();
    });
    zoomInput.addEventListener("change", _maybeRetile);

    var rotation = D.role(_dialog, "rotation");
    if (rotation) {
      // Magnetism applies to dragging only. Arrow keys move the slider by one
      // degree, which is inside the snap tolerance of every 15-degree mark, so
      // snapping keyboard input would pull each press straight back and leave
      // the control looking dead.
      rotation.addEventListener("pointerdown", function () {
        _rotationDragging = true;
      });
      rotation.addEventListener("pointerup", function () {
        _rotationDragging = false;
      });
      rotation.addEventListener("pointercancel", function () {
        _rotationDragging = false;
      });

      rotation.addEventListener("input", function (e) {
        // Alt bypasses the magnetism even while dragging.
        _setRotation(
          parseFloat(e.target.value),
          !_rotationDragging || e.altKey,
        );
      });
      rotation.addEventListener("change", _maybeRetile);
    }

    var detail = D.role(_dialog, "detail");
    if (detail) {
      // input for the readout, change for the refetch: a range fires input on
      // every pixel of drag, and each would drop the whole tile cache.
      detail.addEventListener("input", _syncOutputs);
      detail.addEventListener("change", function () {
        _retile();
        _savePreferences();
      });
    }

    var sharpen = D.role(_dialog, "sharpen");
    if (sharpen) {
      sharpen.addEventListener("change", function () {
        _savePreferences();
        _schedulePaint();
      });
    }

    var contrast = D.role(_dialog, "contrast");
    if (contrast) {
      contrast.addEventListener("change", function () {
        _savePreferences();
        _schedulePaint();
      });
    }

    var grayscale = D.role(_dialog, "grayscale");
    if (grayscale) {
      grayscale.addEventListener("change", function () {
        _savePreferences();
        _schedulePaint();
      });
    }

    // The furniture is composited on the finished card rather than mixed into
    // the tile mosaic, so switching either one costs a repaint and no refetch.
    ["scale", "compass"].forEach(function (role) {
      var box = D.role(_dialog, role);
      if (!box) return;
      box.addEventListener("change", function () {
        _savePreferences();
        _schedulePaint();
      });
    });

    D.onRole(_dialog, "rotate-ccw", function () {
      _setRotation(_view.rotation + ROTATION_STEP);
    });
    D.onRole(_dialog, "rotate-cw", function () {
      _setRotation(_view.rotation - ROTATION_STEP);
    });
    D.onRole(_dialog, "rotate-reset", function () {
      _setRotation(0);
    });

    D.onRole(_dialog, "fit", function () {
      // Refit at the current rotation rather than resetting it: after turning
      // the map you usually want the same angle, tightened.
      _view = _fitViewFor(_feature, _view.rotation);
      _desiredEz = _view.ez;
      _syncFrameControls();
      _maybeRetile();
      _schedulePaint();
    });

    D.role(_dialog, "template").addEventListener("change", function (e) {
      // _setTemplate owns the label; writing it here as well raced the async
      // layout detection and could leave a stale name on screen.
      _setTemplate(e.target.files[0] || null);
    });
    D.onRole(_dialog, "adjust-template", _openPlacement);
    D.onRole(_dialog, "clear-template", function () {
      D.role(_dialog, "template").value = "";
      _setTemplate(null);
    });

    D.onRole(_dialog, "undo", undo);
    D.onRole(_dialog, "redo", redo);
    D.onRole(_dialog, "clear-erase", function () {
      if (_strokes.length === 0) return;
      _redoStack = _redoStack.concat(_strokes.slice().reverse());
      _strokes = [];
      _schedulePaint();
    });
    D.onRole(_dialog, "cancel", close);
    D.onRole(_dialog, "print", function () {
      _run("print");
    });
    D.onRole(_dialog, "download", function () {
      _run("download");
    });

    App.shortcuts.push(PRINT_KEYS);
    // Bound directly rather than through D.onRole: that helper calls
    // preventDefault() on every click, which is right for the <button>s and
    // would cancel this <a>'s navigation.
    // The dialog container already has disableClickPropagation, so the map
    // never sees this click either way.
    var openFile = D.role(_dialog, "open-file");
    if (openFile) {
      openFile.addEventListener("click", function () {
        _setStatus("");
      });
    }

    _preview.addEventListener("pointerdown", _onPointerDown);
    _preview.addEventListener("pointermove", _onPointerMove);
    _preview.addEventListener("pointerup", _onPointerUp);
    _preview.addEventListener("pointercancel", _onPointerUp);
    _preview.addEventListener("wheel", _onWheel, { passive: false });

    _preview.addEventListener("pointermove", _moveEraseCursor);
    _preview.addEventListener("pointerenter", function (e) {
      _eraseCursor.hidden = !_opts().erasing;
      _sizeEraseCursor();
      _moveEraseCursor(e);
    });
    _preview.addEventListener("pointerleave", function () {
      _eraseCursor.hidden = true;
    });

    // The preview is fluid, so the render-to-screen ratio changes whenever the
    // dialog is resized - the ring has to be resized with it.
    if (window.ResizeObserver) {
      _eraseRO = new ResizeObserver(_sizeEraseCursor);
      _eraseRO.observe(_preview);
    }

    _syncEraseMode();
  }

  /** Fold any angle into (-180, 180], which is the slider's range. */
  function _wrap180(deg) {
    var d = ((((deg + 180) % 360) + 360) % 360) - 180;
    return d === -180 ? 180 : d;
  }

  /**
   * Pull the angle onto a 15-degree mark when it is close to one.
   *
   * Free rotation is the point of the slider, but the angles people actually
   * want are almost always round - square to a street grid, or a quarter turn.
   * Hitting those exactly on a 361-position slider is otherwise luck.
   */
  function _snapRotation(deg) {
    var near = Math.round(deg / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
    return Math.abs(deg - near) <= ROTATION_SNAP_TOL ? near : deg;
  }

  function _setRotation(degrees, freeform) {
    if (!_view) return;
    var deg = _wrap180(degrees);
    if (!freeform) deg = _snapRotation(deg);

    _view.rotation = deg;
    var input = D.role(_dialog, "rotation");
    if (input) input.value = deg;

    _syncFrameControls();
    _schedulePaint();
  }

  function _syncFrameControls() {
    if (!_dialog || !_view) return;

    var zoom = D.role(_dialog, "zoom");
    var fit = _fitViewFor(_feature, _view.rotation);
    var min = Math.max(MIN_ZOOM, fit.ez - ZOOM_OUT_HEADROOM);
    var max = Math.min(MAX_ZOOM, fit.ez + ZOOM_IN_HEADROOM);

    zoom.min = min.toFixed(2);
    zoom.max = max.toFixed(2);
    zoom.step = "0.05";

    // Clamp from the remembered value, never from the clamped one. A rotated
    // frame needs a lower fit zoom, so clamping in place would ratchet the
    // zoom down a little on every rotation and never give it back.
    if (_desiredEz === null) _desiredEz = _view.ez;
    _view.ez = Math.max(min, Math.min(max, _desiredEz));
    zoom.value = _view.ez;

    _syncOutputs();
  }

  function _syncOutputs() {
    if (!_dialog) return;

    var pt = function (role) {
      return T("print.unitPt", { value: D.role(_dialog, role).value });
    };
    D.text(_dialog, "width-out", pt("width"));
    D.text(_dialog, "erase-size-out", pt("erase-size"));
    D.text(
      _dialog,
      "opacity-out",
      T("print.unitPercent", { value: D.role(_dialog, "opacity").value }),
    );
    D.text(
      _dialog,
      "rotation-out",
      T("print.unitDeg", { value: _view ? Math.round(_view.rotation) : 0 }),
    );

    var detail = D.role(_dialog, "detail");
    if (!detail || !_view) return;

    // Previews the slider's current position, which may not be applied yet --
    // the refetch waits for change, the readout follows input.
    var z = _tileZoomForOffset(_view.ez, _detailOffset());
    D.text(
      _dialog,
      "detail-out",
      T("print.detailOut", { pt: _labelPt(_view.ez, z).toFixed(1), z: z }),
    );
    // Below TILE_ZOOM_WARN, OSM stops naming minor roads - going softer
    // deletes the labels rather than enlarging them.
    D.toggleClass(D.role(_dialog, "detail-out"), "is-warn", z < TILE_ZOOM_WARN);
  }

  function _syncEraseMode() {
    var erasing = D.role(_dialog, "erase").checked;
    _preview.classList.toggle("is-erasing", erasing);
    _preview.classList.toggle("is-panning", !erasing);
    if (_eraseCursor) {
      _eraseCursor.hidden = !erasing;
      if (erasing) _sizeEraseCursor();
    }
    _syncOutputs();
  }

  /**
   * @param {string} text
   * @param {boolean} [working=true] false for terminal messages. A saved or
   *   failed state that keeps spinning reads as "still busy" forever.
   */
  function _setStatus(text, working) {
    if (!_dialog) return;
    // Written to the inner span, not the paragraph: the paragraph also holds
    // the spinner, and setting its textContent would delete it.
    D.text(_dialog, "status-text", text);
    D.toggle(D.role(_dialog, "status"), !!text);
    D.toggle(D.role(_dialog, "status-spinner"), !!text && working !== false);
  }


  // KEYBOARD

  /**
   * The card screen's keys, registered rather than listened for.
   *
   * A listener on the dialog node is invisible to the sheet, which would then
   * list the keys of whatever tool is open behind the dialog and say nothing
   * about the dialog itself - including that Ctrl+Enter prints, which is the
   * one thing everybody here wants to do.
   *
   * `exclusive` is what lets a dialog participate rather than merely block:
   * nothing beneath this answers, and what this registers does.
   *
   * Every letter here is a control on the right-hand column, and the reason
   * they are safe as bare letters is that nothing fires while a text field
   * has focus - the two card fields are the only text in the dialog.
   */
  var PRINT_KEYS = {
    id: "print",
    titleKey: "shortcuts.groupPrint",
    exclusive: true,
    entries: [
      {
        // Plain Enter deliberately does not print: the Card group holds two
        // text fields, and submitting a job from inside one of them is
        // exactly the accident this avoids. Which is also why it is one of
        // the two entries here that fires while typing - from inside those
        // fields it is unambiguous, and it is where the hand already is.
        combos: ["Mod+Enter"],
        labelKey: "shortcuts.printGo",
        whileTyping: true,
        when: function () {
          return !_busy;
        },
        run: function () {
          _run("print");
        },
      },
      {
        // The other half of the footer, and the combo everyone already tries
        // there. It fires while typing for the same reason Mod+Enter does,
        // and preventDefault() keeps it from saving the page instead.
        combos: ["Mod+S"],
        labelKey: "shortcuts.printSave",
        whileTyping: true,
        when: function () {
          return !_busy;
        },
        run: function () {
          _run("download");
        },
      },
      {
        combos: ["E"],
        labelKey: "shortcuts.printErase",
        run: function () {
          var box = D.role(_dialog, "erase");
          if (!box) return;
          box.checked = !box.checked;
          _syncEraseMode();
        },
      },
      {
        combos: ["F"],
        labelKey: "shortcuts.printFit",
        run: function () {
          _view = _fitViewFor(_feature, _view.rotation);
          _desiredEz = _view.ez;
          _syncFrameControls();
          _maybeRetile();
          _schedulePaint();
        },
      },
      {
        // Turning the map is a drag on the preview or a pair of buttons, and
        // both are awkward for the small correction that is most of what
        // rotation is used for - a village street that runs slightly off the
        // vertical.
        combos: ["["],
        labelKey: "shortcuts.printRotateCcw",
        run: function () {
          _setRotation(_view.rotation + ROTATION_STEP);
        },
      },
      {
        combos: ["]"],
        labelKey: "shortcuts.printRotateCw",
        run: function () {
          _setRotation(_view.rotation - ROTATION_STEP);
        },
      },
      {
        combos: ["0"],
        labelKey: "shortcuts.printRotateReset",
        when: function () {
          return !!_view && _view.rotation !== 0;
        },
        run: function () {
          _setRotation(0);
        },
      },
      {
        combos: ["T"],
        labelKey: "shortcuts.printPlace",
        when: function () {
          return !!_templateFile;
        },
        run: _openPlacement,
      },
      {
        combos: ["Escape"],
        labelKey: "shortcuts.printCancel",
        whileTyping: true,
        run: close,
      },
      { combos: ["Drag"], labelKey: "shortcuts.printPan", note: true },
      { combos: ["Wheel"], labelKey: "shortcuts.printZoom", note: true },
      // Shift starts the turn, which is what the hint under the frame says.
      // Alt is a modifier *within* that drag and does not start anything:
      // held, the angle stops snapping to steps. Listing Alt on its own would
      // claim a gesture this dialog does not have, and on a Mac it would read
      // as ⌥ where the hint two inches away reads Shift.
      { combos: ["Shift+drag"], labelKey: "shortcuts.printRotateDrag", note: true },
      {
        combos: ["Shift+Alt+drag"],
        labelKey: "shortcuts.printRotateFree",
        note: true,
      },
      { combos: ["Shift+Wheel"], labelKey: "shortcuts.printRotateStep", note: true },
    ],
  };

  /**
   * The placement frame's keys, listed rather than bound.
   *
   * They are handled by _onPlaceKey on the capture phase, and they have to
   * stay there: this dialog lives inside the Leaflet map container, whose own
   * keyboard handler pans the map on an arrow press, so the event has to be
   * stopped before it bubbles rather than merely answered when it arrives.
   * The tour makes the same trade for the same reason.
   *
   * Listed here because the behavior otherwise has no record: four distinct
   * gestures - nudge, resize, coarse, fine - would exist only in the source,
   * and the readout under the frame has no room to explain them. They are
   * notes rather than bindings, and the sheet is where they are written down.
   */
  var PLACE_KEYS = {
    id: "place",
    titleKey: "shortcuts.groupPlace",
    exclusive: true,
    entries: [
      { combos: ["Enter"], labelKey: "shortcuts.placeSave", note: true },
      { combos: ["Escape"], labelKey: "shortcuts.placeCancel", note: true },
      { combos: ["Arrows"], labelKey: "shortcuts.placeNudge", note: true },
      { combos: ["Mod+Arrows"], labelKey: "shortcuts.placeResize", note: true },
      { combos: ["Shift+Arrows"], labelKey: "shortcuts.placeCoarse", note: true },
      { combos: ["Alt+Arrows"], labelKey: "shortcuts.placeFine", note: true },
      {
        // Cycling the detected boxes needs a key of its own: this is a dialog
        // whose whole point is that your hands are on the arrow keys, and a
        // button in the corner takes them off.
        combos: ["S"],
        labelKey: "shortcuts.placeSnap",
        run: function () {
          _cycleSnap();
        },
      },
      { combos: ["Drag"], labelKey: "shortcuts.placeDrag", note: true },
    ],
  };

  function _opts() {
    return {
      color: D.role(_dialog, "color").value,
      widthPt: parseFloat(D.role(_dialog, "width").value),
      opacity: parseFloat(D.role(_dialog, "opacity").value) / 100,
      eraseSizePt: parseFloat(D.role(_dialog, "erase-size").value),
      erasing: D.role(_dialog, "erase").checked,
      locality: D.role(_dialog, "locality").value.trim(),
      territory: D.role(_dialog, "territory").value.trim(),
      scale: _checked("scale"),
      compass: _checked("compass"),
      // Only meaningful on the template path: the no-template path hands a
      // PNG to the browser's own print dialog, and there is no PDF of ours to
      // attach anything to.
      attach: _checked("attach"),
    };
  }

  /** A checkbox that may not be in the template, read as false when absent. */
  function _checked(role) {
    var box = D.role(_dialog, role);
    return !!(box && box.checked);
  }

  // POINTER - erase or pan, depending on the mode

  function _pointerCanvas(e) {
    var rect = _preview.getBoundingClientRect();
    return [
      ((e.clientX - rect.left) / rect.width) * RENDER_W,
      ((e.clientY - rect.top) / rect.height) * RENDER_H,
    ];
  }

  /** Pointer angle about the frame centre, in degrees. */
  function _angleAt(at) {
    return Math.atan2(at[1] - RENDER_H / 2, at[0] - RENDER_W / 2) / DEG;
  }

  function _onPointerDown(e) {
    if (!_view) return;
    e.preventDefault();
    _preview.setPointerCapture(e.pointerId);
    var at = _pointerCanvas(e);

    if (e.shiftKey) {
      // Shift-drag rotates. Anchored on the angle under the pointer at press
      // time so the map turns with the hand rather than jumping to it.
      _rotate = { from: _angleAt(at), start: _view.rotation };
      return;
    }

    if (_opts().erasing) {
      var sizePx = Math.max(2, _opts().eraseSizePt * PX_PER_PT);
      _stroke = {
        // Stored geographically so erasures stay on the street name they were
        // drawn over when the frame is moved afterwards.
        sizeM: sizePx * _metersPerPixel(_view),
        points: [_fromCanvas(at[0], at[1], _view)],
      };
      _strokes.push(_stroke);
      _redoStack = [];
      _schedulePaint();
      return;
    }

    // Grab-and-drag: remember the geographic point under the cursor and keep
    // it there. Works unchanged at any rotation.
    _pan = { grabbed: _fromCanvas(at[0], at[1], _view) };
  }

  function _onPointerMove(e) {
    if (_rotate) {
      e.preventDefault();
      var turned = _angleAt(_pointerCanvas(e));
      // Screen angles grow clockwise because y points down, while a positive
      // rotation turns the map counter-clockwise - hence the subtraction.
      _setRotation(_rotate.start - (turned - _rotate.from), e.altKey);
      return;
    }
    if (_stroke) {
      e.preventDefault();
      var at = _pointerCanvas(e);
      _stroke.points.push(_fromCanvas(at[0], at[1], _view));
      _schedulePaint();
      return;
    }
    if (!_pan) return;

    e.preventDefault();
    var now = _pointerCanvas(e);
    var target = _project(_pan.grabbed[0], _pan.grabbed[1], _view.ez);

    // Place the centre so `grabbed` lands under the cursor.
    var dx = now[0] - RENDER_W / 2;
    var dy = now[1] - RENDER_H / 2;
    var r = _view.rotation * DEG;
    var offsetX = dx * Math.cos(r) - dy * Math.sin(r);
    var offsetY = dx * Math.sin(r) + dy * Math.cos(r);

    var centre = _unproject(target[0] - offsetX, target[1] - offsetY, _view.ez);
    _view.lng = centre[0];
    _view.lat = Math.max(-85, Math.min(85, centre[1]));
    _schedulePaint();
  }

  function _onPointerUp() {
    if (_rotate) {
      _rotate = null;
      _maybeRetile();
      return;
    }
    if (_stroke) {
      _stroke = null;
      _syncHistoryButtons();
      return;
    }
    _pan = null;
  }

  function _onWheel(e) {
    if (!_view) return;
    e.preventDefault();

    if (e.shiftKey) {
      _setRotation(_view.rotation - Math.sign(e.deltaY) * 5);
      _queueRetile();
      return;
    }

    var slider = D.role(_dialog, "zoom");
    var next = _view.ez - Math.sign(e.deltaY) * 0.15;
    _view.ez = _desiredEz = Math.max(
      parseFloat(slider.min),
      Math.min(parseFloat(slider.max), next),
    );
    slider.value = _view.ez;
    _schedulePaint();

    // Setting .value in code fires no change event, so the slider's own
    // re-tile hook never runs for wheel input.
    _queueRetile();
  }

  // ERASER HISTORY

  function undo() {
    if (_strokes.length === 0) return;
    _redoStack.push(_strokes.pop());
    _schedulePaint();
    App.history.sync();
  }

  function redo() {
    if (_redoStack.length === 0) return;
    _strokes.push(_redoStack.pop());
    _schedulePaint();
    App.history.sync();
  }

  /**
   * While the print dialog is open, undo belongs to the eraser. The dialog's
   * own Undo/Redo buttons and the toolbar's drive this one stack, so the
   * toolbar cannot quietly rewrite territory geometry behind the dialog.
   */
  var ERASE_SCOPE = {
    id: "erase",
    undo: undo,
    redo: redo,
    canUndo: function () {
      return _strokes.length > 0;
    },
    canRedo: function () {
      return _redoStack.length > 0;
    },
    undoDepth: function () {
      return _strokes.length;
    },
    redoDepth: function () {
      return _redoStack.length;
    },
    undoKey: "toolbar.undoStroke",
    redoKey: "toolbar.redoStroke",
  };

  function _syncHistoryButtons() {
    if (!_dialog) return;
    D.toggleClass(
      D.role(_dialog, "undo"),
      "is-disabled",
      _strokes.length === 0,
    );
    D.toggleClass(
      D.role(_dialog, "redo"),
      "is-disabled",
      _redoStack.length === 0,
    );
  }

  // OUTPUT

  /** Wait for every tile in the current frame, so the export is not patchy. */
  function _awaitTiles() {
    return new Promise(function (resolve) {
      var waited = 0;
      function check() {
        if (!_dialog) return resolve();
        if (_pendingCount(_view) === 0 || waited > 30000) {
          _paint();
          return resolve();
        }
        waited += 120;
        setTimeout(check, 120);
      }
      check();
    });
  }

  /**
   * The two ways a finished card leaves this dialog.
   *
   * Two buttons rather than one whose meaning is decided three fieldsets
   * away: a single button that prints when no template is loaded and
   * downloads when one is cannot save the first card or print the second, and
   * says nothing about which it is about to do.
   *
   * What is composed is the same artefact either way, so composition happens
   * once in _compose() and the action decides only what is done with the blob
   * it resolves - printed, saved, or both, one after the other.
   *
   * @param {"print"|"download"} action
   */
  function _run(action) {
    if (!_view || _busy) return;
    // Captured now rather than read later: Escape closes the dialog even
    // mid-composition, and the teardown nulls _feature before this chain
    // resolves. markPrinted() looks the feature up in the cluster list and
    // shrugs if it has since been cut, merged or deleted.
    var target = _feature;
    var locality = _opts().locality;
    _setBusy(true);

    _compose()
      .then(function (out) {
        _publish(out);
        return action === "print" ? _sendToPrinter(out) : _saveFile(out);
      })
      .then(function () {
        // Only names that reached a card go in the dropdown.
        _rememberLocality(locality);

        // Optimistic, and deliberately so on both paths: the browser's own
        // print dialog is fire-and-forget and a download can be cancelled in
        // the shelf. A territory wrongly marked is one right-click away from
        // being un-marked, while one wrongly left unmarked is a card printed
        // twice.
        App.polygons.markPrinted(target, true);
      })
      .catch(function (err) {
        _setStatus(err.message, false);
      })
      .then(function () {
        if (_dialog) _setBusy(false);
      });
  }

  /**
   * Render the card: a PNG of the map alone, or the PDF it is stamped into.
   *
   * @returns {Promise<{blob: Blob, name: string, pdf: boolean}>}
   */
  function _compose() {
    var o = _opts();
    _setStatus(T("print.waitingTiles"));
    return _awaitTiles()
      .then(function () {
        _setStatus(T("print.encoding"));
        return new Promise(function (resolve) {
          _preview.toBlob(resolve, "image/png");
        });
      })
      .then(function (blob) {
        if (!blob) throw new Error(T("print.errRender"));
        if (!_templateFile)
          return { blob: blob, name: _fileName(o, "png"), pdf: false };
        _setStatus(T("print.buildingPdf"));
        return _composePdf(blob, o).then(function (pdf) {
          return { blob: pdf, name: _fileName(o, "pdf"), pdf: true };
        });
      });
  }

  /**
   * What the card is called on disk, in either format.
   *
   * The timestamp is a fallback for an unnumbered territory only: two cards
   * of number 12 are meant to overwrite each other, two cards of nothing in
   * particular are not.
   */
  function _fileName(o, ext) {
    var name =
      "territory_map" +
      (o.locality ? "-" + o.locality.replace(/\s+/g, "_") : "") +
      (o.territory
        ? "-" + o.territory.replace(/\s+/g, "_")
        : "-" + Math.floor(Date.now() / 1000)) +
      "." +
      ext;

    // make sure name contains only filename-safe characters
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, "_").toLowerCase();
  }

  /**
   * Hand the composed file to the Open button.
   *
   * The URL is not revoked when the action finishes, because both actions
   * give the blob to something that reads it later - a print frame that has
   * not painted yet, or a tab nobody has opened. It is released when the next
   * card replaces it or the dialog closes.
   */
  function _publish(out) {
    _releaseOutput();
    _outUrl = URL.createObjectURL(out.blob);
    if (!_dialog) return;
    var open = D.role(_dialog, "open-file");
    if (!open) return;
    open.href = _outUrl;
    D.toggle(open, true);
  }

  /** Save the card, whatever it turned out to be. */
  function _saveFile(out) {
    var link = document.createElement("a");
    link.href = _outUrl;
    link.download = out.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    _setStatus(T("print.saved", { name: out.name }), false);
  }

  /** Print the card, whatever it turned out to be. */
  function _sendToPrinter(out) {
    var job = out.pdf ? _printPdf(_outUrl) : _printImage(_outUrl);
    return job.then(function (ok) {
      // A refusal is not an error: the file exists and the Open button is
      // already pointing at it. Printing a PDF goes through the browser's own
      // viewer, and not every one of them lets a frame drive it.
      _setStatus(T(ok ? "print.sent" : "print.errPrint"), false);
    });
  }

  /** No template: print the map on its own, sized to the card's map box. */
  function _printImage(url) {
    return _printFrame(function (frame, done) {
      var doc = frame.contentDocument;
      var style = doc.createElement("style");
      style.textContent =
        "@page { size: " +
        PLACEHOLDER.width +
        "pt " +
        PLACEHOLDER.height +
        "pt; margin: 0; }" +
        "html,body{margin:0;padding:0;}" +
        "img{display:block;width:100%;height:100%;object-fit:contain;}";
      doc.head.appendChild(style);

      var img = doc.createElement("img");
      img.onload = function () {
        done(_askFrameToPrint(frame));
      };
      img.onerror = function () {
        done(false);
      };
      img.src = url;
      doc.body.appendChild(img);
    });
  }

  /** Template supplied: hand the composed PDF to the browser's own viewer. */
  function _printPdf(url) {
    return _printFrame(function (frame, done) {
      frame.onload = function () {
        // load fires when the document has arrived, not when the viewer has
        // laid it out, and asking too early prints a blank sheet in more
        // than one browser.
        setTimeout(function () {
          done(_askFrameToPrint(frame));
        }, 400);
      };
      frame.onerror = function () {
        done(false);
      };
      frame.src = url;
    });
  }

  /**
   * A hidden frame that outlives the call.
   *
   * It cannot be removed when print() returns: the print dialog reads the
   * document while it is up, and in the browsers whose dialog does not block
   * the script, tearing the frame down straight away prints nothing at all.
   * A minute is longer than anyone spends choosing a printer and short enough
   * that a session does not collect frames.
   *
   * @param {function(HTMLIFrameElement, function(boolean)): void} fill
   * @returns {Promise<boolean>} whether the browser accepted the job
   */
  function _printFrame(fill) {
    return new Promise(function (resolve) {
      var frame = document.createElement("iframe");
      frame.style.cssText =
        "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
      document.body.appendChild(frame);

      var settled = false;
      // Nothing about a viewer that never loads is worth waiting on forever.
      // The file exists either way, and the Open button says where it is.
      var giveUp = setTimeout(function () {
        done(false);
      }, 15000);
      setTimeout(function () {
        frame.remove();
      }, 60000);

      function done(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        resolve(ok);
      }

      try {
        fill(frame, done);
      } catch (e) {
        console.warn(">>> The print frame could not be filled:", e.message);
        done(false);
      }
    });
  }

  /** Drive the frame's own print, reporting whether it could be driven. */
  function _askFrameToPrint(frame) {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
      return true;
    } catch (e) {
      console.warn(">>> The print frame refused:", e.message);
      return false;
    }
  }

  /**
   * Template supplied: stamp the map into the placeholder.
   *
   * Composed in the browser, which is what lets a card be printed with no
   * network at all. There is no server route behind it - see pdfdoc.js - so
   * a failure here is reported rather than retried elsewhere.
   *
   * @returns {Promise<Blob>}
   */
  function _composePdf(blob, o) {
    var spec = {
      template: _templateFile,
      image: blob,
      // page lives on the layout, not the placeholder: PLACEHOLDER carries no
      // page, so reading it here would hand pdfdoc.js an undefined page number.
      page: _layout.page || 0,
      box: {
        x: PLACEHOLDER.x,
        y: PLACEHOLDER.y,
        width: PLACEHOLDER.width,
        height: PLACEHOLDER.height,
      },
      fields: [],
      project: null,
    };

    ["locality", "territory"].forEach(function (name) {
      if (!o[name] || !FIELDS[name]) return;
      spec.fields.push({
        name: name,
        text: o[name],
        x: FIELDS[name].x,
        y: FIELDS[name].y,
        size: FIELDS[name].size,
      });
    });

    // The card carries the project it came from, so the printed sheet is also
    // the backup. See App.data.buildAttachmentPayload for what is left out and
    // why - the short version is everything that can be downloaded again.
    if (o.attach) {
      try {
        spec.project = App.data.buildAttachmentPayload();
      } catch (e) {
        // A card that prints without its backup beats no card at all.
        console.warn(">>> Could not attach the project state:", e.message);
      }
    }

    return App.pdfdoc.compose(spec).catch(function (err) {
      console.error(">>> PDF composition failed:", err);
      // Rethrown with the specific wording rather than reported and
      // swallowed: _run's handler writes whatever message reaches it, and
      // "could not build the PDF" is more use than "could not render".
      throw new Error(T("print.errPdf", { message: err.message }));
    });
  }

  function _releaseOutput() {
    if (_outUrl) {
      URL.revokeObjectURL(_outUrl);
      _outUrl = null;
    }
  }

  return {
    init: init,
    isOpen: isOpen,
    setBasemapOverlay: setBasemapOverlay,
    printCluster: printCluster,
    close: close,
    undo: undo,
    redo: redo,
    // The two halves of the card furniture that can be wrong without looking
    // wrong. Everything else about a scale bar or a compass is visible at a
    // glance; a bar under the wrong number and a needle off by a sign are
    // not, and a card is read away from the screen that drew it.
    scaleFor: scaleFor,
    compassVector: compassVector,
    layout: function () {
      // A getter, not a reference: PLACEHOLDER and FIELDS are reassigned
      // whenever a template loads, so an exported object would go stale.
      return _layout;
    },
  };
})();

window.App = App;
