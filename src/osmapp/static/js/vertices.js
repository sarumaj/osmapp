/**
 * vertices.js — the corner handles, and the one gesture that removes them fast.
 *
 * Three places hand a ring to Leaflet.Editable and let it be dragged about:
 * the boundary drawer in main.js, the outline editor, and the trim tool's
 * hand-adjust latch. All three inherit the library's defaults, and the
 * defaults carry the same two problems in each, so the fix lives here once.
 *
 * ── Problem one: an eight-pixel target ────────────────────────────────────
 *
 * L.Editable.VertexIcon is 8 × 8 CSS pixels, well below what is comfortable on
 * a trackpad. Missing it is not harmless either: the click lands on the
 * polygon underneath, which is the boundary in the outline editor and a
 * building that then toggles in trim mode.
 *
 * The handle is drawn at state.VERTEX_SIZE_PX, applied to the library's
 * prototype by install() below, and given more reach still through a
 * transparent pseudo-element in the stylesheet. The reach is separate from
 * the icon because icon size is also what the eye sees: a 26-pixel dot on
 * every corner of a hand-traced boundary hides the shape being traced.
 *
 * Middle markers — the half-handles that add a corner — get the same box with
 * a smaller dot inside it. They sit *on* the line, where an opaque circle
 * would hide the edge being adjusted.
 *
 * ── Problem two: deleting corners one at a time ───────────────────────────
 *
 * Straightening a stretch of a traced boundary means removing a run of twenty
 * corners, and the library's gesture is a click per corner — each a separate
 * aim at the small target above, each reflowing the middle markers under the
 * cursor before the next one.
 *
 * The eraser is the bulk answer: hold the key and sweep, and anything the ring
 * passes over goes. Held rather than latched, because a mode where the pointer
 * destroys what it touches must not be one that can be left switched on by
 * accident, and a key that has to stay down cannot be.
 *
 * Two rules keep it honest:
 *
 *   • It never takes the last three corners. That is PolygonEditor's own
 *     MIN_VERTEX of 3, asked through `vertexCanBeDeleted` rather than
 *     reimplemented, so a sweep across a triangle stops rather than leaving
 *     a line.
 *   • A stroke is one undo step. The host suspends its per-vertex bookkeeping
 *     while the key is down and records once on release, so the undo stack
 *     describes the gesture rather than the implementation.
 *
 * While the key is down the map does not pan and the handles stop taking
 * pointer events, so the sweep cannot turn into a drag of the corner it was
 * about to remove.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.vertices = (function () {
  "use strict";

  var s = null;

  var _installed = false;
  var _stroke = null; // { spec, ring, removed } while the key is held

  function init() {
    s = App.state;
    App._loaded.push("vertices");
  }

  // ══════════════════════════════════════════════════════════════════════
  // HANDLE SIZE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Resize the library's handles, once, before anything draws one.
   *
   * The prototype rather than a subclass: `editTools.createVertexIcon()` is
   * called from inside VertexMarker and MiddleMarker with no way to pass a
   * class in, so replacing the icon would mean replacing both markers to get
   * at one number. L.Class.extend copies `options` into a fresh object per
   * subclass, so TouchVertexIcon — which already ships a 20-pixel icon for
   * touch devices — is untouched by this.
   */
  function install() {
    if (_installed) return false;
    if (typeof L === "undefined" || !L.Editable || !L.Editable.VertexIcon)
      return false;
    var size = Math.max(8, s.VERTEX_SIZE_PX || 12);
    L.Editable.VertexIcon.prototype.options.iconSize = new L.Point(size, size);
    _installed = true;
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ERASER
  // ══════════════════════════════════════════════════════════════════════

  function isErasing() {
    return !!_stroke;
  }

  /**
   * Start a sweep.
   *
   * @param {{layer: Function, onStroke?: Function}} spec
   *   layer()    the editable layer to erase from, resolved on every move so
   *              a host that swaps its layer mid-gesture cannot leave this
   *              deleting from a shape that is no longer on the map.
   *   onStroke() called once on release, with the number of corners removed,
   *              and only when that number is not zero.
   */
  function eraseStart(spec) {
    if (_stroke || !spec || typeof spec.layer !== "function") return false;
    var map = s.leafletMap;
    if (!map || !_editorOf(spec.layer())) return false;

    _stroke = { spec: spec, removed: 0, ring: null };

    var container = map.getContainer();
    L.DomUtil.addClass(container, "is-erasing-vertices");
    try {
      map.dragging.disable();
    } catch (e) {
      /* a map without drag enabled is not a reason to refuse the gesture */
    }

    _stroke.ring = App.dom.mountOnMap("tpl-vertex-eraser", map);
    var radius = _radius();
    _stroke.ring.style.width = radius * 2 + "px";
    _stroke.ring.style.height = radius * 2 + "px";

    L.DomEvent.on(container, "mousemove", _onMove);
    // The corner under the cursor when the key went down should go too:
    // waiting for a movement means a deliberate press on one handle does
    // nothing, which reads as the gesture being broken.
    if (_last) _eraseAt(_last);
    return true;
  }

  function eraseStop() {
    if (!_stroke) return 0;
    var stroke = _stroke;
    _stroke = null;

    var map = s.leafletMap;
    if (map) {
      var container = map.getContainer();
      L.DomUtil.removeClass(container, "is-erasing-vertices");
      L.DomEvent.off(container, "mousemove", _onMove);
      try {
        map.dragging.enable();
      } catch (e) {
        /* the map may already be gone */
      }
    }
    App.dom.remove(stroke.ring);

    if (stroke.removed && typeof stroke.spec.onStroke === "function")
      stroke.spec.onStroke(stroke.removed);
    return stroke.removed;
  }

  /**
   * Where the pointer was last seen, in container coordinates.
   *
   * Kept even when no stroke is running, because the gesture starts on a key
   * press and a key press carries no coordinates. Without this the first
   * corner erased would be wherever the mouse moved *after* the key went
   * down, which is not where anybody aimed.
   */
  var _last = null;

  function _trackPointer(e) {
    var map = s && s.leafletMap;
    if (!map) return;
    try {
      _last = map.mouseEventToContainerPoint(e);
    } catch (err) {
      _last = null;
    }
  }

  function _onMove(e) {
    _trackPointer(e);
    if (_last) _eraseAt(_last);
  }

  function _radius() {
    return Math.max(6, s.VERTEX_ERASER_PX || 22);
  }

  function _eraseAt(point) {
    if (!_stroke) return;
    if (_stroke.ring) {
      var radius = _radius();
      _stroke.ring.style.transform =
        "translate(" + (point.x - radius) + "px," + (point.y - radius) + "px)";
    }

    var editor = _editorOf(_stroke.spec.layer());
    if (!editor) return;
    var map = s.leafletMap;
    var reach = _radius();

    _markersOf(editor).forEach(function (marker) {
      if (!marker.latlng || typeof marker.delete !== "function") return;
      // Asked per corner rather than once for the sweep: each delete shortens
      // the ring, so a run that starts legal can reach the floor halfway
      // through and has to stop there.
      if (editor.vertexCanBeDeleted && !editor.vertexCanBeDeleted(marker))
        return;
      var at;
      try {
        at = map.latLngToContainerPoint(marker.latlng);
      } catch (e) {
        return;
      }
      if (at.distanceTo(point) > reach) return;
      try {
        marker.delete();
        _stroke.removed++;
      } catch (e) {
        /* a marker the editor has already dropped is not an error */
      }
    });
  }

  /** The PathEditor behind a layer, however the host handed it over. */
  function _editorOf(layer) {
    if (!layer) return null;
    if (layer.editLayer && typeof layer.vertexCanBeDeleted === "function")
      return layer; // already an editor
    return layer.editor && layer.editor.editLayer ? layer.editor : null;
  }

  /**
   * The corner handles, as a snapshot.
   *
   * A copy rather than the live list: delete() removes the marker from the
   * same layer group being walked, and it also refreshes the editor, which
   * rebuilds the middle markers underneath. Middle markers are excluded by
   * class rather than by duck-typing — they carry a delete() of their own
   * that removes the handle without touching the ring, so erasing one would
   * look like it worked and change nothing.
   */
  function _markersOf(editor) {
    var out = [];
    try {
      editor.editLayer.eachLayer(function (marker) {
        if (L.Editable.VertexMarker && marker instanceof L.Editable.VertexMarker)
          out.push(marker);
      });
    } catch (e) {
      return [];
    }
    return out;
  }

  /**
   * A shortcut entry a mode can drop into its own context.
   *
   * Here rather than written out in outline.js and trim.js, because the two
   * of them differ only in which layer they hand over: same key, same label,
   * same held-modifier semantics, and a second copy is how the two drift into
   * meaning slightly different things.
   */
  function eraserKey(spec) {
    return {
      combos: ["X"],
      labelKey: "shortcuts.eraseVertices",
      hold: true,
      when: spec.when || null,
      run: function () {
        eraseStart(spec);
      },
      release: eraseStop,
    };
  }

  /**
   * The pointer is tracked from the moment the map exists, not from the
   * moment somebody presses the key — see _last.
   */
  function watch(map) {
    if (!map) return;
    L.DomEvent.on(map.getContainer(), "mousemove", _trackPointer);
  }

  return {
    init: init,
    install: install,
    watch: watch,
    isErasing: isErasing,
    eraseStart: eraseStart,
    eraseStop: eraseStop,
    eraserKey: eraserKey,
  };
})();

window.App = App;
