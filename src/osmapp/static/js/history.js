/**
 * history.js — undo / redo, routed to whatever the user is currently doing.
 *
 * Shortcuts: Ctrl/Cmd+Z undo, Ctrl+Y or Ctrl+Shift+Z redo.
 *
 * ── Scopes ────────────────────────────────────────────────────────────────
 *
 * "Undo" is not one thing. Halfway through drawing a split line it means
 * "take back that vertex"; with the print dialog open it means "take back that
 * eraser stroke"; the rest of the time it means "take back that edit to the
 * territories". Undoing a merge because someone hit Ctrl+Z while placing a
 * vertex is not a smaller version of the right answer, it is the wrong one.
 *
 * That routing used to live in the keyboard handler alone, which had two
 * consequences worth naming, because they are exactly what a scope stack
 * fixes:
 *
 *   • The toolbar Undo button called history.undo() directly and so ignored
 *     the routing completely. Ctrl+Z and the button that means Ctrl+Z did
 *     different things.
 *   • Cut mode intercepted undo but not redo, so Ctrl+Y mid-draw fell through
 *     to the cluster stack and restored old geometry underneath a split line
 *     that was still being drawn.
 *
 * Now a mode pushes a scope when it starts and pops it when it ends, and every
 * entry point — keyboard, toolbar, the cut toolbar's Back button — goes through
 * the same delegation. The base scope, the one that is always at the bottom of
 * the stack, is the cluster geometry stack that push() writes to.
 *
 * A scope is:
 *
 *   {
 *     id:        string,     unique; pop() takes the id, not the object
 *     undo():    void
 *     redo():    void
 *     canUndo(): boolean
 *     canRedo(): boolean
 *     undoDepth(): number    for the tooltip
 *     redoDepth(): number
 *     undoKey:   string      i18n prefix, expects <key>Count and <key>None
 *     redoKey:   string
 *   }
 *
 * Modes never call push(). push() records document state, and a half-drawn
 * split line or an eraser stroke is not document state — it is the gesture
 * that will eventually produce one.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.history = (function () {
  "use strict";

  var s = null;
  var _undo = [];
  var _redo = [];
  var MAX = 30;

  /** Innermost last. The base scope is not on it; see _active(). */
  var _scopes = [];

  // ══════════════════════════════════════════════════════════════════════
  // BASE SCOPE — cluster geometry
  // ══════════════════════════════════════════════════════════════════════

  var BASE = {
    id: "clusters",
    undo: _undoClusters,
    redo: _redoClusters,
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
    undoKey: "toolbar.undo",
    redoKey: "toolbar.redo",
  };

  function init() {
    s = App.state;
    _bindKeyboard();
    sync();
    App.i18n.onChange(sync);
    App._loaded.push("history");
  }

  function _active() {
    return _scopes.length ? _scopes[_scopes.length - 1] : BASE;
  }

  // ══════════════════════════════════════════════════════════════════════
  // SCOPE STACK
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Take over undo/redo until popScope(id). Pushing an id that is already on
   * the stack replaces it rather than stacking a duplicate, so a mode that
   * restarts without a clean teardown cannot leak a scope and strand undo in
   * a tool that has closed.
   */
  function pushScope(scope) {
    if (!scope || !scope.id) return;
    popScope(scope.id);
    _scopes.push(scope);
    sync();
  }

  function popScope(id) {
    for (var i = _scopes.length - 1; i >= 0; i--) {
      if (_scopes[i].id === id) {
        _scopes.splice(i, 1);
        sync();
        return;
      }
    }
  }

  /** Which scope is answering right now — for tests and for debugging. */
  function scopeId() {
    return _active().id;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PUBLIC
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Record cluster geometry before a mutation that should be undoable.
   * Always targets the base scope, whatever mode happens to be active.
   */
  function push() {
    _undo.push(_snapshot());
    if (_undo.length > MAX) _undo.shift();
    _redo = []; // a new action branches off the timeline
    sync();
  }

  function undo() {
    var scope = _active();
    if (!scope.canUndo()) return;
    scope.undo();
    sync();
  }

  function redo() {
    var scope = _active();
    if (!scope.canRedo()) return;
    scope.redo();
    sync();
  }

  function clear() {
    _undo = [];
    _redo = [];
    sync();
  }

  function canUndo() {
    return _active().canUndo();
  }

  function canRedo() {
    return _active().canRedo();
  }

  function undoDepth() {
    return _active().undoDepth();
  }

  function redoDepth() {
    return _active().redoDepth();
  }

  /** i18n prefix for the active scope; controls.js appends Count / None. */
  function undoKey() {
    return _active().undoKey;
  }

  function redoKey() {
    return _active().redoKey;
  }

  // ══════════════════════════════════════════════════════════════════════
  // SNAPSHOT / RESTORE
  // ══════════════════════════════════════════════════════════════════════

  function _undoClusters() {
    _redo.push(_snapshot());
    if (_redo.length > MAX) _redo.shift();
    _restore(_undo.pop());
  }

  function _redoClusters() {
    _undo.push(_snapshot());
    if (_undo.length > MAX) _undo.shift();
    _restore(_redo.pop());
  }

  /**
   * A snapshot is the outer boundary plus the territories.
   *
   * It used to be the territories alone, which was true for as long as
   * nothing changed the boundary once territories existed — drawing or
   * adopting one clears the history rather than adding to it. The trim tool
   * breaks that: it reshapes the boundary and clips the territories to the
   * result in a single action, and undoing only the second half would leave
   * territories that spill outside the outline they belong to.
   */
  function _snapshot() {
    return JSON.stringify({
      outer: s.outerPolygonLayer
        ? App.geometry.getOuterFeature(s.outerPolygonLayer).geometry
        : null,
      clusters: App.polygons.clusterFeatures(),
    });
  }

  function _restore(json) {
    var state;
    try {
      state = JSON.parse(json);
    } catch (e) {
      console.error(">>> Corrupt history snapshot:", e);
      return;
    }
    _restoreOuter(state.outer);
    App.polygons.setClusters(state.clusters || []);
    console.log(">>> Restored", s.clusters.length, "clusters");
  }

  function _restoreOuter(geometry) {
    if (!geometry) return;
    var current = null;
    try {
      current = s.outerPolygonLayer
        ? App.geometry.getOuterFeature(s.outerPolygonLayer).geometry
        : null;
    } catch (e) {
      /* an unreadable current boundary is one worth replacing */
    }
    // Rebuilding the layer detaches every handler bound to it, so it is only
    // done when the geometry genuinely differs — which is to say, only for the
    // one action that changes it.
    if (current && JSON.stringify(current) === JSON.stringify(geometry)) return;

    var layer = App.geometry.toLayer(geometry, App.polygons.OUTER_STYLE);
    if (!layer) return;
    App.polygons.setOuterLayer(layer);
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUTTONS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Re-read the active scope's depth into the toolbar. Scopes call this after
   * mutating, so the buttons follow the mode without either side knowing how
   * the other renders.
   */
  function sync() {
    if (App.controls) App.controls.refresh();
  }

  // ══════════════════════════════════════════════════════════════════════
  // KEYBOARD
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Undo and redo are global: they are answered by whichever scope is active,
   * which is the whole design above, so there is nothing for a per-mode
   * binding to add. Registering them rather than listening directly is what
   * gets them onto the shortcut sheet — and the sheet is where somebody finds
   * out that Ctrl+Z means "take back that vertex" while a cut is in progress.
   */
  function _bindKeyboard() {
    App.shortcuts.global([
      {
        combos: ["Mod+Z"],
        labelKey: "shortcuts.undo",
        // Survives an open dialog: the print dialog pushes the eraser's scope,
        // so with one up this *is* the dialog's undo. It had that before the
        // registry existed and must not lose it to a rule about modals.
        overModal: true,
        when: canUndo,
        run: undo,
      },
      {
        combos: ["Mod+Y", "Mod+Shift+Z"],
        labelKey: "shortcuts.redo",
        overModal: true,
        when: canRedo,
        run: redo,
      },
    ]);
  }

  return {
    init: init,
    push: push,
    undo: undo,
    redo: redo,
    clear: clear,
    canUndo: canUndo,
    canRedo: canRedo,
    undoDepth: undoDepth,
    redoDepth: redoDepth,
    undoKey: undoKey,
    redoKey: redoKey,
    pushScope: pushScope,
    popScope: popScope,
    scopeId: scopeId,
    sync: sync,
  };
})();

window.App = App;
