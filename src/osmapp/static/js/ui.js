/**
 * ui.js — the single owner of every piece of chrome outside the map:
 * loading overlay, info panel, context menu, modal dialogs.
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

    // The uncovered count zooms to the biggest one rather than opening a
    // list: there are rarely more than a handful, and the useful next move is
    // to go and look at the largest.
    var gaps = D.role(_panel, "gaps-btn");
    if (gaps) {
      gaps.addEventListener("click", function (e) {
        e.preventDefault();
        var found = App.gaps ? App.gaps.features() : [];
        if (!found.length) return;
        var layer = App.geometry.toLayer(found[0].geometry, {});
        if (layer)
          s.leafletMap.fitBounds(layer.getBounds(), {
            padding: [60, 60],
            maxZoom: 17,
          });
      });
    }

    App.i18n.onChange(refreshInfo);

    App._loaded.push("ui");
  }

  function _onKeyDown(e) {
    if (e.key !== "Escape") return;
    // The shortcut sheet stacks on top of whatever is open, so while it is up
    // it is the topmost thing on screen and the one Escape closes. It closes
    // itself; this only has to stand down. Without that, asking for help over
    // the print dialog and pressing Escape would close the print dialog and
    // leave the help sheet describing a screen that is no longer there.
    if (App.shortcuts && App.shortcuts.isSheetOpen && App.shortcuts.isSheetOpen())
      return;
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

  /**
   * Anything past this and a person notices the page stopped answering.
   *
   * The usual figure for "instant" is a tenth of a second; a little over that
   * is the point where the spinner earns the frame it costs to show.
   */
  var SLOW_MS = 120;

  /**
   * Run work that is about to block the page, with the spinner up for it.
   *
   * A synchronous job cannot be preceded by a repaint — the browser draws
   * nothing until the call stack unwinds — so the only way to show anything
   * before a second of geometry is to put the spinner up, hand the frame back,
   * and do the work in the next task. That is what this is: showBusy, a tick,
   * the work, hideOverlay.
   *
   * Which is a bad trade when the work is quick, because the spinner then
   * flashes for one frame and says nothing. So the project decides: how long
   * the last change to the map took is a fair estimate of the next one, and
   * below the threshold this runs the work where it stands and nothing
   * flashes. A five-territory village never sees a spinner; the
   * ninety-nine-territory town sees one every time.
   *
   * @param {string} textKey what to say while it runs
   * @param {function} work the blocking job
   */
  function busy(textKey, work) {
    if (typeof work !== "function") return;
    var cost = App.polygons && App.polygons.lastRefreshMs
      ? App.polygons.lastRefreshMs()
      : 0;
    if (cost < SLOW_MS) {
      work();
      return;
    }

    showBusy(App.i18n.t(textKey));
    // Long enough for the overlay to be painted rather than merely added,
    // which is the same 30 ms every other deferred job in the app buys.
    window.setTimeout(function () {
      try {
        work();
      } finally {
        hideOverlay();
      }
    }, 30);
  }

  function hideOverlay() {
    // Before the spinner comes down, not after. Whatever put it up has just
    // changed the map, and the uncovered remainder is recomputed on a short
    // timer — long enough for the overlay to go first, so a second of
    // arithmetic landed on a page that looked finished and stopped answering.
    // Doing it here costs the same second and spends it under the spinner
    // that is already explaining the wait.
    if (App.gaps && App.gaps.flush) App.gaps.flush();
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

      _syncGaps();
    }

    // hintParams rather than a pre-formatted string: refreshInfo() replays the
    // last payload after a language change, and a string built at call time
    // would come back in the old language.
    var hint = info.hintKey
      ? App.i18n.t(info.hintKey, info.hintParams)
      : info.hint || "";
    D.text(_panel, "hint", hint);
    D.toggleRole(_panel, "hint", !!hint);
  }

  /**
   * A quiet mark next to the count when a territory is worth a second look —
   * one too small to see at this zoom, one drawn in more than one piece, one
   * with no buildings in it at all. The first two explain a count that
   * disagrees with what the map shows: without the mark the number looks
   * wrong, with it the number looks explained. The third explains nothing and
   * is the one that matters most, because an empty territory looks entirely
   * ordinary right up until somebody is handed the card. All three are one
   * click away in the list, which is also where they can be repaired.
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

  /**
   * The uncovered count, shown only when it is not zero.
   *
   * Unlike every other row here, the interesting value is the one that means
   * something is wrong — so an empty answer is an absent row rather than a
   * "0". Nobody needs to be told that the area is fully covered; that is what
   * finished looks like.
   */
  function _syncGaps() {
    var count = App.gaps ? App.gaps.count() : 0;
    D.toggleRole(_panel, "gaps-row", count > 0);
    if (count > 0) D.text(_panel, "gaps", count);
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
      // The one place in the app that named a key in prose, and it named the
      // wrong one on a Mac. App.shortcuts already knows how to draw a combo
      // for the keyboard in front of the user.
      hintParams: { key: App.shortcuts.hint("Mod+Z") },
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
  var _veil = null;

  /**
   * Dialogs that bring their own way out and would be worse for a second one.
   *
   * The shortcut sheet *is* the help, and a confirm is one sentence with two
   * buttons — a "?" on either would point at itself or at nothing.
   */
  var NO_HELP = { "tpl-shortcuts-dialog": true, "tpl-confirm-dialog": true };

  function openDialog(templateId, onClose) {
    closeDialog();
    _dialogOnClose = onClose || null;
    // Before the dialog, so DOM order agrees with the z-index rather than
    // relying on it alone.
    _veil = D.mountOnMap("tpl-dialog-veil", s.leafletMap);
    _dialog = D.mountOnMap(templateId, s.leafletMap);
    if (!NO_HELP[templateId]) addHelpButton(_dialog);
    trapFocus(_dialog);
    return _dialog;
  }

  function closeDialog() {
    var teardown = _dialogOnClose;
    _dialogOnClose = null;
    _dialog = D.remove(_dialog);
    _veil = D.remove(_veil);
    if (teardown) teardown();
  }

  /**
   * The "?" every mode bar has advertised on its hint banner, given to the
   * screens that have no banner.
   *
   * The key has worked inside dialogs since App.shortcuts learned about
   * `overModal`, but nothing on screen said so — which made it a shortcut for
   * people who had already read the shortcut list. Public because the PDF
   * placement frame mounts itself rather than going through openDialog: it
   * stacks over the print dialog, and openDialog would close the thing it is
   * stacking over.
   */
  function addHelpButton(dialog) {
    if (!dialog || dialog.querySelector(".app-dialog__help")) return null;
    var button = D.render("tpl-dialog-help");
    button.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      App.shortcuts.toggleSheet();
    });
    dialog.appendChild(button);
    return button;
  }

  var FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Keep Tab inside the dialog.
   *
   * aria-modal="true" is a claim about where focus can go, and it was only
   * ever true of the mouse: Tab walked straight out of the print dialog into
   * the toolbar behind it, where every button was still live. The veil covers
   * the mouse; this covers the keyboard.
   *
   * Nothing here answers Escape — App.shortcuts owns that, and a second
   * listener would close two things per press.
   */
  function trapFocus(dialog) {
    dialog.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var items = [].slice
        .call(dialog.querySelectorAll(FOCUSABLE))
        .filter(function (node) {
          return node.offsetParent !== null || node === document.activeElement;
        });
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      // Focus outside the dialog entirely — the map took it, or nothing has
      // it yet — comes back to the top rather than continuing round the page.
      if (dialog.contains(document.activeElement)) {
        if (!e.shiftKey && document.activeElement !== last) return;
        if (e.shiftKey && document.activeElement !== first) return;
      }
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    });
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
   * `altKey` adds a third button and makes the answer a string rather than a
   * boolean. Existing callers pass no altKey, never see one, and keep the
   * boolean they were written against — but a caller that does pass one must
   * test for `=== "alt"` before testing truthiness, because "alt" is truthy.
   * The one question that needs three answers is "replace this boundary?",
   * where the third is "edit the one I have".
   *
   * @param {{titleKey?:string, title?:string,
   *          messageKey?:string, message?:string,
   *          detail?:string,
   *          okKey?:string, cancelKey?:string, altKey?:string,
   *          danger?:boolean}} opts
   * @returns {Promise<boolean|"alt">}
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
        App.shortcuts.pop("confirm");
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

      var alt = D.role(dialog, "alt");
      D.toggleRole(dialog, "alt", !!opts.altKey);
      if (opts.altKey && alt) {
        alt.textContent = App.i18n.t(opts.altKey);
        D.onRole(dialog, "alt", function () {
          finish("alt");
          closeDialog();
        });
      }

      D.onRole(dialog, "cancel", function () {
        closeDialog();
      });
      function accept() {
        finish(true);
        closeDialog();
      }
      D.onRole(dialog, "ok", accept);

      // Enter accepts, Escape declines. Both go through the registry now
      // rather than through a listener on the dialog node: a prompt whose two
      // keys are invisible to the sheet is a prompt where "?" lists the keys
      // of the tool underneath and says nothing about the question actually
      // on screen.
      App.shortcuts.push({
        id: "confirm",
        titleKey: "shortcuts.groupConfirm",
        exclusive: true,
        entries: [
          {
            combos: ["Enter"],
            labelKey: "shortcuts.confirmOk",
            whileTyping: true,
            run: accept,
          },
          {
            combos: ["Escape"],
            labelKey: "shortcuts.confirmCancel",
            whileTyping: true,
            run: closeDialog,
          },
        ],
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
   * @returns {HTMLElement|null} the menu root, or null while a dialog owns
   *   the screen
   */
  function showContextMenu(point, items) {
    // --z-menu is below --z-dialog, so a menu opened while a dialog is up
    // renders behind it: invisible, and still holding the document click
    // listener that swallows the next click anywhere. The veil stops the
    // pointer from reaching the map at all, but the tour opens menus
    // programmatically and print.js mounts the placement frame outside
    // openDialog, so the rule is stated here rather than left to geometry.
    if (isDialogOpen()) return null;
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
        console.time(label);
        if (item.onClick) item.onClick();
        console.timeEnd(label);
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
        // Not onlineOnly. The card is composed in the browser now, and the
        // basemap under it comes from the service worker's tile cache.
        labelKey: "menu.print",
        icon: "fa-print",
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

  /**
   * The boundary's own menu.
   *
   * Everything here was reachable only from the toolbar, and only by somebody
   * who already knew which of the four buttons in the Area group acted on the
   * outline. Reshaping in particular had no entry point at all — the boundary
   * was write-once, so the correction for a corner in the wrong place was to
   * draw the whole thing again and re-download for it.
   */
  function showOuterContextMenu(point, layer) {
    return showContextMenu(point, [
      {
        labelKey: "menu.editOutline",
        icon: "fa-vector-square",
        onClick: function () {
          App.outline.toggle();
        },
      },
      {
        labelKey: "menu.zoomOuter",
        icon: "fa-magnifying-glass-plus",
        onClick: function () {
          s.leafletMap.fitBounds(layer.getBounds(), { padding: [50, 50] });
        },
      },
      { separator: true },
      {
        // Every Area-group action was here except the one that comes next in
        // the workflow, which meant the boundary's own menu stopped exactly
        // where the boundary stops being the subject — and the step people
        // are looking for right after drawing one was the trip to the corner.
        labelKey: "menu.partition",
        icon: "fa-shapes",
        disabled: !(s.cachedStreets && s.cachedStreets.features),
        onClick: function () {
          App.clustering.showClusterDialog();
        },
      },
      {
        labelKey: "menu.trimOuter",
        icon: "fa-compress",
        disabled: !(
          s.cachedBuildings &&
          s.cachedBuildings.features &&
          s.cachedBuildings.features.length
        ),
        onClick: function () {
          App.trim.toggle();
        },
      },
      {
        labelKey: "menu.refetchOuter",
        icon: "fa-cloud-arrow-down",
        onlineOnly: true,
        onClick: function () {
          App.data.confirmAndFetch(layer.toGeoJSON(), { force: true });
        },
      },
    ]);
  }

  /**
   * The menu for empty ground.
   *
   * Every showContextMenu() call site needed something under the cursor — a
   * territory, a building, the boundary — so a right-click on bare map fell
   * through to the browser's own menu. Two of the mode hints already promised
   * otherwise ("Right-click for the menu"), and the modes whose menu is the
   * only place some of their actions live were the ones you had to know to
   * aim at a shape to reach.
   *
   * Kept short on purpose: this is the menu with no subject, so it holds the
   * things that have no subject either.
   */
  function showMapContextMenu(point) {
    var hasBoundary = !!s.outerPolygonLayer;
    var hasData = !!(s.cachedStreets && s.cachedStreets.features);
    return showContextMenu(point, [
      {
        labelKey: hasBoundary ? "menu.editOutline" : "menu.mapDraw",
        icon: hasBoundary ? "fa-vector-square" : "fa-draw-polygon",
        onClick: function () {
          if (hasBoundary) App.outline.toggle();
          else s.leafletMap.editTools.startPolygon();
        },
      },
      {
        labelKey: "menu.partition",
        icon: "fa-shapes",
        disabled: !(hasBoundary && hasData),
        onClick: function () {
          App.clustering.showClusterDialog();
        },
      },
      { separator: true },
      {
        labelKey: "menu.mapShortcuts",
        icon: "fa-keyboard",
        onClick: function () {
          App.shortcuts.toggleSheet();
        },
      },
      {
        labelKey: "menu.mapTour",
        icon: "fa-circle-question",
        onClick: function () {
          App.tour.start();
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
    busy: busy,
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
    addHelpButton: addHelpButton,
    showContextMenu: showContextMenu,
    showPolygonContextMenu: showPolygonContextMenu,
    showOuterContextMenu: showOuterContextMenu,
    showMapContextMenu: showMapContextMenu,
    closeContextMenu: closeContextMenu,
    isContextMenuOpen: isContextMenuOpen,
  };
})();

window.App = App;
