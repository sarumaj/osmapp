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

    // The territory count is a button. It is the one number in the panel
    // people try to reconcile against the map by eye, and the answer to
    // "where are they?" is a list you can click, not a bigger number.
    var count = D.role(_panel, "clusters-btn");
    if (count) {
      count.addEventListener("click", function (e) {
        e.preventDefault();
        if (App.labels) App.labels.openList();
      });
    }

    App.i18n.onChange(refreshInfo);

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
   *          clusters?:number|null, printed?:number|null, hint?:string}} info
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
      if (hasClusters) {
        D.text(_panel, "clusters", info.clusters);
        _syncClusterWarning();
      }

      // Shown from the first territory onwards, not from the first card:
      // "0 of 12" is the number that makes the round legible, and a row that
      // only appears once you have already done the thing it counts teaches
      // nobody that the counter exists.
      D.toggleRole(_panel, "printed-row", hasClusters);
      if (hasClusters) D.text(_panel, "printed", info.printed || 0);
    }

    var hint = info.hintKey ? App.i18n.t(info.hintKey) : info.hint || "";
    D.text(_panel, "hint", hint);
    D.toggleRole(_panel, "hint", !!hint);
  }

  /**
   * A quiet mark next to the count when it is going to disagree with what the
   * map shows — territories too small to see at this zoom, or drawn in more
   * than one piece. Without it the number looks wrong; with it the number
   * looks explained, and the explanation is one click away.
   */
  function _syncClusterWarning() {
    var warn = App.labels ? App.labels.warnings() : null;
    var flagged = !!(warn && warn.total > 0);
    D.toggleRole(_panel, "clusters-warn", flagged);
    var button = D.role(_panel, "clusters-btn");
    if (button) {
      button.setAttribute(
        "title",
        App.i18n.t(flagged ? "info.clustersWarn" : "info.clustersHelp"),
      );
    }
  }

  /** Re-render the panel from the last payload — after a language change or
   *  a zoom that changed which territories count as too small to see. */
  function refreshInfo() {
    if (_lastInfo) setInfo(_lastInfo);
  }

  /**
   * Patch just the printed tally.
   *
   * Marking one territory does not change a street or a building count, and
   * recomputing those means re-running every point-in-polygon test in the
   * area — seconds of work to move one number by one.
   */
  function setPrintedCount(count) {
    if (!_lastInfo || _lastInfo.clusters == null) return;
    _lastInfo.printed = count;
    setInfo(_lastInfo);
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

  function setInfoFiltered(streets, buildings, clusters, printed) {
    setInfo({
      titleKey: "info.filtered",
      streets: streets,
      buildings: buildings,
      clusters: clusters,
      printed: printed || 0,
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

  /**
   * Whether a dialog owns the screen right now.
   *
   * App.shortcuts asks before dispatching: a modal that shares Enter with the
   * cut tool behind it is not modal. The node itself is exposed for the one
   * caller that re-renders its own dialog in place — the shortcut sheet, which
   * has to redraw when a mode is entered while it is open.
   */
  function isDialogOpen() {
    return !!_dialog;
  }

  function dialogNode() {
    return _dialog;
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

  /**
   * A context menu from a list of items, anywhere on the map.
   *
   * There used to be exactly one of these, hard-wired to a territory, built
   * from a template that spelled out its four entries. Every mode that wanted
   * one — and the modal tools want one badly, because their toolbar sits in a
   * corner while the work happens under the cursor — would have meant another
   * template and another copy of "position it, close it on an outside click".
   * So the shape is the argument now and there is one implementation of the
   * behavior, keyboard navigation included.
   *
   * @param {{x:number, y:number}} point container coordinates
   * @param {Array<{labelKey?:string, label?:string, icon?:string,
   *                danger?:boolean, checked?:boolean, disabled?:boolean,
   *                onlineOnly?:boolean, separator?:boolean,
   *                onClick?:Function}>} items
   *   A `separator: true` entry draws a divider and nothing else.
   * @returns {HTMLElement} the menu root
   */
  function showContextMenu(point, items) {
    closeContextMenu();
    var menu = D.mountOnMap("tpl-context-menu", s.leafletMap);

    (items || []).forEach(function (item) {
      if (!item) return;
      if (item.separator) {
        D.mount("tpl-context-menu-divider", menu);
        return;
      }

      var node = D.mount("tpl-context-menu-item", menu);
      var label = item.labelKey ? App.i18n.t(item.labelKey) : item.label || "";
      if (item.labelKey) {
        var span = D.role(node, "label");
        if (span) span.setAttribute("data-i18n", item.labelKey);
      }
      D.text(node, "label", label);

      var icon = D.role(node, "icon");
      if (icon) icon.className = "fa-solid " + (item.icon || "fa-circle");

      D.toggleClass(node, "delete", !!item.danger);
      D.toggleClass(node, "is-checked", !!item.checked);
      if (item.checked) node.setAttribute("aria-checked", "true");
      if (item.onlineOnly) node.setAttribute("data-online-only", "");

      if (item.disabled) {
        node.setAttribute("aria-disabled", "true");
        node.classList.add("is-disabled");
        return;
      }

      node.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
        if (item.onClick) item.onClick();
      });
    });

    _placeMenu(menu, point);
    _wireMenuKeys(menu);

    s.contextMenu = menu;
    setTimeout(function () {
      document.addEventListener("click", closeContextMenu);
    }, 0);
    return menu;
  }

  /** Keep the menu inside the viewport instead of letting it overflow. */
  function _placeMenu(menu, point) {
    var container = s.leafletMap.getContainer();
    var x = Math.min(point.x, container.clientWidth - menu.offsetWidth - 8);
    var y = Math.min(point.y, container.clientHeight - menu.offsetHeight - 8);
    menu.style.left = Math.max(0, x) + "px";
    menu.style.top = Math.max(0, y) + "px";
  }

  /**
   * role="menu" is a promise about the arrow keys, and the old menu did not
   * keep it: it was mouse-only, which on a touch device with a keyboard and
   * for anyone driving the app from the keyboard meant the entries reachable
   * by right-click were reachable no other way.
   */
  function _wireMenuKeys(menu) {
    var items = [].slice.call(
      menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])'),
    );
    if (!items.length) return;

    items.forEach(function (item, index) {
      item.tabIndex = index === 0 ? 0 : -1;
    });

    function focusAt(index) {
      var next = (index + items.length) % items.length;
      items.forEach(function (item, i) {
        item.tabIndex = i === next ? 0 : -1;
      });
      items[next].focus();
    }

    menu.addEventListener("keydown", function (e) {
      var current = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusAt(current + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusAt(current - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusAt(0);
      } else if (e.key === "End") {
        e.preventDefault();
        focusAt(items.length - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }
    });

    items[0].focus();
  }

  /**
   * The territory menu, expressed in the vocabulary above.
   *
   * Zoom, print, mark and delete are what it always had. Cut and merge are
   * new, and they are the reason this is worth doing at all: both were
   * toolbar-only, which meant "split this one" was a trip to the corner of
   * the screen followed by a hunt for the shape you had just been pointing
   * at. Starting a mode *from* a territory is the same action with the
   * subject already chosen.
   */
  function showPolygonContextMenu(point, layer, feature) {
    // The mark is set for you when a card is produced, so this exists for the
    // two cases the automatic path cannot see: a card printed from somewhere
    // else, and a round starting over. Labelled by current state rather than
    // rendered as a checkbox — a menu item that says what it will do needs no
    // second glance to read.
    var printed = App.polygons.isPrinted(feature);
    var canMerge = !!(s.clusters && s.clusters.length >= 2);

    return showContextMenu(point, [
      {
        labelKey: "menu.zoom",
        icon: "fa-magnifying-glass-plus",
        onClick: function () {
          s.leafletMap.fitBounds(layer.getBounds(), {
            padding: [50, 50],
            maxZoom: 18,
          });
        },
      },
      {
        labelKey: "menu.print",
        icon: "fa-print",
        onlineOnly: true,
        onClick: function () {
          App.print.printCluster(feature);
        },
      },
      {
        labelKey: printed ? "menu.unmarkPrinted" : "menu.markPrinted",
        icon: printed ? "fa-rotate-left" : "fa-circle-check",
        checked: printed,
        onClick: function () {
          App.polygons.markPrinted(feature, !printed);
        },
      },
      { separator: true },
      {
        labelKey: "menu.cut",
        icon: "fa-scissors",
        onClick: function () {
          s.leafletMap.fitBounds(layer.getBounds(), {
            padding: [50, 50],
            maxZoom: 18,
          });
          if (!s.editMode) App.editing.toggleEditMode();
        },
      },
      {
        // Enters merge mode with this one already chosen, which is the half
        // of the gesture the toolbar button cannot know.
        labelKey: "menu.mergeFrom",
        icon: "fa-code-merge",
        disabled: !canMerge,
        onClick: function () {
          App.editing.startMergeWith(layer, feature);
        },
      },
      { separator: true },
      {
        labelKey: "menu.delete",
        icon: "fa-trash",
        danger: true,
        onClick: function () {
          App.polygons.deleteCluster(layer);
        },
      },
    ]);
  }

  function closeContextMenu() {
    if (!s.contextMenu) return;
    D.remove(s.contextMenu);
    s.contextMenu = null;
    document.removeEventListener("click", closeContextMenu);
  }

  function isContextMenuOpen() {
    return !!(s && s.contextMenu);
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
    refreshInfo: refreshInfo,
    setInfoDefault: setInfoDefault,
    setInfoLoaded: setInfoLoaded,
    setInfoFiltered: setInfoFiltered,
    setPrintedCount: setPrintedCount,

    // chrome
    confirm: confirm,
    openDialog: openDialog,
    closeDialog: closeDialog,
    isDialogOpen: isDialogOpen,
    dialogNode: dialogNode,
    showContextMenu: showContextMenu,
    showPolygonContextMenu: showPolygonContextMenu,
    closeContextMenu: closeContextMenu,
    isContextMenuOpen: isContextMenuOpen,
  };
})();

window.App = App;
