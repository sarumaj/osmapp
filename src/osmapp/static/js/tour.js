/**
 * tour.js — the first-run walkthrough.
 *
 * The app is a workflow, not a set of buttons: search a place, take its
 * boundary, download the data, split it into territories, correct the split by
 * hand, print a card. Every one of those steps is discoverable on its own, and
 * none of them explains the order. This module says the order out loud, once,
 * and then gets out of the way.
 *
 * Design decisions worth keeping:
 *
 *   • The user watches; the tour drives. Asking someone to perform each step
 *     needs the app to be in a particular state to continue, and there is no
 *     such state on a first visit — no boundary, no data, no territories. So
 *     the veil swallows clicks throughout, and where a step is about a screen
 *     that only exists once there is work loaded, the tour loads a sample area
 *     (see demo.js) and opens the real dialog on it. Nothing the user does can
 *     leave the app half-edited, because the user does nothing.
 *
 *   • Every side effect is declared, and undone by the same machinery in both
 *     directions. A step's enter() runs on arrival and its exit() on leaving,
 *     forwards or backwards; `demo: true` says "this step needs the sample
 *     loaded" and the sample is swapped in and out by comparing that flag
 *     between the step being left and the step being entered. Nothing has to
 *     remember to clean up after itself, which is the only way a walkthrough
 *     that can be abandoned at any point with Escape stays safe.
 *
 *   • A step whose target is missing still runs. The geocoder is skipped when
 *     the plugin failed to load, but everything else falls back to a centred
 *     card, because a walkthrough that silently loses four steps on a narrow
 *     screen teaches a wrong mental model of what the app has.
 *
 *   • Every screen that the app opens for you is introduced by the control
 *     that opens it. A step that shows the partition dialog without ever
 *     pointing at the Split button has explained what the dialog does and
 *     left out the only part the user has to reproduce afterwards — and
 *     "where was that again?" is the question a walkthrough exists to
 *     prevent. So the modal features come in pairs: one step spotlights the
 *     button, the next shows what it opened, and that second step keeps a
 *     quieter ring on the button (`origin`) so the two stay visibly joined.
 *
 *   • The steps are data. STEPS below is the only place the sequence exists;
 *     tests read it to check that every key it names is in the dictionary.
 *
 *   • Suppression is a single localStorage flag, written the moment the
 *     checkbox is touched rather than on exit, so closing the tab counts.
 *     Storage that throws — Firefox in private mode — means the tour opens
 *     again next time, which is the harmless direction to fail in.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.tour = (function () {
  "use strict";

  var D = null;
  var T = null;

  /** "1" means: do not open by itself again. */
  var SEEN_KEY = "osmapp.tour.seen.v1";

  var GAP = 14; // bubble-to-spotlight distance
  var EDGE = 12; // smallest gap to the viewport edge
  var PAD = 6; // how far the spotlight is inflated past its target

  var _root = null;
  var _bubble = null;
  var _spot = null;
  var _origin = null;
  var _index = 0;
  var _entered = -1; // index whose enter() has run and whose exit() is owed
  var _steps = [];
  var _keyBound = false;
  var _restoreCollapsed = null;

  // ══════════════════════════════════════════════════════════════════════
  // CONTENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @type {Array<{id:string, target?:string, origin?:string, placement?:string,
   *               highlight?:string, dock?:string, demo?:boolean,
   *               skipIfNoTarget?:boolean, reopenIfGone?:boolean,
   *               available?:Function, enter?:Function, exit?:Function}>}
   *
   *   target      CSS selector, resolved at the moment the step is shown — so
   *               a control rebuilt by a language change is still found, and a
   *               dialog this step's own enter() just opened is too.
   *   origin      CSS selector for the control that opened what `target`
   *               points at. Drawn as a second, quieter ring, so the answer to
   *               "and how do I get back here?" is on screen rather than in
   *               the prose. Only meaningful on "ring" steps: on a dimmed one
   *               the origin would be a ring round something the dim has
   *               already put in the dark.
   *   highlight   "dim" (default) cuts the target out of a darkened screen;
   *               "ring" outlines it and dims nothing. Dialog steps use the
   *               ring: a print dialog that fills the viewport has nothing to
   *               dim around it, and darkening the dialog itself would hide
   *               the thing being described.
   *   dock        pins the bubble to a viewport corner instead of placing it
   *               beside the target. For targets too large to sit next to.
   *   demo        this step needs the sample area from demo.js.
   *   enter/exit  side effects, run on arrival and departure in both
   *               directions. Anything opened here must be closed there.
   */
  var STEPS = [
    { id: "welcome" },
    // Named before anything inside it is pointed at. Nine of the steps below
    // spotlight one button in this panel, and a lit rectangle is much easier
    // to place once the thing it is cut out of has been introduced.
    { id: "toolbar", target: ".tb-panel", placement: "right" },
    {
      id: "search",
      target: ".leaflet-control-geocoder",
      placement: "bottom",
      skipIfNoTarget: true,
    },
    { id: "draw", target: '[data-action="draw"]', placement: "right" },
    { id: "locate", target: '[data-action="locate"]', placement: "right" },
    { id: "refetch", target: '[data-action="refetch"]', placement: "right" },

    // ── The sample block ────────────────────────────────────────────────
    // Everything from here to "restore" runs on a village that does not
    // exist. Whatever the user had is snapshotted on the way in and put back
    // on the way out — including when the tour is abandoned mid-block.
    //
    // The pairs start here. Each of the four things the app opens for you —
    // the partition dialog, the cut bar, the merge bar, the print view — is
    // preceded by the control that opens it, and then keeps a ring on that
    // control while the screen itself is being explained.
    { id: "sample", demo: true },
    // Before the partitioner, because that is the order it belongs in: the
    // boundary is reshaped once, and then divided. A walkthrough that
    // introduced trimming after splitting would be teaching people to redo
    // their own work.
    {
      id: "trimButton",
      demo: true,
      target: '[data-action="trim"]',
      placement: "right",
    },
    {
      id: "trim",
      demo: true,
      target: ".trim-toolbar",
      placement: "top",
      highlight: "ring",
      origin: '[data-action="trim"]',
      enter: function () {
        if (!App.state.trimMode) App.trim.toggle();
      },
      exit: function () {
        if (App.state.trimMode) App.trim.toggle();
      },
    },
    {
      // The marks are the half of the tool that is a conversation rather than
      // a setting, and they only exist once something has been excluded — so
      // this step comes after the bar has opened and the automatic pass has
      // run on the sample's outlying farms.
      id: "trimMarks",
      demo: true,
      target: ".trim-marker",
      placement: "bottom",
      highlight: "ring",
      origin: '[data-action="trim"]',
      skipIfNoTarget: true,
      enter: function () {
        if (!App.state.trimMode) App.trim.toggle();
      },
      exit: function () {
        if (App.state.trimMode) App.trim.toggle();
      },
    },
    {
      // The boundary is not write-once, and the only two places that said so
      // were a clause at the end of the "draw" step and a right-click nobody
      // has a reason to try. A modal tool with its own toolbar, its own undo
      // scope and its own refetch prompt was reachable only by accident.
      id: "outlineButton",
      demo: true,
      target: '[data-action="draw"]',
      placement: "right",
    },
    {
      id: "outline",
      demo: true,
      target: ".outline-toolbar",
      placement: "top",
      highlight: "ring",
      origin: '[data-action="draw"]',
      enter: function () {
        if (!App.state.outlineMode) App.outline.toggle();
      },
      exit: function () {
        // cancel() rather than toggle(): the walkthrough must not leave the
        // sample's boundary carrying whatever the demonstration did to it.
        if (App.state.outlineMode) App.outline.cancel();
      },
    },
    {
      id: "partitionButton",
      demo: true,
      target: '[data-action="partition"]',
      placement: "right",
    },
    {
      id: "partition",
      demo: true,
      target: ".cluster-dialog",
      placement: "right",
      highlight: "ring",
      origin: '[data-action="partition"]',
      enter: function () {
        App.clustering.showClusterDialog();
      },
      exit: function () {
        App.ui.closeDialog();
      },
    },
    {
      id: "cutButton",
      demo: true,
      target: '[data-action="cut"]',
      placement: "right",
    },
    {
      id: "cut",
      demo: true,
      target: ".cut-toolbar",
      placement: "top",
      highlight: "ring",
      // The same button, now lit: the ring is what connects "I pressed that"
      // to "this bar appeared", and it is also where you press to leave.
      origin: '[data-action="cut"]',
      enter: function () {
        if (!App.state.editMode) App.editing.toggleEditMode();
      },
      exit: function () {
        if (App.state.editMode) App.editing.toggleEditMode();
      },
    },
    {
      id: "mergeButton",
      demo: true,
      target: '[data-action="merge"]',
      placement: "right",
    },
    {
      id: "merge",
      demo: true,
      target: ".merge-toolbar",
      placement: "top",
      highlight: "ring",
      origin: '[data-action="merge"]',
      enter: function () {
        if (!App.state.mergeMode) App.editing.toggleMergeMode();
      },
      exit: function () {
        if (App.state.mergeMode) App.editing.toggleMergeMode();
      },
    },
    {
      id: "numbers",
      demo: true,
      target: '[data-action="numbers"]',
      placement: "right",
    },
    {
      // The one feature on the layer switcher that is not a layer: it finds
      // ground that belongs to no territory, which is the failure the rest of
      // the app cannot show you because nothing looks wrong when it happens.
      id: "gaps",
      demo: true,
      target: ".leaflet-control-layers",
      placement: "left",
      skipIfNoTarget: true,
    },
    {
      id: "territory",
      demo: true,
      target: ".polygon-context-menu",
      placement: "right",
      highlight: "ring",
      // ui.js closes the menu on the next document click, and the veil is a
      // document. Rather than fight that, the step puts the menu back.
      reopenIfGone: true,
      enter: _openSampleMenu,
      exit: function () {
        App.ui.closeContextMenu();
      },
    },
    {
      // The print view is the one screen with no button in the toolbar, so
      // without this step it arrives from nowhere. The menu is already open
      // from the step before; this one narrows the ring to the entry that
      // opens the card.
      id: "printMenu",
      demo: true,
      target: '.polygon-context-menu-item[data-role="print"]',
      placement: "right",
      highlight: "ring",
      reopenIfGone: true,
      available: _online,
      enter: _openSampleMenu,
      exit: function () {
        App.ui.closeContextMenu();
      },
    },
    {
      id: "print",
      demo: true,
      target: ".print-controls",
      dock: "bottom-left",
      highlight: "ring",
      // The preview composes itself from live tiles. Offline it would open on
      // an error message, which teaches the wrong thing about the feature.
      available: _online,
      enter: function () {
        var entry = App.demo.firstCluster();
        if (entry) App.print.printCluster(entry.feature);
      },
      exit: function () {
        if (App.print.isOpen()) App.print.close();
      },
    },
    {
      // Follows the print step because that is where the green fill and the
      // tick were just explained. The sample ships with one territory already
      // marked, so the button is live rather than greyed out while the step
      // that describes it is on screen.
      id: "clearPrinted",
      demo: true,
      target: '[data-action="clear-printed"]',
      placement: "right",
    },
    { id: "restore" },
    // ── back to the user's own map ──────────────────────────────────────

    { id: "history", target: '[data-action="undo"]', placement: "right" },
    {
      id: "layers",
      target: ".leaflet-control-layers",
      placement: "left",
      skipIfNoTarget: true,
    },
    { id: "info", target: "#info-panel", placement: "left" },
    { id: "files", target: '[data-action="export"]', placement: "right" },
    // Export and Import were one step pointing at Export, which is half a
    // step: the half that gets you a file, not the half that gets it back.
    { id: "importFiles", target: '[data-action="import"]', placement: "right" },
    { id: "reset", target: '[data-action="reset"]', placement: "right" },
    { id: "language", target: ".tb-item--select", placement: "right" },
    { id: "offline" },
    {
      // The tour answers "what is this app for" once. This answers "what can
      // I press right now", which is the question that comes up every time
      // after that — and its button was the only one in the panel that no
      // step pointed at.
      id: "shortcuts",
      target: '[data-action="shortcuts"]',
      placement: "right",
    },
    { id: "done", target: '[data-action="help"]', placement: "right" },
  ];

  /**
   * Steps that would open on an error message rather than on the feature.
   *
   * Both the print entry in the context menu and the print view itself need
   * tiles to compose a card, so offline they are dropped together — leaving
   * one of the pair in would introduce a button whose screen never comes.
   */
  function _online() {
    return navigator.onLine !== false;
  }

  /** Right-click a sample territory, without anybody having to right-click. */
  function _openSampleMenu() {
    var entry = App.demo && App.demo.firstCluster();
    if (!entry) return;
    var map = App.state.leafletMap;
    try {
      var at = entry.layer.getBounds().getCenter();
      App.ui.showPolygonContextMenu(
        map.latLngToContainerPoint(at),
        entry.layer,
        entry.feature,
      );
    } catch (e) {
      console.warn(">>> Could not open the sample context menu:", e.message);
    }
  }

  function _titleKey(step) {
    return "tour.steps." + step.id + ".title";
  }

  function _bodyKey(step) {
    return "tour.steps." + step.id + ".body";
  }

  // ══════════════════════════════════════════════════════════════════════
  // SUPPRESSION
  // ══════════════════════════════════════════════════════════════════════

  function isSuppressed() {
    // No storage means no memory of a previous visit, so the tour offers
    // itself again. Annoying at worst; the alternative is never showing it.
    return App.util.readLocal(SEEN_KEY, null) === "1";
  }

  function setSuppressed(suppressed) {
    if (suppressed) App.util.writeLocal(SEEN_KEY, "1");
    else App.util.removeLocal(SEEN_KEY);
  }

  /**
   * `?tour=1` forces it open and `?tour=0` forces it shut, whatever the flag
   * says. That is how the tour gets linked to from a README or a support
   * message without asking anyone to clear their site data first.
   */
  function _override() {
    var search = String(
      (window.location && window.location.search) || "",
    ).toLowerCase();
    if (search.indexOf("tour=1") >= 0) return true;
    if (search.indexOf("tour=0") >= 0) return false;
    return null;
  }

  function shouldAutoStart() {
    var forced = _override();
    if (forced !== null) return forced;
    return !isSuppressed();
  }

  // ══════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════

  function init() {
    D = App.dom;
    T = App.i18n.t;

    // Language can change while the tour is open — it is one of the steps.
    App.i18n.onChange(function () {
      if (_root) _render();
    });

    App._loaded.push("tour");
  }

  /**
   * Open the tour unless something else is already talking to the user.
   *
   * The boundary suggestion dialog can appear a moment after start-up when a
   * session is restored, and two modal things at once is worse than a tour
   * nobody sees. The flag is untouched, so the next visit tries again.
   */
  function maybeAutoStart() {
    if (!shouldAutoStart()) return false;
    if (_busyElsewhere()) return false;
    start();
    return true;
  }

  function _busyElsewhere() {
    if (App.print && App.print.isOpen()) return true;
    if (document.querySelector(".app-dialog")) return true;
    var overlay = document.getElementById("loading-overlay");
    return !!(overlay && !overlay.hasAttribute("hidden"));
  }

  function isOpen() {
    return _root !== null;
  }

  function start(index) {
    if (_root) stop();

    _steps = STEPS.filter(function (step) {
      if (step.available && !step.available()) return false;
      if (step.demo && !App.demo) return false;
      return !(step.skipIfNoTarget && !_resolve(step));
    });
    if (_steps.length === 0) return;

    _index = Math.min(Math.max(index || 0, 0), _steps.length - 1);
    _entered = -1;

    _root = D.mount("tpl-tour", document.body);
    _bubble = D.role(_root, "bubble");
    _spot = D.role(_root, "spot");
    _origin = D.role(_root, "origin");

    // Icon-only buttons are a poor thing to point at while explaining what
    // they do. The previous state is put back on the way out.
    if (App.controls && App.controls.isCollapsed) {
      _restoreCollapsed = App.controls.isCollapsed();
      if (_restoreCollapsed) App.controls.setCollapsed(false);
    }

    // Checked by default: having seen the tour, the normal wish is not to be
    // shown it again. Clearing it is what "show me this next time" means, and
    // it is written straight through rather than on exit so that closing the
    // tab still honours the answer.
    var mute = D.role(_root, "mute");
    if (mute) {
      mute.checked = true;
      mute.addEventListener("change", function () {
        setSuppressed(mute.checked);
      });
    }

    D.onRole(_root, "next", _next);
    D.onRole(_root, "back", _back);
    D.onRole(_root, "skip", stop);

    if (!_keyBound) {
      // Capture: ui.js also listens for Escape on the document, and the tour
      // must be the one that answers while it is on screen.
      document.addEventListener("keydown", _onKeyDown, true);
      _keyBound = true;
    }
    window.addEventListener("resize", _reposition);
    window.addEventListener("scroll", _reposition, true);

    _show(_index, 1);
    _bubble.focus();
  }

  function stop() {
    if (!_root) return;

    // Reaching the end or leaving early both count as "seen", unless the
    // checkbox was cleared on the way past.
    var mute = D.role(_root, "mute");
    setSuppressed(!mute || mute.checked);

    // Before the DOM goes: the current step still owns a dialog or a mode.
    _exitStep();
    _cleanup();

    if (_keyBound) {
      document.removeEventListener("keydown", _onKeyDown, true);
      _keyBound = false;
    }
    window.removeEventListener("resize", _reposition);
    window.removeEventListener("scroll", _reposition, true);

    if (_restoreCollapsed && App.controls && App.controls.setCollapsed) {
      App.controls.setCollapsed(true);
    }
    _restoreCollapsed = null;

    _root = D.remove(_root);
    _bubble = null;
    _spot = null;
    _origin = null;
    _steps = [];
    _index = 0;
    _entered = -1;
  }

  /**
   * The safety net.
   *
   * Every step undoes its own work in exit(), so in the ordinary case this
   * finds nothing to do. It exists for the ones that are not ordinary: a step
   * whose enter() threw halfway, a dialog closed by something else, a tour
   * abandoned with Escape while the print view was still composing. Each check
   * is a no-op when there is nothing to close, so running it twice is free —
   * and running it one time too few is how someone's afternoon disappears.
   */
  function _cleanup() {
    try {
      if (App.print && App.print.isOpen()) App.print.close();
      if (App.ui) {
        App.ui.closeDialog();
        App.ui.closeContextMenu();
      }
      if (App.state && App.editing) {
        if (App.state.editMode) App.editing.toggleEditMode();
        if (App.state.mergeMode) App.editing.toggleMergeMode();
      }
    } catch (e) {
      console.warn(">>> Tour cleanup:", e && e.message);
    }
    // Last, and unconditional: this is the one that puts the work back.
    if (App.demo) App.demo.leave();
  }

  function _next() {
    _show(_index + 1, 1);
  }

  function _back() {
    if (_index === 0) return;
    _show(_index - 1, -1);
  }

  // ══════════════════════════════════════════════════════════════════════
  // TRANSITIONS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Leave the current step and arrive at `index`, in direction `dir`.
   *
   * The order is exit, then sample, then enter, then measure — and each of
   * those depends on the one before it. The print dialog has to close before
   * the territory it is printing is taken away; the sample has to be loaded
   * before the partition dialog can find any data to offer; and the spotlight
   * cannot be measured until the dialog it is pointing at has a box, which is
   * a frame later.
   *
   * A step that cannot have its sample loaded is skipped in whichever
   * direction we were already travelling, rather than stalling there.
   */
  function _show(index, dir) {
    _exitStep();
    dir = dir || 1;

    while (index >= 0 && index < _steps.length) {
      if (_syncSample(_steps[index])) break;
      index += dir;
    }
    if (index < 0 || index >= _steps.length) {
      stop();
      return;
    }

    _index = index;
    var step = _steps[_index];
    if (step.enter) {
      try {
        step.enter();
      } catch (e) {
        console.warn(">>> Tour step " + step.id + " could not open:", e.message);
      }
    }
    _entered = _index;

    _render();
    // A dialog mounted a moment ago has a zero-sized box until layout runs.
    requestAnimationFrame(function () {
      if (_root) _reposition();
    });
  }

  function _exitStep() {
    if (_entered < 0) return;
    var step = _steps[_entered];
    _entered = -1;
    if (!step || !step.exit) return;
    try {
      step.exit();
    } catch (e) {
      console.warn(">>> Tour step " + step.id + " could not close:", e.message);
    }
  }

  /**
   * Match the sample's presence to what this step wants.
   *
   * Declarative rather than a pair of hooks on the first and last steps of the
   * block, because that pair only works travelling forwards. Comparing a flag
   * means stepping backwards out of the block unloads the sample and stepping
   * back into it reloads it, with no extra code for the second case.
   *
   * @returns {boolean} whether the step can be shown at all
   */
  function _syncSample(step) {
    var wants = !!step.demo;
    if (!App.demo) return !wants;
    if (!wants) {
      App.demo.leave();
      return true;
    }
    // False when the app could not be snapshotted — better to skip the sample
    // steps than to open dialogs over work we cannot promise to give back.
    return App.demo.enter();
  }

  function _isBubbleControl(node) {
    if (!node || !_bubble || !_bubble.contains(node)) return false;
    return /^(BUTTON|INPUT|A|SELECT)$/.test(node.tagName || "");
  }

  function _onKeyDown(e) {
    if (!_root) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stop();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "Enter") {
      // Enter on a focused control means that control — the dot you tabbed
      // to, Back, the checkbox — not "next step". Anywhere else it is the
      // fastest way through the tour and stays that way.
      if (e.key === "Enter" && _isBubbleControl(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      _next();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      _back();
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════

  function _resolve(step) {
    return step.target ? _find(step.target) : null;
  }

  function _find(selector) {
    var node = document.querySelector(selector);
    if (!node || !node.getBoundingClientRect) return null;
    var rect = node.getBoundingClientRect();
    // A control that is present but has no box — a collapsed panel, a
    // display:none branch — is not something worth pointing at.
    return rect.width > 0 && rect.height > 0 ? node : null;
  }

  function _render() {
    if (!_root) return;
    var step = _steps[_index];

    D.text(_root, "title", T(_titleKey(step)));
    D.text(_root, "body", T(_bodyKey(step)));
    D.text(
      _root,
      "counter",
      T("tour.progress", { index: _index + 1, total: _steps.length }),
    );

    var back = D.role(_root, "back");
    if (back) {
      D.toggleClass(back, "is-disabled", _index === 0);
      back.setAttribute("aria-disabled", String(_index === 0));
    }

    var next = D.role(_root, "next");
    if (next) {
      var last = _index === _steps.length - 1;
      next.setAttribute("data-i18n", last ? "tour.finish" : "tour.next");
      next.textContent = T(last ? "tour.finish" : "tour.next");
    }

    _renderDots();
    _reposition();
  }

  /**
   * Progress, and a way back to a step that went past too fast.
   *
   * The dots were decoration until the walkthrough grew a step for every
   * button; at this length "wait, what was the one before the dialog?" is a
   * fair question, and answering it with six presses of Back is not an
   * answer. Each dot carries its step's title as a tooltip, so the row also
   * doubles as a table of contents. Jumping goes through _show() like
   * everything else, so the sample is loaded or dropped and the dialogs are
   * opened or closed on the way, however far the jump reaches.
   */
  function _renderDots() {
    var host = D.role(_root, "dots");
    if (!host) return;

    // Every dot is replaced on each render, so a jump made from the keyboard
    // would otherwise drop focus onto <body> and leave Tab starting over.
    var wasFocused = host.contains(document.activeElement);

    host.textContent = "";
    for (var i = 0; i < _steps.length; i++) {
      host.appendChild(_makeDot(i));
    }
    if (wasFocused && host.children[_index]) host.children[_index].focus();
  }

  function _makeDot(index) {
    var dot = document.createElement("button");
    dot.type = "button";
    dot.className =
      "tour__dot" +
      (index === _index ? " is-current" : index < _index ? " is-done" : "");

    var title = T(_titleKey(_steps[index]));
    dot.title = title;
    dot.setAttribute("aria-label", title);
    if (index === _index) dot.setAttribute("aria-current", "step");

    dot.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (index !== _index) _show(index, index > _index ? 1 : -1);
    });
    return dot;
  }

  function _reposition() {
    if (!_root) return;
    var step = _steps[_index];
    var node = _resolve(step);

    // Something closed the thing this step is pointing at — the context menu
    // dismissing itself on a click at the veil is the case this exists for.
    // One retry, so a target that genuinely cannot open does not spin.
    if (!node && step.reopenIfGone && step.enter) {
      try {
        step.enter();
      } catch (e) {
        /* the fallback below already handles a missing target */
      }
      node = _resolve(step);
    }

    var rect = node ? node.getBoundingClientRect() : null;
    _placeSpot(rect, step);
    _placeOrigin(step);
    _placeBubble(rect, step);
  }

  /**
   * The second ring: the control that opened what this step is describing.
   *
   * Deliberately quieter than the spotlight — it is context, not the subject,
   * and two rings of equal weight would just be two things to look at. Absent
   * when the step names no origin, and absent when it names one that is not on
   * screen, which is the case for a toolbar hidden behind the print view.
   */
  function _placeOrigin(step) {
    if (!_origin) return;
    var node = step.origin ? _find(step.origin) : null;
    if (!node) {
      D.toggle(_origin, false);
      return;
    }
    var rect = node.getBoundingClientRect();
    _origin.style.left = Math.max(0, rect.left - PAD) + "px";
    _origin.style.top = Math.max(0, rect.top - PAD) + "px";
    _origin.style.width = rect.width + PAD * 2 + "px";
    _origin.style.height = rect.height + PAD * 2 + "px";
    D.toggle(_origin, true);
  }

  /**
   * @param {Object} step "ring" outlines the target and dims nothing; the
   *   default cuts it out of a darkened screen. A dialog that fills the
   *   viewport has nothing left to dim around it, and dimming the dialog
   *   itself would hide the subject of the step.
   */
  function _placeSpot(rect, step) {
    if (!_spot) return;
    var ring = step.highlight === "ring";
    _spot.classList.toggle("tour__spot--ring", ring);

    if (!rect && ring) {
      // Nothing to outline, and no dimming was wanted. Show nothing rather
      // than a stray rectangle in the middle of the screen.
      D.toggle(_spot, false);
      return;
    }
    if (!rect) {
      // No hole: the shadow still dims, so the screen does not flash between
      // a targeted step and a centred one.
      _spot.classList.add("tour__spot--none");
      _spot.style.left = "50%";
      _spot.style.top = "50%";
      _spot.style.width = "0px";
      _spot.style.height = "0px";
      D.toggle(_spot, true);
      return;
    }
    _spot.classList.remove("tour__spot--none");
    _spot.style.left = Math.max(0, rect.left - PAD) + "px";
    _spot.style.top = Math.max(0, rect.top - PAD) + "px";
    _spot.style.width = rect.width + PAD * 2 + "px";
    _spot.style.height = rect.height + PAD * 2 + "px";
    D.toggle(_spot, true);
  }

  /**
   * Preferred side first, then the other three, then the middle of the screen.
   *
   * Sides are tried rather than computed because the bubble's height depends
   * on how long the translated body turned out to be — German runs a third
   * longer than English, and a layout that fits in one language and overflows
   * in another is the usual way this kind of thing breaks.
   */
  function _placeBubble(rect, step) {
    if (!_bubble) return;

    var box = _bubble.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    // A target the size of the print dialog has no free side to sit beside,
    // so the step names a corner instead and the bubble floats over it.
    if (step.dock) {
      var at = _dock(step.dock, box, vw, vh);
      _bubble.style.left = Math.round(at.left) + "px";
      _bubble.style.top = Math.round(at.top) + "px";
      return;
    }

    if (!rect) {
      _bubble.style.left = Math.round((vw - box.width) / 2) + "px";
      _bubble.style.top = Math.round((vh - box.height) / 2) + "px";
      return;
    }

    var order = ["bottom", "top", "right", "left"];
    if (step.placement) order = [step.placement].concat(order);

    for (var i = 0; i < order.length; i++) {
      var spot = _trySide(order[i], rect, box, vw, vh);
      if (spot) {
        _bubble.style.left = Math.round(spot.left) + "px";
        _bubble.style.top = Math.round(spot.top) + "px";
        return;
      }
    }

    _bubble.style.left = Math.round((vw - box.width) / 2) + "px";
    _bubble.style.top = Math.round((vh - box.height) / 2) + "px";
  }

  function _trySide(side, rect, box, vw, vh) {
    var left;
    var top;

    if (side === "bottom" || side === "top") {
      top =
        side === "bottom" ? rect.bottom + GAP : rect.top - GAP - box.height;
      if (top < EDGE || top + box.height > vh - EDGE) return null;
      left = _clamp(
        rect.left + rect.width / 2 - box.width / 2,
        EDGE,
        vw - EDGE - box.width,
      );
      return { left: left, top: top };
    }

    left = side === "right" ? rect.right + GAP : rect.left - GAP - box.width;
    if (left < EDGE || left + box.width > vw - EDGE) return null;
    top = _clamp(
      rect.top + rect.height / 2 - box.height / 2,
      EDGE,
      vh - EDGE - box.height,
    );
    return { left: left, top: top };
  }

  /** "bottom-left", "top-right", "bottom", "top" — anything else centres. */
  function _dock(where, box, vw, vh) {
    var name = String(where);
    var top =
      name.indexOf("top") === 0
        ? EDGE
        : name.indexOf("bottom") === 0
          ? vh - EDGE - box.height
          : (vh - box.height) / 2;
    var left =
      name.indexOf("-left") > 0
        ? EDGE
        : name.indexOf("-right") > 0
          ? vw - EDGE - box.width
          : (vw - box.width) / 2;
    return {
      left: _clamp(left, EDGE, Math.max(EDGE, vw - EDGE - box.width)),
      top: _clamp(top, EDGE, Math.max(EDGE, vh - EDGE - box.height)),
    };
  }

  function _clamp(value, low, high) {
    if (high < low) return low;
    return Math.min(Math.max(value, low), high);
  }

  return {
    init: init,
    start: start,
    stop: stop,
    isOpen: isOpen,
    maybeAutoStart: maybeAutoStart,
    shouldAutoStart: shouldAutoStart,
    isSuppressed: isSuppressed,
    setSuppressed: setSuppressed,

    // Read by the test suite, which checks that every key named here exists
    // in the dictionaries.
    steps: function () {
      return STEPS.slice();
    },
    titleKey: _titleKey,
    bodyKey: _bodyKey,
  };
})();

window.App = App;
