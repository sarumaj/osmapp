/**
 * print.js — territory card printing.
 *
 * Rather than screenshotting the live Leaflet map, this renders a fresh map
 * onto a canvas: basemap tiles, then this cluster's border, and nothing else.
 * That guarantees no buildings, no streets and no neighboring borders, and it
 * decouples output resolution from the screen, so the card prints at 300 dpi
 * regardless of window size.
 *
 * Tiles
 *   One tile zoom is chosen when the dialog opens and never changes. Every
 *   tile is kept as a decoded Image in _tiles for the life of the dialog, so
 *   panning, zooming and rotating re-composite from memory with no network at
 *   all. The previous version re-fetched a whole tile set on every adjustment,
 *   which is what made it slow.
 *
 *   The cost is sharpness when zooming past the chosen level, since tiles are
 *   then upscaled. TILE_ZOOM_BOOST trades that against the initial fetch:
 *   raising it by 1 keeps detail one zoom level further in and costs about
 *   four times the tiles.
 *
 * Framing
 *   The canvas is fixed at the template placeholder's aspect ratio, so the
 *   ratio cannot drift. Framing chooses which slice of the world lands on it:
 *   drag to pan, scroll or the slider to zoom, and the two buttons to rotate
 *   in 90 degree steps. The frame never turns — the map turns inside it.
 *
 * Erase strokes are stored in lng/lat with a width in metres, not canvas
 * pixels, so they stay pinned to the street name they were drawn over when the
 * frame is panned, zoomed or rotated afterwards.
 */
var App = window.App || {};

