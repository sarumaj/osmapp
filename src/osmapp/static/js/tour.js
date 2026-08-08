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
 *   • It is explanatory, not interactive. A tour that makes you perform each
 *     step needs the app to be in a particular state to continue, and there is
 *     no such state on a first visit — no boundary, no data, no territories.
 *     So the veil swallows clicks and the tour talks about controls rather
 *     than driving them. Nothing it does can leave the app half-edited.
 *
 *   • A step whose target is missing still runs. The geocoder is skipped when
 *     the plugin failed to load, but everything else falls back to a centred
 *     card, because a walkthrough that silently loses four steps on a narrow
 *     screen teaches a wrong mental model of what the app has.
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
  var _index = 0;
  var _steps = [];
  var _keyBound = false;
  var _restoreCollapsed = null;

  // ══════════════════════════════════════════════════════════════════════
  // CONTENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @type {Array<{id:string, target?:string, placement?:string,
   *               skipIfNoTarget?:boolean}>}
   *   `target` is a CSS selector resolved at the moment the step is shown, so
   *   controls that are rebuilt on a language change are still found. Steps
   *   without one are centred cards — used where the subject is a gesture
   *   (right-click) or a dialog that is not currently open.
   */
  var STEPS = [
    { id: "welcome" },
    {
      id: "search",
      target: ".leaflet-control-geocoder",
      placement: "bottom",
      skipIfNoTarget: true,
    },
    { id: "draw", target: '[data-action="draw"]', placement: "right" },
    { id: "locate", target: '[data-action="locate"]', placement: "right" },
    { id: "refetch", target: '[data-action="refetch"]', placement: "right" },
    { id: "partition", target: '[data-action="partition"]', placement: "right" },
    { id: "cut", target: '[data-action="cut"]', placement: "right" },
    { id: "merge", target: '[data-action="merge"]', placement: "right" },
    { id: "history", target: '[data-action="undo"]', placement: "right" },
    { id: "territory" },
    { id: "print" },
    {
      id: "layers",
      target: ".leaflet-control-layers",
      placement: "left",
      skipIfNoTarget: true,
    },
    { id: "info", target: "#info-panel", placement: "left" },
    { id: "files", target: '[data-action="export"]', placement: "right" },
    { id: "reset", target: '[data-action="reset"]', placement: "right" },
    { id: "language", target: ".tb-item--select", placement: "right" },
    { id: "offline" },
    { id: "done", target: '[data-action="help"]', placement: "right" },
  ];

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
    try {
      return window.localStorage.getItem(SEEN_KEY) === "1";
    } catch (e) {
      // No storage means no memory of a previous visit, so the tour offers
      // itself again. Annoying at worst; the alternative is never showing it.
      return false;
    }
  }

  function setSuppressed(suppressed) {
    try {
      if (suppressed) window.localStorage.setItem(SEEN_KEY, "1");
      else window.localStorage.removeItem(SEEN_KEY);
    } catch (e) {
      /* not being able to remember the choice is not worth an error */
    }
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
      return !(step.skipIfNoTarget && !_resolve(step));
    });
    if (_steps.length === 0) return;

    _index = Math.min(Math.max(index || 0, 0), _steps.length - 1);

    _root = D.mount("tpl-tour", document.body);
    _bubble = D.role(_root, "bubble");
    _spot = D.role(_root, "spot");

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

    _render();
    _bubble.focus();
  }

  function stop() {
    if (!_root) return;

    // Reaching the end or leaving early both count as "seen", unless the
    // checkbox was cleared on the way past.
    var mute = D.role(_root, "mute");
    setSuppressed(!mute || mute.checked);

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
    _steps = [];
    _index = 0;
  }

  function _next() {
    if (_index >= _steps.length - 1) {
      stop();
      return;
    }
    _index += 1;
    _render();
  }

  function _back() {
    if (_index === 0) return;
    _index -= 1;
    _render();
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
    if (!step.target) return null;
    var node = document.querySelector(step.target);
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

  function _renderDots() {
    var host = D.role(_root, "dots");
    if (!host) return;
    host.textContent = "";
    for (var i = 0; i < _steps.length; i++) {
      var dot = document.createElement("span");
      dot.className =
        "tour__dot" +
        (i === _index ? " is-current" : i < _index ? " is-done" : "");
      host.appendChild(dot);
    }
  }

  function _reposition() {
    if (!_root) return;
    var node = _resolve(_steps[_index]);
    var rect = node ? node.getBoundingClientRect() : null;
    _placeSpot(rect);
    _placeBubble(rect, _steps[_index].placement);
  }

  function _placeSpot(rect) {
    if (!_spot) return;
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
  function _placeBubble(rect, prefer) {
    if (!_bubble) return;

    var box = _bubble.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (!rect) {
      _bubble.style.left = Math.round((vw - box.width) / 2) + "px";
      _bubble.style.top = Math.round((vh - box.height) / 2) + "px";
      return;
    }

    var order = ["bottom", "top", "right", "left"];
    if (prefer) order = [prefer].concat(order);

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
    SEEN_KEY: SEEN_KEY,
  };
})();

window.App = App;
