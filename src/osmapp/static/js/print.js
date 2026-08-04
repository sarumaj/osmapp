/**
 * print.js — territory card printing.
 *
 * Rather than screenshotting the live Leaflet map, this renders a fresh map
 * onto a canvas: basemap tiles, then this cluster's border, and nothing else.
 * That guarantees no buildings, no streets and no neighboring borders, and it
 * decouples output resolution from the screen, so the card prints at 300 dpi
 * regardless of window size.
 *
 * Layout
 *   Where the map goes on the card is measured from the template, not
 *   hardcoded. /inspect_template finds the placeholder rectangle and the field
 *   anchors; the placement dialog lets that guess be corrected by hand; the
 *   result is remembered per template, keyed on a hash of its bytes. The
 *   canvas takes its aspect ratio from the resolved placeholder, so editing
 *   the card can no longer silently letterbox the map.
 *
 * Tiles
 *   Tiles are fetched below the display zoom and upscaled, so the basemap is
 *   deliberately soft. OSM sets label text at ~11 px for a ~96 dpi screen; at
 *   300 dpi that prints as a 2.6 pt street name. TILE_DPI controls the trade:
 *   lower means larger, more readable labels on a softer map. The result is
 *   quantized — tiles exist only at integer zooms — so the label size ladder
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
 *   never turns — the map turns inside it.
 *
 * Erase strokes are stored in lng/lat with a width in metres, not canvas
 * pixels, so they stay pinned to the street name they were drawn over when the
 * frame is panned, zoomed or rotated afterwards.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.print = (function () {
  ("use strict");

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  // ── Output geometry ───────────────────────────────────────────────────
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
   * would otherwise never reach anyone who had already loaded that template —
   * the cached numbers pin the old behavior forever. Layouts positioned by
   * hand carry source "manual" and survive the bump: a box someone aligned
   * against a loupe is better evidence than anything detection produces.
   */
  var LAYOUT_VERSION = 2;

  var _layout = DEFAULT_LAYOUT;
  var _layoutId = null;
  var _candidates = [];

  // Reassigned by _applyLayout — never captured by reference outside it.
  var PLACEHOLDER = _layout.placeholder;
  var FIELDS = _layout.fields;

  var DPI = 300;
  var PT_PER_INCH = 72;
  var PX_PER_PT = DPI / PT_PER_INCH;
  var RENDER_W = Math.round((PLACEHOLDER.width / PT_PER_INCH) * DPI);
  var RENDER_H = Math.round((PLACEHOLDER.height / PT_PER_INCH) * DPI);

  var DEG = Math.PI / 180;

  var TILE_URL = "/tiles/{z}/{x}/{y}.png";
  var TILE_SIZE = 256;
  var TILE_CONCURRENCY = 8;
  var TILE_MARGIN = 2; // rings of tiles prefetched around the opening view
  var MAX_TILES = 900;

   /**
   * How many zoom levels below the display zoom the tiles are fetched from.
   *
   * This is the only knob that exists. Tiles are published at integer zooms
   * only, so label size is quantized: each step doubles it. A continuous
   * control here was a lie — most of its range mapped to the same integer and
   * did nothing, and the positions that did change jumped by a factor of two.
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

  // ── Session state ─────────────────────────────────────────────────────
  var _dialog = null;
  var _feature = null;
  var _preview = null;
  var _borderCanvas = null;
  var _eraseCursor = null;
  var _eraseRO = null;

  var _view = null; // { ez, lng, lat, rotation } — rotation in (-180, 180]
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
  var _pdfUrl = null;
  var _busy = false;

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

  // ══════════════════════════════════════════════════════════════════════
  // PREFERENCES
  // ══════════════════════════════════════════════════════════════════════

  var PREFERENCES_KEY = "osm.print.preferences.v1";
  var PREFERENCES_ROLES = [
    "color",
    "width",
    "opacity",
    "detail",
    "sharpen",
    "contrast",
    "grayscale",
    "erase-size",
    "locality",
  ];

  function _readPreferences() {
    try {
      return JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}");
    } catch (e) {
      return {}; // corrupt or storage disabled
    }
  }

  function _writePreferences(preferences) {
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch (e) {
      /* private mode: preferences just don't persist */
    }
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

  // ══════════════════════════════════════════════════════════════════════
  // LAYOUT
  // ══════════════════════════════════════════════════════════════════════

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

    _view = _fitViewFor(_feature, _view ? _view.rotation : 0);
    _desiredEz = _view.ez;

    _syncFrameControls();
    _sizeEraseCursor();
    _retile();
  }

  // ══════════════════════════════════════════════════════════════════════
  // TEMPLATE FILE
  // ══════════════════════════════════════════════════════════════════════

  var TEMPLATE_KEY = "print:template";

  /**
   * Stable id for a template file. Survives renaming and re-export; changes
   * when the template is actually edited, which is exactly when a saved map
   * box becomes suspect.
   */
  function _templateId(file) {
    if (!window.crypto || !crypto.subtle) {
      // Insecure context — crypto.subtle is undefined on http://0.0.0.0:5000.
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
    var form = new FormData();
    form.append("template", file);
    return fetch("/inspect_template", { method: "POST", body: form }).then(
      function (r) {
        if (!r.ok) throw new Error("inspect_template returned " + r.status);
        return r.json();
      },
    );
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

      if (_layoutIsCurrent(stored.layout)) {
        _layoutId = stored.id || null;
        _applyLayout(stored.layout);
        return;
      }
      return _resolveLayout(file);
    });
  }

  /** Owns the template label — callers must not write it themselves. */
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

    if (!file) {
      _layoutId = null;
      _applyLayout(DEFAULT_LAYOUT);
      return App.store.remove(TEMPLATE_KEY);
    }
    return _resolveLayout(file);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PLACEMENT — drag the map box onto a render of the template
  //
  // Ordered dependency-first: constants, feedback, coordinate mapping, the
  // loupe, input handling, then open/show/save/close at the end.
  // ══════════════════════════════════════════════════════════════════════

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
   * — silence is indistinguishable from a broken button.
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

  /** PDF points → screen px. PDF y grows upward from the bottom-left. */
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
   * misalignment — which is visible on the printed card — cannot be seen on
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
   * closest to it instead — that is the one being adjusted.
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
    _placeDialog = D.remove(_placeDialog);
    _place = null;
  }

  function _openPlacement() {
    if (_placeDialog) return; // already open — self-evident, no notice needed
    if (!_templateFile) {
      _setStatus(T("print.errNoTemplate"), false);
      return;
    }

    var form = new FormData();
    form.append("template", _templateFile);
    form.append("page", String(_layout.page || 0));

    _setStatus(T("print.renderingTemplate"));
    fetch("/template_preview", { method: "POST", body: form })
      .then(function (r) {
        if (!r.ok) throw new Error("template_preview returned " + r.status);
        return r.blob();
      })
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
    // Mounted directly, not through App.ui.openDialog — that closes whatever
    // dialog is already on screen, and the print dialog has to stay underneath.
    _placeDialog = D.mountOnMap("tpl-place-dialog", s.leafletMap);
    App.i18n.apply(_placeDialog);

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

    function rescale() {
      if (!_place) return;
      // clientWidth is 0 until the image has been laid out, which is a frame
      // after load — a zero scale would put the box at infinity.
      var shown = img.clientWidth || img.naturalWidth || _layout.pageWidth;
      _place.scale = shown / _layout.pageWidth;
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

    var stage = D.role(_placeDialog, "stage");
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
    _placeDialog.focus();
  }

  // ══════════════════════════════════════════════════════════════════════
  // PROJECTION
  // ══════════════════════════════════════════════════════════════════════

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
   * World pixels → canvas pixels, about the frame centre. A positive rotation
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

  function _metresPerPixel(view) {
    return (
      (EARTH_CIRCUMFERENCE_M * Math.cos(view.lat * DEG)) /
      (TILE_SIZE * Math.pow(2, view.ez))
    );
  }

  /** Apply the world→canvas transform, then run fn to draw in world pixels. */
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

  // ══════════════════════════════════════════════════════════════════════
  // TILE CACHE
  // ══════════════════════════════════════════════════════════════════════

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
   * the display zoom is fractional while the tile zoom is not — the same
   * offset gives a label anywhere within a factor of root-two as you move the
   * zoom slider. Showing the computed value keeps the readout honest.
   */
  function _labelPt(ez, tileZoom) {
    return (
      ((TILE_LABEL_PX * PT_PER_INCH) / DPI) * Math.pow(2, ez - tileZoom)
    );
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
   * Compares the zoom in use against the one the current view wants — not the
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
    img.src = TILE_URL.replace("{z}", _tileZoom)
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

  // ══════════════════════════════════════════════════════════════════════
  // ERASE CURSOR
  // ══════════════════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════════════════
  // PAINT
  // ══════════════════════════════════════════════════════════════════════

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

    var sharpen = D.role(_dialog, "sharpen");
    var contrast = D.role(_dialog, "contrast");
    var grayscale = D.role(_dialog, "grayscale");
    var wantSharp = (!sharpen || sharpen.checked) && "filter" in ctx;
    var wantContrast = contrast && contrast.checked && "filter" in ctx;
    var wantGrayscale = grayscale && grayscale.checked && "filter" in ctx;

    // Upright frames keep tile edges on the pixel grid, so they need almost no
    // overlap; a rotated or fractionally scaled frame does, or seams show.
    var upright = Math.abs(_wrap180(_view.rotation) % 90) < 0.01;
    var bleed = upright ? 0.05 : 0.5;

    _withMapTransform(ctx, _view, function () {
      // Applied to the basemap only. The border and attribution are drawn as
      // vectors at full canvas resolution and are already sharp — running them
      // through the same filter would just add halos.
      var filters = [];
      if (wantSharp) filters.push("url(#tile-sharpen)");
      if (wantContrast) filters.push("url(#tile-contrast)");
      if (wantGrayscale) filters.push("url(#tile-grayscale)");
      ctx.filter = filters.length ? filters.join(" ") : "none";

      result.jobs.forEach(function (job) {
        var entry = _tile(job.x, job.y);
        if (entry.img) {
          ctx.drawImage(
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

      // ctx.restore() in _withMapTransform resets filter — this is just belt-and-suspenders.
      if (wantSharp || wantGrayscale || wantContrast) ctx.filter = "none";
    });

    _drawAttribution(ctx);
    _drawBorder();

    ctx.save();
    ctx.globalAlpha = _opts().opacity;
    ctx.drawImage(_borderCanvas, 0, 0);
    ctx.restore();

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

    // Erased spans punch through the border only — the map beneath is intact.
    var mpp = _metresPerPixel(_view);
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

  // ══════════════════════════════════════════════════════════════════════
  // DIALOG
  // ══════════════════════════════════════════════════════════════════════

  function _setBusy(busy) {
    _busy = busy;
    D.toggleClass(D.role(_dialog, "print"), "is-disabled", busy);
    D.toggleClass(D.role(_dialog, "cancel"), "is-disabled", busy);
    _preview.classList.toggle("is-busy", busy);
  }

  function _teardown() {
    _closePlacement();
    _releasePdf();
    if (_eraseRO) {
      _eraseRO.disconnect();
      _eraseRO = null;
    }
    if (_retileTimer) {
      clearTimeout(_retileTimer);
      _retileTimer = null;
    }
    _dialog = null;
    _feature = null;
    _eraseCursor = null;
    _preview = _borderCanvas = null;
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
    // module state — so nothing may be assigned before this line.
    _dialog = App.ui.openDialog("tpl-print-dialog", _teardown);

    _feature = feature;
    _strokes = [];
    _redoStack = [];
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

    _wireControls();
    _loadPreferences();

    // Sizes both canvases, fits the view, picks the tile zoom and starts the
    // prefetch — everything downstream of the frame's aspect ratio.
    _applyLayout(DEFAULT_LAYOUT);

    // May replace the layout a moment later, which redoes all of the above.
    _restoreTemplate();
  }

  function close() {
    if (!_dialog) return;
    App.ui.closeDialog();
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
      // snapping keyboard input pulled each press straight back and left the
      // control looking dead.
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
    D.onRole(_dialog, "print", _print);
    // The href is rewritten per composition, but clearing the saved-message is
    // a one-time binding — the link's own navigation still happens.
    D.onRole(_dialog, "open-pdf", function () {
      _setStatus("");
    });

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
    // dialog is resized — the ring has to be resized with it.
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
   * want are almost always round — square to a street grid, or a quarter turn.
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

    // Previews the slider's current position, which may not be applied yet —
    // the refetch waits for change, the readout follows input.
    var z = _tileZoomForOffset(_view.ez, _detailOffset());
    D.text(
      _dialog,
      "detail-out",
      T("print.detailOut", { pt: _labelPt(_view.ez, z).toFixed(1), z: z }),
    );
    // Below TILE_ZOOM_WARN, OSM stops naming minor roads — going softer
    // deletes the labels rather than enlarging them.
    D.toggleClass(
      D.role(_dialog, "detail-out"),
      "is-warn",
      z < TILE_ZOOM_WARN,
    );
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

  function _opts() {
    return {
      color: D.role(_dialog, "color").value,
      widthPt: parseFloat(D.role(_dialog, "width").value),
      opacity: parseFloat(D.role(_dialog, "opacity").value) / 100,
      eraseSizePt: parseFloat(D.role(_dialog, "erase-size").value),
      erasing: D.role(_dialog, "erase").checked,
      locality: D.role(_dialog, "locality").value.trim(),
      territory: D.role(_dialog, "territory").value.trim(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // POINTER — erase or pan, depending on the mode
  // ══════════════════════════════════════════════════════════════════════

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
        sizeM: sizePx * _metresPerPixel(_view),
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
      // rotation turns the map counter-clockwise — hence the subtraction.
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

  // ══════════════════════════════════════════════════════════════════════
  // ERASER HISTORY
  // ══════════════════════════════════════════════════════════════════════

  function undo() {
    if (_strokes.length === 0) return;
    _redoStack.push(_strokes.pop());
    _schedulePaint();
  }

  function redo() {
    if (_redoStack.length === 0) return;
    _strokes.push(_redoStack.pop());
    _schedulePaint();
  }

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

  // ══════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ══════════════════════════════════════════════════════════════════════

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

  function _print() {
    if (!_view || _busy) return;
    _setBusy(true);

    _setStatus(T("print.waitingTiles"));
    _awaitTiles()
      .then(function () {
        _setStatus(T("print.encoding"));
        return new Promise(function (resolve) {
          _preview.toBlob(resolve, "image/png");
        });
      })
      .then(function (blob) {
        if (!blob) throw new Error(T("print.errRender"));
        if (!_templateFile) return _printImage(blob);
        _setStatus(T("print.buildingPdf"));
        return _composePdf(blob);
      })
      .catch(function (err) {
        _setStatus(err.message, false);
      })
      .then(function () {
        if (_dialog) _setBusy(false);
      });
  }

  /** No template: print the map on its own, sized to the card's map box. */
  function _printImage(blob) {
    var url = URL.createObjectURL(blob);
    var frame = document.createElement("iframe");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(frame);

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
      frame.contentWindow.focus();
      frame.contentWindow.print();
      _setStatus("");
      setTimeout(function () {
        URL.revokeObjectURL(url);
        frame.remove();
      }, 60000);
    };
    img.src = url;
    doc.body.appendChild(img);
  }

  /** Template supplied: stamp the map into the placeholder server-side. */
  function _composePdf(blob) {
    var o = _opts();
    var form = new FormData();

    form.append("template", _templateFile);
    form.append("image", blob, "territory.png");
    // page lives on the layout, not the placeholder — sending PLACEHOLDER.page
    // posted the string "undefined" and the server rejected the whole request.
    form.append("page", String(_layout.page || 0));
    form.append("x", String(PLACEHOLDER.x));
    form.append("y", String(PLACEHOLDER.y));
    form.append("width", String(PLACEHOLDER.width));
    form.append("height", String(PLACEHOLDER.height));

    if (o.locality) {
      form.append("locality", o.locality);
      form.append("locality_x", String(FIELDS.locality.x));
      form.append("locality_y", String(FIELDS.locality.y));
      form.append("locality_size", String(FIELDS.locality.size));
    }
    if (o.territory) {
      form.append("territory", o.territory);
      form.append("territory_x", String(FIELDS.territory.x));
      form.append("territory_y", String(FIELDS.territory.y));
      form.append("territory_size", String(FIELDS.territory.size));
    }

    return fetch("/compose_pdf", { method: "POST", body: form })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(
            function (data) {
              throw new Error(data.error || "Server returned " + r.status);
            },
            function () {
              throw new Error("Server returned " + r.status);
            },
          );
        }
        return r.blob();
      })
      .then(function (pdf) {
        _releasePdf();
        _pdfUrl = URL.createObjectURL(pdf);

        var name =
          "territory_map" +
          (o.territory
            ? "-" + o.territory.replace(/\s+/g, "_")
            : "-" + Math.floor(Date.now() / 1000)) +
          ".pdf";

        var link = document.createElement("a");
        link.href = _pdfUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();

        if (_dialog) {
          var open = D.role(_dialog, "open-pdf");
          open.href = _pdfUrl;
          D.toggle(open, true);
          // Browsers block window.open once the click gesture has expired, so
          // the file is downloaded and the Open button waits for a real click.
          _setStatus(T("print.saved", { name: name }), false);
        }
      })
      .catch(function (err) {
        console.error(">>> PDF composition failed:", err);
        _setStatus(T("print.errPdf", { message: err.message }), false);
      });
  }

  function _releasePdf() {
    if (_pdfUrl) {
      URL.revokeObjectURL(_pdfUrl);
      _pdfUrl = null;
    }
  }

  return {
    init: init,
    isOpen: isOpen,
    printCluster: printCluster,
    close: close,
    undo: undo,
    redo: redo,
    layout: function () {
      // A getter, not a reference: PLACEHOLDER and FIELDS are reassigned
      // whenever a template loads, so an exported object would go stale.
      return _layout;
    },
  };
})();

window.App = App;
