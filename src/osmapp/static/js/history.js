/**
 * history.js — undo / redo for cluster geometry.
 *
 * Shortcuts: Ctrl/Cmd+Z undo, Ctrl+Y or Ctrl+Shift+Z redo.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.history = (function () {
  "use strict";

  var s = null;
  var _undo = [];
  var _redo = [];
  var MAX = 30;

  function init() {
    s = App.state;
    _bindKeyboard();
    _updateButtons();
    App.i18n.onChange(_updateButtons);
    App._loaded.push("history");
  }

  // ══════════════════════════════════════════════════════════════════════
  // PUBLIC
  // ══════════════════════════════════════════════════════════════════════

  /** Call before any mutation that should be undoable. */
  function push() {
    _undo.push(_snapshot());
    if (_undo.length > MAX) _undo.shift();
    _redo = []; // a new action branches off the timeline
    _updateButtons();
  }

  function undo() {
    if (_undo.length === 0) return;
    _redo.push(_snapshot());
    if (_redo.length > MAX) _redo.shift();
    _restore(_undo.pop());
    _updateButtons();
  }

  function redo() {
    if (_redo.length === 0) return;
    _undo.push(_snapshot());
    if (_undo.length > MAX) _undo.shift();
    _restore(_redo.pop());
    _updateButtons();
  }

  function clear() {
    _undo = [];
    _redo = [];
    _updateButtons();
  }

  function canUndo() {
    return _undo.length > 0;
  }

  function canRedo() {
    return _redo.length > 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // SNAPSHOT / RESTORE
  // ══════════════════════════════════════════════════════════════════════

  function _snapshot() {
    return JSON.stringify(App.polygons.clusterFeatures());
  }

  function _restore(json) {
    var features;
    try {
      features = JSON.parse(json);
    } catch (e) {
      console.error(">>> Corrupt history snapshot:", e);
      return;
    }
    App.polygons.setClusters(features);
    console.log(">>> Restored", s.clusters.length, "clusters");
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUTTONS
  // ══════════════════════════════════════════════════════════════════════

  function _updateButtons() {
    _syncButton(".tb-btn.undo-btn", _undo.length, "undo");
    _syncButton(".tb-btn.redo-btn", _redo.length, "redo");
  }

  function _syncButton(selector, depth, kind) {
    var btn = document.querySelector(selector);
    if (!btn) return;
    btn.classList.toggle("is-disabled", depth === 0);
    btn.title =
      depth > 0
        ? App.i18n.t("toolbar." + kind + "Count", { count: depth })
        : App.i18n.t("toolbar." + kind + "None");
  }

  // ══════════════════════════════════════════════════════════════════════
  // KEYBOARD
  // ══════════════════════════════════════════════════════════════════════

  function _bindKeyboard() {
    document.addEventListener("keydown", function (e) {
      var tag = (e.target || e.srcElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      var ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      var key = e.key.toLowerCase();

      // While the print dialog is open, undo belongs to its eraser, not to
      // cluster geometry.
      if (App.print && App.print.isOpen()) {
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          App.print.undo();
        } else if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          App.print.redo();
        }
        return;
      }

      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    });
  }

  return {
    init: init,
    push: push,
    undo: undo,
    redo: redo,
    clear: clear,
    canUndo: canUndo,
    canRedo: canRedo,
  };
})();

window.App = App;