App.print = (function () {
  ("use strict");

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  // ── Output geometry, measured from the S-12 card ──────────────────────
  // A4 portrait, 595.32 x 841.92 pt. The map box runs from (22.7, 470.3) to
  // (572.6, 752.8) in PDF points, origin bottom-left.
  var PAGE = { width: 595.32, height: 841.92 };
  var PLACEHOLDER = { x: 22.7, y: 470.3, width: 549.9, height: 282.5, page: 0 };
  var FIELDS = {
    locality: { x: 98, y: 767, size: 10 },
    territory: { x: 351, y: 767, size: 10 },
  };

  var DPI = 300;
  var PT_PER_INCH = 72;
  var RENDER_W = Math.round((PLACEHOLDER.width / PT_PER_INCH) * DPI); // 2291
  var RENDER_H = Math.round((PLACEHOLDER.height / PT_PER_INCH) * DPI); // 1177
  var PX_PER_PT = DPI / PT_PER_INCH;
  var DEG = Math.PI / 180;

  var TILE_URL = "/tiles/{z}/{x}/{y}.png";
  var TILE_SIZE = 256;
  var TILE_CONCURRENCY = 8;
  var TILE_ZOOM_BOOST = 0; // +1 = sharper when zoomed in, ~4x the tiles
  var TILE_MARGIN = 2; // rings of tiles prefetched around the opening view
  var MAX_TILES = 900;

  var MIN_ZOOM = 3;
  var MAX_ZOOM = 19;
  var ZOOM_OUT_HEADROOM = 0.5; // how far below fit the slider reaches
  var ZOOM_IN_HEADROOM = 2;
  var PADDING = 0.05; // fraction of the frame kept clear when fitting
  var ROTATION_STEP = 90;
  var EARTH_CIRCUMFERENCE_M = 40075016.686;
  var ATTRIBUTION = "© OpenStreetMap contributors";

  // ── Session state ─────────────────────────────────────────────────────
  var _dialog = null;
  var _feature = null;
  var _preview = null;
  var _borderCanvas = null;

  var _view = null; // { ez, lng, lat, rotation } — rotation is 0/90/180/270
  var _tiles = null; // "x/y" -> { img, done }
  var _tileZoom = 0;
  var _inFlight = 0;
  var _paintQueued = false;

  var _strokes = [];
  var _redoStack = [];
  var _stroke = null;
  var _pan = null;

  var _templateFile = null;
  var _pdfUrl = null;

  function init() {
    s = App.state;
    G = App.geometry;
    D = App.dom;
    T = App.i18n.t;
  }

  function isOpen() {
    return _dialog !== null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREFERENCES
  // ══════════════════════════════════════════════════════════════════════

  var PREFERENCES_KEY = "osm.print.prefs.v1";
  var PREFERENCES_ROLES = [
    "color",
    "width",
    "opacity",
    "erase-size",
    "locality",
  ];

  function _loadPrefs() {
    var saved;
    try {
      saved = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) || "{}");
    } catch (e) {
      return; // corrupt or storage disabled — fall back to the markup defaults
    }
    PREFERENCES_ROLES.forEach(function (role) {
      if (saved[role] === undefined) return;
      var input = D.role(_dialog, role);
      if (input) input.value = saved[role]; // range inputs clamp, color ignores junk
    });
  }

  function _savePrefs() {
    var out = {};
    PREFERENCES_ROLES.forEach(function (role) {
      var input = D.role(_dialog, role);
      if (input) out[role] = input.value;
    });
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(out));
    } catch (e) {
      /* private mode: preferences just don't persist */
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // TEMPLATE FILE
  // ══════════════════════════════════════════════════════════════════════

  var TEMPLATE_KEY = "print:template";
  var _templateReady = false;

  function _restoreTemplate() {
    return App.store.get(TEMPLATE_KEY).then(function (file) {
      _templateReady = true;
      if (!file || !_dialog) return;
      _templateFile = file;
      D.text(
        _dialog,
        "template-name",
        T("print.withTemplate", { name: file.name }),
      );
      D.toggle(D.role(_dialog, "clear-template"), true);
    });
  }

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
    return file
      ? App.store.set(TEMPLATE_KEY, file)
      : App.store.remove(TEMPLATE_KEY);
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

    _withMapTransform(ctx, _view, function () {
      result.jobs.forEach(function (job) {
        var entry = _tile(job.x, job.y);
        if (entry.img) {
          // Half a pixel of overlap; rotation and fractional scaling put tile
          // edges off the pixel grid, and the seams show otherwise.
          ctx.drawImage(
            entry.img,
            job.wx,
            job.wy,
            result.tilePx + 0.5,
            result.tilePx + 0.5,
          );
        } else if (!entry.done) {
          missing++;
        }
      });
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

  var _busy = false;

  function _setBusy(busy) {
    _busy = busy;
    D.toggleClass(D.role(_dialog, "print"), "is-disabled", busy);
    D.toggleClass(D.role(_dialog, "cancel"), "is-disabled", busy);
    _preview.classList.toggle("is-busy", busy);
  }

  function printCluster(feature) {
    if (!feature || !feature.geometry) {
      alert(T("print.errNoGeometry"));
      return;
    }

    _feature = feature;
    _strokes = [];
    _redoStack = [];
    _stroke = null;
    _pan = null;
    _templateFile = null;
    _tiles = new Map();
    _inFlight = 0;

    _releasePdf();

    function _teardown() {
      _releasePdf();
      _dialog = null;
      _feature = null;
      _preview = _borderCanvas = null;
      _view = null;
      _tiles = null;
      _strokes = [];
      _redoStack = [];
    }

    _dialog = App.ui.openDialog("tpl-print-dialog", _teardown);
    _preview = D.role(_dialog, "canvas");
    _preview.width = RENDER_W;
    _preview.height = RENDER_H;
    _borderCanvas = document.createElement("canvas");
    _borderCanvas.width = RENDER_W;
    _borderCanvas.height = RENDER_H;

    _view = _fitViewFor(feature, 0);

    // Fixed for the life of the dialog: every later view re-composites from
    // these tiles instead of fetching a new set.
    _tileZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.ceil(_view.ez) + TILE_ZOOM_BOOST),
    );

    _wireControls();
    _loadPrefs();
    _restoreTemplate();
    _syncFrameControls();
    _setStatus(T("print.loadingTiles"));
    _prefetch(_view);
    _paint();
  }

  function close() {
    if (!_dialog) return;
    App.ui.closeDialog();
  }

  function _wireControls() {
    ["color", "width", "opacity"].forEach(function (role) {
      D.role(_dialog, role).addEventListener("input", function () {
        _syncOutputs();
        _savePrefs();
        _schedulePaint();
      });
    });
    D.role(_dialog, "erase-size").addEventListener("input", function () {
      _syncOutputs();
      _savePrefs();
    });
    D.role(_dialog, "locality").addEventListener("change", _savePrefs);
    D.role(_dialog, "erase").addEventListener("change", _syncEraseMode);
    D.role(_dialog, "zoom").addEventListener("input", function (e) {
      _view.ez = parseFloat(e.target.value);
      _schedulePaint();
    });

    D.onRole(_dialog, "rotate-ccw", function () {
      _setRotation(_view.rotation + ROTATION_STEP);
    });
    D.onRole(_dialog, "rotate-cw", function () {
      _setRotation(_view.rotation - ROTATION_STEP);
    });

    D.onRole(_dialog, "fit", function () {
      // Refit at the current rotation rather than resetting it: after turning
      // the map you usually want the same angle, tightened.
      _view = _fitViewFor(_feature, _view.rotation);
      _syncFrameControls();
      _schedulePaint();
    });

    D.role(_dialog, "template").addEventListener("change", function (e) {
      _templateFile = e.target.files[0] || null;
      _setTemplate(_templateFile);
      D.text(
        _dialog,
        "template-name",
        _templateFile
          ? T("print.withTemplate", { name: _templateFile.name })
          : T("print.noTemplate"),
      );
    });
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

    _preview.addEventListener("pointerdown", _onPointerDown);
    _preview.addEventListener("pointermove", _onPointerMove);
    _preview.addEventListener("pointerup", _onPointerUp);
    _preview.addEventListener("pointercancel", _onPointerUp);
    _preview.addEventListener("wheel", _onWheel, { passive: false });

    _syncOutputs();
    _syncEraseMode();
  }

  /** Rotation is quarter turns only, so it always lands on 0/90/180/270. */
  function _setRotation(degrees) {
    var steps = Math.round(degrees / ROTATION_STEP);
    _view.rotation = (((steps * ROTATION_STEP) % 360) + 360) % 360;
    _syncFrameControls();
    _schedulePaint();
  }

  function _syncFrameControls() {
    var zoom = D.role(_dialog, "zoom");
    var fit = _fitViewFor(_feature, _view.rotation);
    zoom.min = Math.max(MIN_ZOOM, fit.ez - ZOOM_OUT_HEADROOM).toFixed(2);
    zoom.max = Math.min(MAX_ZOOM, fit.ez + ZOOM_IN_HEADROOM).toFixed(2);
    zoom.step = "0.05";
    zoom.value = Math.max(
      parseFloat(zoom.min),
      Math.min(parseFloat(zoom.max), _view.ez),
    );
    _view.ez = parseFloat(zoom.value);
    _syncOutputs();
  }

  function _syncOutputs() {
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
      T("print.unitDeg", { value: _view ? _view.rotation : 0 }),
    );
  }

  function _syncEraseMode() {
    var erasing = D.role(_dialog, "erase").checked;
    _preview.classList.toggle("is-erasing", erasing);
    _preview.classList.toggle("is-panning", !erasing);
    _syncOutputs();
  }

  function _setStatus(text) {
    if (!_dialog) return;
    D.text(_dialog, "status", text);
    D.toggle(D.role(_dialog, "status"), !!text);
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

  function _onPointerDown(e) {
    if (!_view) return;
    e.preventDefault();
    _preview.setPointerCapture(e.pointerId);
    var at = _pointerCanvas(e);

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
    var slider = D.role(_dialog, "zoom");
    var next = _view.ez - Math.sign(e.deltaY) * 0.15;
    _view.ez = Math.max(
      parseFloat(slider.min),
      Math.min(parseFloat(slider.max), next),
    );
    slider.value = _view.ez;
    _schedulePaint();
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
        _setStatus(err.message);
      })
      .then(function () {
        _setBusy(false);
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
    form.append("page", String(PLACEHOLDER.page));
    form.append("x", String(PLACEHOLDER.x));
    form.append("y", String(PLACEHOLDER.y));
    form.append("width", String(PLACEHOLDER.width));
    form.append("height", String(PLACEHOLDER.height));
    if (o.locality) {
      form.append("locality", o.locality);
      form.append("locality_x", String(FIELDS.locality.x));
      form.append("locality_y", String(FIELDS.locality.y));
    }
    if (o.territory) {
      form.append("territory", o.territory);
      form.append("territory_x", String(FIELDS.territory.x));
      form.append("territory_y", String(FIELDS.territory.y));
    }

    fetch("/compose_pdf", { method: "POST", body: form })
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
            : `-${Math.floor(Date.now() / 1000)}`) +
          ".pdf";

        var link = document.createElement("a");
        link.href = _pdfUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();

        var open = D.role(_dialog, "open-pdf");
        open.href = _pdfUrl;
        D.toggle(open, true);

        // Browsers block window.open once the click gesture has expired, so
        // the file is downloaded and the Open button waits for a real click.
        _setStatus(T("print.saved", { name: name }));
      })
      .catch(function (err) {
        console.error(">>> PDF composition failed:", err);
        _setStatus(T("print.errPdf", { message: err.message }));
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
    PLACEHOLDER: PLACEHOLDER,
    PAGE: PAGE,
  };
})();

window.App = App;
