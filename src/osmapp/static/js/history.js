/**
 * history.js - undo / redo, routed to whatever the user is currently doing.
 *
 * Shortcuts: Ctrl/Cmd+Z undo, Ctrl+Y or Ctrl+Shift+Z redo.
 *
 * Scopes
 *
 * "Undo" is not one thing. Halfway through drawing a split line it means
 * "take back that vertex"; with the print dialog open it means "take back that
 * eraser stroke"; the rest of the time it means "take back that edit to the
 * territories".
 *
 * The routing belongs in the stack rather than in the keyboard handler, for
 * two reasons:
 *
 *   - The toolbar Undo button goes through the same routing. A button meaning
 *     Ctrl+Z that calls history.undo() directly does something else than the
 *     key it stands for.
 *   - A mode that intercepts undo but not redo lets Ctrl+Y mid-draw fall
 *     through to the cluster stack and restore old geometry underneath a
 *     split line that is still being drawn.
 *
 * A mode pushes a scope when it starts and pops it when it ends, and every
 * entry point - keyboard, toolbar, the cut toolbar's Back button - goes
 * through the same delegation. The base scope, always at the bottom of the
 * stack, is the cluster geometry stack that push() writes to.
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
 * A scope whose undo means different things at different moments - the notes
 * pen steps a half-drawn mark while there is one and the note list otherwise -
 * gives a function for either key instead of a string. The tooltip is where
 * somebody reads what Ctrl+Z is about to do, so it has to follow.
 *
 * Modes never call push(). push() records document state, and a half-drawn
 * split line or an eraser stroke is not document state - it is the gesture
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

  // BASE SCOPE - cluster geometry

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

  // SCOPE STACK

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

  /** Which scope is answering right now - for tests and for debugging. */
  function scopeId() {
    return _active().id;
  }

  // PUBLIC

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

  /**
   * Under a spinner when the base scope answers, and not otherwise.
   *
   * Only the base scope rebuilds the territories, and rebuilding them on a
   * town-sized project is about a second of point-in-polygon work. The scoped
   * undo - a vertex while cutting, a territory while selecting - are a few
   * microseconds and must not be dressed up as work.
   */
  function _asBaseWork(scope, textKey, run) {
    if (scope !== BASE || !App.ui || !App.ui.busy) {
      run();
      return;
    }
    App.ui.busy(textKey, run);
  }

  function undo() {
    var scope = _active();
    if (!scope.canUndo()) return;
    _asBaseWork(scope, "loading.undoing", function () {
      scope.undo();
      sync();
    });
  }

  function redo() {
    var scope = _active();
    if (!scope.canRedo()) return;
    _asBaseWork(scope, "loading.redoing", function () {
      scope.redo();
      sync();
    });
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
    return _key(_active().undoKey);
  }

  function redoKey() {
    return _key(_active().redoKey);
  }

  function _key(value) {
    return typeof value === "function" ? value() : value;
  }

  // SNAPSHOT / RESTORE

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
   * The territories alone would do for as long as nothing changes the boundary
   * once they exist - drawing or adopting one clears the history rather than
   * adding to it. The trim tool breaks that: it reshapes the boundary and clips
   * the territories to the result in one action, and undoing only the second
   * half leaves territories spilling outside the outline they belong to.
   *
   * The whole boundary, every area of it. A trim or a reshape works on one
   * area and leaves the others alone, so a snapshot of the one that changed is
   * a snapshot that deletes the rest on the way back.
   */
  function _snapshot() {
    return JSON.stringify({
      outer: s.outerPolygonLayer
        ? App.geometry.outerFeature(s.outerPolygonLayer).geometry
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
        ? App.geometry.outerFeature(s.outerPolygonLayer).geometry
        : null;
    } catch (e) {
      /* an unreadable current boundary is one worth replacing */
    }
    // Rebuilding the layer detaches every handler bound to it, so it is only
    // done when the geometry genuinely differs - which is to say, only for the
    // one action that changes it.
    if (current && JSON.stringify(current) === JSON.stringify(geometry)) return;

    var layer = App.geometry.toLayer(geometry, App.polygons.OUTER_STYLE);
    if (!layer) return;
    App.polygons.setOuterLayer(layer);
  }

  // BUTTONS

  /**
   * Re-read the active scope's depth into the toolbar. Scopes call this after
   * mutating, so the buttons follow the mode without either side knowing how
   * the other renders.
   */
  function sync() {
    if (App.controls) App.controls.refresh();
  }

  // KEYBOARD

  /**
   * Undo and redo are global: they are answered by whichever scope is active,
   * which is the whole design above, so there is nothing for a per-mode
   * binding to add. Registering them rather than listening directly is what
   * gets them onto the shortcut sheet - and the sheet is where somebody finds
   * out that Ctrl+Z means "take back that vertex" while a cut is in progress.
   */
  function _bindKeyboard() {
    App.shortcuts.global([
      {
        combos: ["Mod+Z"],
        labelKey: "shortcuts.undo",
        // Survives an open dialog: the print dialog pushes the eraser's scope,
        // so with one up this *is* the dialog's undo, and the rule that
        // silences shortcuts under a modal must not take it away.
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
