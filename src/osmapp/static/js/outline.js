/**
 * outline.js - reshape the outer boundary after it has been set.
 *
 * Moving one corner of a boundary otherwise means redrawing the whole thing
 * and re-downloading the OSM data behind it.
 *
 * Vertices are Leaflet.Editable's job
 *
 * The library already draws the boundary in the first place, and its
 * PathEditor gives all three gestures: drag a vertex to move it, click a
 * vertex to delete it, drag a middle marker to add one. The trim tool's own
 * hand-editing is not reused here because it edits a *proposal* that has to
 * stay inside the working boundary and be recomputed against a raster; here
 * the layer is an ordinary Leaflet polygon.
 *
 * MIN_VERTEX is 3 for a polygon editor, so the library declines to delete the
 * vertex that would leave a line rather than a shape.
 *
 * What makes this different from trim
 *
 * Trimming can only shrink, so it never invalidates the download. This can
 * grow, which means the streets and buildings inside the new outline may
 * never have been fetched - the map would look correct and be missing data.
 * So growing past what was downloaded offers a refetch on the way out, rather
 * than leaving a whole street to turn up absent from a printed card.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.outline = (function () {
  "use strict";

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  var _layer = null; // the boundary being edited, in place
  var _original = null; // its geometry when the tool opened, for Reset
  var _toolbar = null;
  var _hint = null;

  // Ring snapshots, newest last. A vertex moved, added or deleted is one
  // step; the editor gives an event for each, which is exactly the grain
  // somebody expects Ctrl+Z to work at.
  var _undo = [];
  var _redo = [];
  var MAX = 60;

  function init() {
    s = App.state;
    G = App.geometry;
    D = App.dom;
    T = App.i18n.t;
    App._loaded.push("outline");
  }

  function isActive() {
    return !!s.outlineMode;
  }

  // MODE

  /**
   * Enter or leave boundary reshaping.
   *
   * Entering closes whichever other modal tool holds the map and edits the
   * existing outer layer in place; leaving tears the editor down but does not
   * put the shape back - cancel() does that, apply() commits it.
   */
  function toggle() {
    var next = !s.outlineMode;

    if (next) {
      if (!s.outerPolygonLayer) {
        alert(T("outline.noBoundary"));
        return;
      }
      // The modal tools are mutually exclusive, and every one of them says so
      // in its own toggle. Reshaping the boundary underneath a half-drawn cut
      // line would leave the line anchored to edges that no longer exist.
      if (s.editMode) App.editing.toggleEditMode();
      if (s.mergeMode) App.editing.toggleMergeMode();
      if (s.trimMode) App.trim.toggle();
      if (s.noteMode) App.notes.toggle();
      if (s.leafletMap.editTools) s.leafletMap.editTools.stopDrawing();
    }

    s.outlineMode = next;
    // No button of its own to light up: this tool is reached from the polygon
    // tool and from the boundary's own menu, so it is the Draw button that
    // carries the active state - and refresh() re-evaluates it from the flag
    // that has just been set.
    App.controls.refresh();

    if (next) _start();
    else _stop();
  }

  function _start() {
    _layer = s.outerPolygonLayer;
    _undo = [];
    _redo = [];

    try {
      _original = JSON.parse(JSON.stringify(G.getOuterFeature(_layer).geometry));
    } catch (e) {
      _original = null;
    }

    // The pointer is a handle-dragging instrument now: a territory tooltip
    // chasing it covers the corner being aimed at, and a hover highlight
    // lifts a territory over the vertex markers.
    App.polygons.setTooltipMode("off");
    App.polygons.clearHover();
    App.gaps.schedule(0);

    try {
      _layer.enableEdit(s.leafletMap);
    } catch (e) {
      console.error(">>> Could not enable boundary editing:", e);
      s.outlineMode = false;
      App.controls.refresh();
      alert(T("outline.failed"));
      return;
    }

    s.leafletMap.on("editable:vertex:dragend", _onVertexChange);
    s.leafletMap.on("editable:vertex:deleted", _onVertexChange);
    s.leafletMap.on("editable:vertex:new", _onVertexChange);
    // Dragging a vertex is a live gesture; the count and the area readout
    // should follow it rather than jump when the mouse is let go.
    s.leafletMap.on("editable:vertex:drag", _sync);

    L.DomUtil.addClass(s.leafletMap.getContainer(), "is-outlining");

    _hint = D.mountOnMap("tpl-outline-hint", s.leafletMap);
    _showToolbar();
    App.shortcuts.push(OUTLINE_KEYS);
    App.history.pushScope(OUTLINE_SCOPE);
    _sync();
  }

  function _stop() {
    if (s.leafletMap)
      L.DomUtil.removeClass(s.leafletMap.getContainer(), "is-outlining");
    // A sweep still running when the tool closes would be handed a layer
    // that is about to be detached.
    App.shortcuts.releaseAll();
    s.leafletMap.off("editable:vertex:dragend", _onVertexChange);
    s.leafletMap.off("editable:vertex:deleted", _onVertexChange);
    s.leafletMap.off("editable:vertex:new", _onVertexChange);
    s.leafletMap.off("editable:vertex:drag", _sync);

    if (_layer && _layer.disableEdit) {
      try {
        _layer.disableEdit();
      } catch (e) {
        /* the layer may already have been replaced by apply() */
      }
    }

    _hint = D.remove(_hint);
    _hideToolbar();
    App.shortcuts.pop("outline");
    App.history.popScope("outline");
    App.ui.closeContextMenu();
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");
    App.gaps.schedule(0);

    _layer = null;
    _original = null;
    _undo = [];
    _redo = [];
  }

  // RING

  /**
   * The outer ring as a plain array, or null.
   *
   * Leaflet nests latlngs by ring and by part, and how deep depends on
   * whether the layer is a Polygon or a MultiPolygon - so this walks down to
   * the first array of LatLngs rather than assuming a depth.
   */
  function _ring() {
    if (!_layer || !_layer.getLatLngs) return null;
    var node = _layer.getLatLngs();
    while (Array.isArray(node) && node.length && Array.isArray(node[0]))
      node = node[0];
    return Array.isArray(node) ? node : null;
  }

  function _vertexCount() {
    var ring = _ring();
    return ring ? ring.length : 0;
  }

  function _snapshot() {
    var ring = _ring();
    if (!ring) return null;
    return ring.map(function (point) {
      return [point.lat, point.lng];
    });
  }

  function _restore(snapshot) {
    if (!snapshot || !_layer) return;
    _layer.setLatLngs(
      snapshot.map(function (pair) {
        return L.latLng(pair[0], pair[1]);
      }),
    );
    // The editor caches a marker per vertex, so the handles have to be rebuilt
    // rather than left pointing at latlngs that are no longer in the ring.
    try {
      _layer.disableEdit();
      _layer.enableEdit(s.leafletMap);
    } catch (e) {
      /* the shape is right even if the handles could not be remade */
    }
    _sync();
    App.history.sync();
  }

  /** Record the ring before the change the editor is about to report. */
  function _onVertexChange() {
    // An eraser sweep is one gesture and gets one entry, recorded by
    // _afterErase when the key comes up. Twenty steps to take back one swipe
    // is an undo stack that describes the implementation rather than the
    // work - and the readout still follows every corner, because that is
    // what says the sweep is doing something.
    if (App.vertices.isErasing()) {
      _sync();
      return;
    }
    // The editor fires after the fact, so what goes on the stack is the state
    // that is on screen *now* and the entry recorded before it is the one
    // undo returns to. Keeping the pre-change ring instead would mean
    // snapshotting on mousedown and guessing which drags will move anything.
    _pushUndo();
    _sync();
  }

  /** One entry for the whole sweep, once the key is up. */
  function _afterErase() {
    _pushUndo();
    _sync();
  }

  function _pushUndo() {
    var shot = _snapshot();
    if (!shot) return;
    // A drag that ends where it started is not a step. On the first change
    // there is nothing on the stack to compare against, so the comparison is
    // with the shape the tool opened with - otherwise the very gesture most
    // likely to be a no-op, picking a corner up and putting it back, is the
    // one that always records one.
    var last = _undo.length ? _undo[_undo.length - 1] : _originalRing();
    if (last && JSON.stringify(last) === JSON.stringify(shot)) return;
    _undo.push(shot);
    if (_undo.length > MAX) _undo.shift();
    _redo = [];
    App.history.sync();
  }

  function undoVertex() {
    if (!_undo.length) return false;
    _redo.push(_snapshot());
    // The stack holds the states *after* each change, so the one to return to
    // is the entry beneath the top - and the original when there is none.
    _undo.pop();
    _restore(_undo.length ? _undo[_undo.length - 1] : _originalRing());
    return true;
  }

  function redoVertex() {
    if (!_redo.length) return false;
    var shot = _redo.pop();
    _undo.push(shot);
    _restore(shot);
    return true;
  }

  function _originalRing() {
    if (!_original) return null;
    var coords = _original.coordinates;
    while (Array.isArray(coords) && coords.length && Array.isArray(coords[0][0]))
      coords = coords[0];
    return (coords || []).map(function (pair) {
      return [pair[1], pair[0]];
    });
  }

  var OUTLINE_SCOPE = {
    id: "outline",
    undo: undoVertex,
    redo: redoVertex,
    canUndo: function () {
      return _undo.length > 0;
    },
    canRedo: function () {
      return _redo.length > 0;
    },
    undoDepth: function () {
      return _undo.length;
    },
    redoDepth: function () {
      return _redo.length;
    },
    undoKey: "toolbar.undoCorner",
    redoKey: "toolbar.redoCorner",
  };

  // SHORTCUTS

  var OUTLINE_KEYS = {
    id: "outline",
    titleKey: "shortcuts.groupOutline",
    entries: [
      { combos: ["Enter"], labelKey: "shortcuts.outlineApply", run: apply },
      {
        combos: ["Backspace", "Delete"],
        labelKey: "shortcuts.outlineBack",
        when: function () {
          return _undo.length > 0;
        },
        run: undoVertex,
      },
      {
        combos: ["Shift+Backspace", "Shift+Delete"],
        labelKey: "shortcuts.outlineForward",
        when: function () {
          return _redo.length > 0;
        },
        run: redoVertex,
      },
      {
        combos: ["R"],
        labelKey: "shortcuts.outlineReset",
        when: function () {
          return _undo.length > 0;
        },
        run: reset,
      },
      {
        combos: ["Escape"],
        labelKey: "shortcuts.outlineCancel",
        run: function () {
          if (s.outlineMode) cancel();
        },
      },
      App.vertices.eraserKey({
        layer: function () {
          return _layer;
        },
        onStroke: _afterErase,
      }),
      { combos: ["Drag"], labelKey: "shortcuts.outlineMove", note: true },
      { combos: ["Click"], labelKey: "shortcuts.outlineDelete", note: true },
      { combos: ["Right-click"], labelKey: "shortcuts.menu", note: true },
    ],
  };

  // CONTEXT MENU

  function _showMenu(point) {
    App.ui.showContextMenu(point, [
      {
        labelKey: "outline.apply",
        icon: "fa-check",
        onClick: apply,
      },
      {
        labelKey: "outline.undo",
        icon: "fa-rotate-left",
        disabled: _undo.length === 0,
        onClick: undoVertex,
      },
      {
        labelKey: "outline.redo",
        icon: "fa-rotate-right",
        disabled: _redo.length === 0,
        onClick: redoVertex,
      },
      { separator: true },
      {
        labelKey: "outline.reset",
        icon: "fa-arrow-rotate-left",
        disabled: _undo.length === 0,
        onClick: reset,
      },
      {
        labelKey: "outline.cancel",
        icon: "fa-xmark",
        danger: true,
        onClick: cancel,
      },
    ]);
  }

  /** Called by polygons.js for a right-click on the boundary being edited. */
  function handleContextMenu(point) {
    if (!s.outlineMode) return false;
    _showMenu(point);
    return true;
  }

  // TOOLBAR

  function _showToolbar() {
    _hideToolbar();
    _toolbar = D.mountOnMap("tpl-outline-toolbar", s.leafletMap);
    D.onRole(_toolbar, "apply", apply);
    D.onRole(_toolbar, "undo", undoVertex);
    D.onRole(_toolbar, "redo", redoVertex);
    D.onRole(_toolbar, "reset", reset);
    D.onRole(_toolbar, "cancel", cancel);
    _sync();
  }

  function _hideToolbar() {
    _toolbar = D.remove(_toolbar);
  }

  /** Vertex count, the area it now encloses, and what each button can do. */
  function _sync() {
    if (!_toolbar) return;
    var count = _vertexCount();
    D.text(_toolbar, "count", T("outline.corners", { count: count }));

    var status = "";
    var current = _feature();
    if (!current) {
      status = T("outline.invalid");
    } else if (_original) {
      var before = G.area({ type: "Feature", geometry: _original });
      var after = G.area(current);
      if (before > 0) {
        var change = Math.round((after / before - 1) * 100);
        status =
          change === 0
            ? T("outline.unchanged")
            : T(change > 0 ? "outline.grown" : "outline.shrunk", {
                percent: Math.abs(change),
                area: _round(after / 1e6),
              });
      }
    }
    D.text(_toolbar, "status", status);
    D.toggleClass(_toolbar, "is-ready", count >= 3 && !!current);

    [
      ["apply", count >= 3 && !!current],
      ["undo", _undo.length > 0],
      ["redo", _redo.length > 0],
      ["reset", _undo.length > 0],
    ].forEach(function (pair) {
      var node = D.role(_toolbar, pair[0]);
      if (!node) return;
      D.toggleClass(node, "is-disabled", !pair[1]);
      node.setAttribute("aria-disabled", String(!pair[1]));
    });
  }

  // ACTIONS

  function _feature() {
    if (!_layer) return null;
    try {
      var feature = G.getOuterFeature(_layer);
      return feature && feature.geometry ? feature : null;
    } catch (e) {
      return null;
    }
  }

  /** Back to the ring the tool opened with, discarding undo and redo. */
  function reset() {
    if (!_original || !_layer) return;
    _redo = [];
    _undo = [];
    _restore(_originalRing());
  }

  function cancel() {
    // Leaving without applying must leave the boundary as it was found, and
    // the layer has been edited in place - so the shape is put back before
    // the mode ends rather than relying on the caller to notice.
    if (_original && _layer && _undo.length) _restore(_originalRing());
    if (s.outlineMode) toggle();
  }

  /**
   * Commit the reshaped boundary.
   *
   * Confirmed rather than silent because it is not only a boundary change:
   * territories are clipped to the new outline, and the ones whose shape
   * moved lose their printed mark. Both of those are worth hearing about
   * before they happen, not after.
   */
  function apply() {
    var poly = _sanitized();
    if (!poly) {
      alert(T("outline.invalid"));
      return;
    }

    var before = _original
      ? G.area({ type: "Feature", geometry: _original })
      : 0;
    var after = G.area(poly);
    var detail = T("outline.applyDetail", {
      before: _round(before / 1e6),
      after: _round(after / 1e6),
    });

    var outside = _territoriesOutside(poly);
    if (outside > 0)
      detail += " · " + T("outline.clipped", { count: outside });

    App.ui
      .confirm({
        titleKey: "outline.applyTitle",
        messageKey: "outline.applyMessage",
        detail: detail,
        okKey: "outline.applyOk",
        danger: outside > 0,
      })
      .then(function (ok) {
        if (ok) _install(poly);
      });
  }

  function _install(poly) {
    App.history.push();

    // Before the swap: the editor is holding vertex markers over a layer that
    // is about to be thrown away, and disableEdit() on a detached layer is
    // the one call that reliably leaves handles stranded on the map.
    var grew = _grewBeyondData(poly);
    if (s.outlineMode) {
      // Not cancel(): the whole point here is to keep the edited shape.
      _undo = [];
      toggle();
    }

    // Replacing the boundary clips every territory against it and then
    // re-tests every building - the heaviest thing in the app after the
    // partition itself, and long enough that it needs a spinner over it.
    App.ui.busy("loading.boundary", function () {
      _swap(poly, grew);
    });
  }

  function _swap(poly, grew) {
    var stats = App.polygons.replaceOuter(poly);
    if (!stats) {
      alert(T("outline.failed"));
      return;
    }

    console.log(
      ">>> Boundary reshaped —",
      Math.round(G.area(poly)),
      "m²,",
      stats.kept,
      "territories kept,",
      stats.dropped,
      "dropped,",
      stats.unmarked,
      "marks cleared",
    );

    // Only when it would be a surprise. A boundary that shrank still has all
    // its data; one that grew is showing an area nothing was ever downloaded
    // for, and a printed card of that area would be missing streets with
    // nothing on screen to say so.
    if (grew) _offerRefetch(poly);
  }

  function _offerRefetch(poly) {
    App.ui
      .confirm({
        titleKey: "outline.refetchTitle",
        messageKey: "outline.refetchMessage",
        okKey: "outline.refetchOk",
        cancelKey: "confirm.later",
      })
      .then(function (ok) {
        if (ok) App.data.fetchData(poly, true);
      });
  }

  /**
   * Whether the new outline reaches past what was downloaded.
   *
   * Compared against the bounds the server reported for the data, not against
   * the old boundary: dragging one corner outward by ten meters is still
   * inside the fetched box, and asking somebody to re-download a city because
   * they nudged a corner is how a helpful prompt becomes one people dismiss
   * without reading.
   */
  function _grewBeyondData(poly) {
    var bounds = s.cachedBounds;
    if (!bounds || !s.cachedStreets) return false;
    var box;
    try {
      box = turf.bbox(poly);
    } catch (e) {
      return false;
    }
    var slack = 1e-6; // a rounding-error's worth of degrees
    return (
      box[0] < bounds.west - slack ||
      box[1] < bounds.south - slack ||
      box[2] > bounds.east + slack ||
      box[3] > bounds.north + slack
    );
  }

  function _territoriesOutside(poly) {
    var count = 0;
    App.polygons.clusterFeatures().forEach(function (feature) {
      var before = G.area(feature);
      if (before <= 0) return;
      var clipped = null;
      try {
        clipped = G.intersect(feature, poly);
      } catch (e) {
        clipped = null;
      }
      var after = clipped && clipped.geometry ? G.area(clipped) : 0;
      if (Math.abs(after - before) > 1) count++;
    });
    return count;
  }

  /** Valid, single-ring, and big enough to be a boundary at all. */
  function _sanitized() {
    var poly = _feature();
    if (!poly) return null;
    if (_vertexCount() < 3) return null;

    var healed = poly;
    try {
      // A ring dragged by hand can cross itself, and a bow-tie is not a
      // boundary - buffer(0) is the standard repair and largestPolygon picks
      // the lobe worth keeping when it splits into two.
      if (turf.booleanValid && !turf.booleanValid(healed)) {
        healed = G.largestPolygon(turf.buffer(healed, 0)) || null;
      }
    } catch (e) {
      healed = null;
    }
    if (!healed || !healed.geometry) return null;
    return G.area(healed) > 0 ? healed : null;
  }

  function _round(value) {
    return App.i18n.n(Math.round(value * 100) / 100);
  }

  return {
    init: init,
    toggle: toggle,
    isActive: isActive,
    apply: apply,
    cancel: cancel,
    reset: reset,
    undoVertex: undoVertex,
    redoVertex: redoVertex,
    handleContextMenu: handleContextMenu,
  };
})();

window.App = App;
