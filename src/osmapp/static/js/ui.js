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
 *   • confirm() replaces window.confirm() for anything that has to say more
 *     than one sentence or run after an await.
 *   • The export button's visibility is no longer this module's business:
 *     App.controls.refresh() disables it in place instead of hiding it.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

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

    App._loaded.push("ui");
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

  /**
   * Indeterminate spinner: fetching, merging, splitting, post-processing.
   *
   * @param {Function} [onCancel] shows the Cancel button. A retrying download
   *   can sit on screen for a minute or more, so anything that waits that long
   *   has to offer a way out; without a callback the button stays hidden and
   *   the overlay is exactly as modal as it was.
   */
  function showBusy(text, status, onCancel) {
    _overlay.dataset.mode = onCancel ? "cancelable" : "simple";
    _onCancel = onCancel || null;
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

  /**
   * Progress within the current phase, 0..1.
   *
   * Phase 4 routes thousands of edges in chunks, so without this the checklist
   * sits on one unchanging line for tens of seconds and looks hung.
   */
  function setPhaseProgress(index, fraction) {
    setPhase(index);
    var item = _phaseNodes[index];
    if (!item) return;
    var label = item.querySelector(".phase-label");
    var key = label.getAttribute("data-i18n");
    var pct = Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100);
    label.textContent = App.i18n.t(key) + " — " + App.i18n.n(pct) + "%";
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
  // CONFIRM
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A yes/no prompt that resolves rather than blocking.
   *
   * window.confirm() is synchronous, unstyled, unlocalizable beyond its
   * message, and on mobile it is a system sheet that looks like the browser
   * asking rather than the app. It is also unusable for the case this exists
   * for — asking before a download — because the answer arrives before the
   * caller can show anything about what is being downloaded.
   *
   * Every exit resolves exactly once: the buttons, Escape (via _onKeyDown →
   * closeDialog → the teardown below), and any other dialog opening on top.
   *
   * @param {{titleKey?:string, title?:string,
   *          messageKey?:string, message?:string,
   *          detail?:string,
   *          okKey?:string, cancelKey?:string,
   *          danger?:boolean}} opts
   * @returns {Promise<boolean>}
   */
  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function finish(answer) {
        if (settled) return;
        settled = true;
        resolve(answer);
      }

      // Anything that closes the dialog without an explicit yes is a no.
      var dialog = openDialog("tpl-confirm-dialog", function () {
        finish(false);
      });

      D.text(
        dialog,
        "title",
        opts.titleKey ? App.i18n.t(opts.titleKey) : opts.title || "",
      );
      D.text(
        dialog,
        "message",
        opts.messageKey ? App.i18n.t(opts.messageKey) : opts.message || "",
      );
      D.text(dialog, "detail", opts.detail || "");
      D.toggleRole(dialog, "detail", !!opts.detail);

      var ok = D.role(dialog, "ok");
      var cancel = D.role(dialog, "cancel");
      ok.textContent = App.i18n.t(opts.okKey || "confirm.ok");
      cancel.textContent = App.i18n.t(opts.cancelKey || "confirm.cancel");
      D.toggleClass(ok, "btn--danger", !!opts.danger);
      D.toggleClass(ok, "btn--primary", !opts.danger);

      D.onRole(dialog, "cancel", function () {
        closeDialog();
      });
      D.onRole(dialog, "ok", function () {
        finish(true);
        closeDialog();
      });

      // Enter accepts. Escape is handled globally and lands on the teardown
      // above, so it needs nothing here.
      dialog.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        e.preventDefault();
        finish(true);
        closeDialog();
      });

      ok.focus();
    });
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
    setPhaseProgress: setPhaseProgress,
    setOverlayText: setOverlayText,
    setOverlayStatus: setOverlayStatus,
    hideOverlay: hideOverlay,

    // info panel
    setInfo: setInfo,
    setInfoDefault: setInfoDefault,
    setInfoLoaded: setInfoLoaded,
    setInfoFiltered: setInfoFiltered,

    // chrome
    confirm: confirm,
    openDialog: openDialog,
    closeDialog: closeDialog,
    showPolygonContextMenu: showPolygonContextMenu,
    closeContextMenu: closeContextMenu,

    PHASES: CLUSTER_PHASES,
  };
})();

window.App = App;
