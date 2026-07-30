/**
 * ui.js — the single owner of every piece of chrome outside the map:
 * loading overlay, info panel, context menu, modal dialogs.
 *
 * Changes from the previous version:
 *   • No HTML strings. All markup comes from <template> via App.dom.
 *   • One overlay API. editing.js's private _showSpinner/_hideSpinner pair
 *     (which fought the clustering overlay over inline `display` values) is
 *     gone; the overlay has a `data-mode` attribute and CSS decides what
 *     shows. showBusy() and showPhases() are the two modes.
 *   • The overlay's Cancel button takes a callback instead of an inline
 *     onclick="App.clustering.cancelPartition()" in the HTML.
 *   • Info panel writes into fixed nodes rather than replacing innerHTML.
 */
var App = window.App || {};

App.ui = (function () {
  "use strict";

  var s = null;
  var D = null;

  var _overlay = null;
  var _panel = null;
  var _onCancel = null;
  var _phaseNodes = [];
  var _dialog = null;
  var _docKeyBound = false;

  var CLUSTER_PHASES = [
    "phase.samples",
    "phase.kmeans",
    "phase.voronoi",
    "phase.graph",
    "phase.trace",
    "phase.finalize",
  ];

  // The info panel is rebuilt from JS, so the last payload is kept in order to
  // re-render it when the language changes.
  var _lastInfo = null;

  function init() {
    s = App.state;
    D = App.dom;
    _overlay = document.getElementById("loading-overlay");
    _panel = document.getElementById("info-panel");

    var cancel = D.role(_overlay, "cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        if (typeof _onCancel === "function") _onCancel();
      });
    }

    if (!_docKeyBound) {
      document.addEventListener("keydown", _onKeyDown);
      _docKeyBound = true;
    }

    App.i18n.onChange(function () {
      if (_lastInfo) setInfo(_lastInfo);
    });
  }

  function _onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (App.print && App.print.isOpen()) {
      App.print.close();
      e.stopPropagation();
    } else if (_dialog) {
      closeDialog();
      e.stopPropagation();
    } else if (s && s.contextMenu) {
      closeContextMenu();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // OVERLAY
  // ══════════════════════════════════════════════════════════════════════

  /** Indeterminate spinner: fetching, merging, splitting, post-processing. */
  function showBusy(text, status) {
    _overlay.dataset.mode = "simple";
    _onCancel = null;
    setOverlayText(text, status || "");
    D.toggle(_overlay, true);
  }

  /** Staged spinner with a phase checklist and a Cancel button. */
  function showPhases(text, status, onCancel) {
    _overlay.dataset.mode = "phases";
    _onCancel = onCancel || null;
    setOverlayText(text, status || "");

    var host = D.role(_overlay, "phases");
    host.textContent = "";
    _phaseNodes = CLUSTER_PHASES.map(function (key) {
      var item = D.mount("tpl-phase-item", host);
      var label = item.querySelector(".phase-label");
      label.setAttribute("data-i18n", key);
      label.textContent = App.i18n.t(key);
      return item;
    });
    setPhase(0);
    D.toggle(_overlay, true);
  }

  function setPhase(index) {
    _phaseNodes.forEach(function (item, i) {
      var icon = item.querySelector(".phase-icon");
      item.classList.toggle("done", i < index);
      item.classList.toggle("active", i === index);
      icon.textContent =
        i < index ? "\u2713" : i === index ? "\u25B6" : "\u25CB";
    });
  }

  function setOverlayText(text, status) {
    if (text !== undefined) D.text(_overlay, "text", text);
    if (status !== undefined) D.text(_overlay, "status", status);
  }

  function setOverlayStatus(status) {
    D.text(_overlay, "status", status || "");
  }

  function hideOverlay() {
    D.toggle(_overlay, false);
    _onCancel = null;
    _phaseNodes = [];
    D.role(_overlay, "phases").textContent = "";
  }

  // ══════════════════════════════════════════════════════════════════════
  // INFO PANEL
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @param {{title?:string, streets?:number, buildings?:number,
   *          clusters?:number|null, hint?:string}} info
   */
  function setInfo(info) {
    info = _lastInfo = info || {};
    var hasStats = info.streets !== undefined || info.buildings !== undefined;

    D.text(
      _panel,
      "title",
      info.titleKey ? App.i18n.t(info.titleKey) : info.title || "",
    );
    D.toggleRole(_panel, "stats", hasStats);

    if (hasStats) {
      D.text(_panel, "streets", info.streets || 0);
      D.text(_panel, "buildings", info.buildings || 0);
      var hasClusters = info.clusters != null;
      D.toggleRole(_panel, "clusters-row", hasClusters);
      if (hasClusters) D.text(_panel, "clusters", info.clusters);
    }

    var hint = info.hintKey ? App.i18n.t(info.hintKey) : info.hint || "";
    D.text(_panel, "hint", hint);
    D.toggleRole(_panel, "hint", !!hint);
  }

  function setInfoDefault() {
    setInfo({ titleKey: "info.prompt" });
  }

  function setInfoLoaded(streets, buildings) {
    setInfo({
      titleKey: "info.loaded",
      streets: streets,
      buildings: buildings,
      hintKey: "info.hintLoaded",
    });
  }

  function setInfoFiltered(streets, buildings, clusters) {
    setInfo({
      titleKey: "info.filtered",
      streets: streets,
      buildings: buildings,
      clusters: clusters,
      hintKey: "info.hintFiltered",
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // EXPORT TOOLBAR
  // ══════════════════════════════════════════════════════════════════════

  function showExportToolbar() {
    var el = document.querySelector(".export-toolbar");
    if (el) el.classList.add("visible");
  }

  function hideExportToolbar() {
    var el = document.querySelector(".export-toolbar");
    if (el) el.classList.remove("visible");
  }

  // ══════════════════════════════════════════════════════════════════════
  // DIALOG
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Mount a dialog template on the map. Only one dialog exists at a time;
   * opening a second closes the first. Escape closes it (see _onKeyDown).
   * @returns {HTMLElement} the dialog root — query it with App.dom.role()
   */
  var _dialogOnClose = null;

  function openDialog(templateId, onClose) {
    closeDialog();
    _dialogOnClose = onClose || null;
    _dialog = D.mountOnMap(templateId, s.leafletMap);
    return _dialog;
  }

  function closeDialog() {
    var teardown = _dialogOnClose;
    _dialogOnClose = null;
    _dialog = D.remove(_dialog);
    if (teardown) teardown();
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONTEXT MENU
  // ══════════════════════════════════════════════════════════════════════

  function showPolygonContextMenu(point, layer, feature) {
    closeContextMenu();
    var menu = D.mountOnMap("tpl-polygon-menu", s.leafletMap);

    // Keep the menu inside the viewport instead of letting it overflow.
    var container = s.leafletMap.getContainer();
    var x = Math.min(point.x, container.clientWidth - menu.offsetWidth - 8);
    var y = Math.min(point.y, container.clientHeight - menu.offsetHeight - 8);
    menu.style.left = Math.max(0, x) + "px";
    menu.style.top = Math.max(0, y) + "px";

    D.onRole(menu, "zoom", function () {
      closeContextMenu();
      s.leafletMap.fitBounds(layer.getBounds(), {
        padding: [50, 50],
        maxZoom: 18,
      });
    });

    D.onRole(menu, "print", function () {
      closeContextMenu();
      App.print.printCluster(feature);
    });

    D.onRole(menu, "delete", function () {
      closeContextMenu();
      App.polygons.deleteCluster(layer);
    });

    s.contextMenu = menu;
    setTimeout(function () {
      document.addEventListener("click", closeContextMenu);
    }, 0);
  }

  function closeContextMenu() {
    if (!s.contextMenu) return;
    D.remove(s.contextMenu);
    s.contextMenu = null;
    document.removeEventListener("click", closeContextMenu);
  }

  return {
    init: init,

    // overlay
    showBusy: showBusy,
    showPhases: showPhases,
    setPhase: setPhase,
    setOverlayText: setOverlayText,
    setOverlayStatus: setOverlayStatus,
    hideOverlay: hideOverlay,

    // info panel
    setInfo: setInfo,
    setInfoDefault: setInfoDefault,
    setInfoLoaded: setInfoLoaded,
    setInfoFiltered: setInfoFiltered,

    // chrome
    showExportToolbar: showExportToolbar,
    hideExportToolbar: hideExportToolbar,
    openDialog: openDialog,
    closeDialog: closeDialog,
    showPolygonContextMenu: showPolygonContextMenu,
    closeContextMenu: closeContextMenu,

    PHASES: CLUSTER_PHASES,
  };
})();

window.App = App;
