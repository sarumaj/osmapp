/**
 * shortcuts.js — one keyboard dispatcher, and the sheet that lists it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Keyboard handling used to be four `document.addEventListener("keydown")`
 * calls in four modules, each re-deriving "am I the one who should answer
 * this?" from a mode flag. That worked, and it drifted, in the two ways a
 * design like that always drifts:
 *
 *   • Asymmetry. The cut tool bound Backspace to "take back a vertex" and
 *     nothing to "put one back", even though redoPoint() existed and the
 *     toolbar had a Back button with no forward twin. Merge mode bound
 *     Escape and nothing else — no Enter, though every other modal tool in
 *     the app commits on Enter. The outer-boundary drawer had no way to take
 *     back a vertex at all, though Leaflet.Editable has had pop() all along.
 *   • Invisibility. A shortcut nobody can enumerate is a shortcut nobody
 *     knows. Three of them were written on a hint banner, three more on
 *     <kbd> tags in the cut toolbar, and the rest were in the source.
 *
 * Both are the same bug: there was no list. So there is a list now, and it is
 * the list that runs — the help sheet is rendered *from* the registry rather
 * than written alongside it, which is what stops the documentation and the
 * behavior from disagreeing again.
 *
 * ── Contexts ──────────────────────────────────────────────────────────────
 *
 * Deliberately shaped like App.history's scope stack, because it is the same
 * problem: what a key means depends on what you are doing. A mode pushes a
 * context when it starts and pops it when it ends, innermost wins, and the
 * global context is always at the bottom.
 *
 *   App.shortcuts.push({
 *     id: "cut",
 *     titleKey: "shortcuts.groupCut",
 *     entries: [
 *       { combos: ["Enter"], labelKey: "shortcuts.cutFinish", run: finish },
 *       { combos: ["Alt"],   labelKey: "shortcuts.cutAlt", note: true },
 *     ],
 *   });
 *
 * An entry with `run` is a binding. An entry with `note: true` is a line on
 * the sheet and nothing else — for gestures (right-drag to pan) and for
 * modifier holds (Alt suspends snapping) that are not discrete keystrokes and
 * are handled where the pointer state lives. Both kinds are listed; only the
 * first kind fires.
 *
 * An entry with `hold: true` is the third kind: `run` on the way down and
 * `release` on the way up, for a gesture that is only live while the key is
 * held. The vertex eraser is the case that asked for it — a pointer that
 * destroys what it touches must not be something you can leave switched on —
 * and it went here rather than into a private keydown listener because a
 * private listener is exactly what this module was written to replace: it
 * cannot be ordered by the context stack and cannot be shown on the sheet.
 *
 * Two guarantees the holders rely on. Auto-repeat does not re-fire `run`,
 * because a key held down is one press however many times the platform says
 * so. And `release` is called if the window loses focus with the key down —
 * Alt+Tab away mid-sweep and the keyup is delivered to somebody else, which
 * without this would leave the gesture running with nothing to end it.
 *
 * `when()` gates an entry that exists only some of the time — the trim tool's
 * F is locked while corners are being dragged by hand, and an entry that
 * cannot fire is greyed on the sheet rather than hidden, so the reason it is
 * unavailable is a thing you can see.
 *
 * ── Dialogs ───────────────────────────────────────────────────────────────
 *
 * A context marked `exclusive: true` is a barrier: nothing beneath it answers
 * the keyboard, and the tool the dialog opened on top of keeps its keys without
 * having to pop its own context. That is what a modal *is*, and it used to be
 * enforced by asking App.ui whether any dialog was open at all — which was
 * right about the tools underneath and wrong about the dialog itself, because
 * it left the dialog with no way to register keys of its own. Every screen in
 * the app that takes over now pushes an exclusive context, and the ones that
 * have not been converted still get the old blanket rule.
 *
 * `whileTyping: true` is the exception to the exception. Nothing fires while a
 * text field has focus, which is right for every single-letter shortcut and
 * wrong for the one gesture people expect from a form: type a number, press
 * Enter. Entries that mean something *while* you are typing say so.
 *
 * ── What this does not take over ──────────────────────────────────────────
 *
 * The tour and the PDF placement frame bind on the capture phase and are
 * modal in the strong sense: while either is up it owns the keyboard
 * completely, including Escape. Routing them through a registry that other
 * things can also answer would be a downgrade, so they stay where they are.
 * Text fields likewise: nothing here fires while one has focus.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.shortcuts = (function () {
  "use strict";

  var D = null;
  var T = null;

  /** Innermost last. The global context is not on it; see _stack(). */
  var _contexts = [];
  var _global = { id: "global", titleKey: "shortcuts.groupGlobal", entries: [] };
  var _bound = false;
  var _sheetOpen = false;
  var _sheet = null; // the node, when the sheet is stacked over a dialog

  // ── Platform ──────────────────────────────────────────────────────────
  //
  // "Mod" is Ctrl everywhere and ⌘ on a Mac. Writing Ctrl on a sheet a Mac
  // user is reading is the kind of small wrongness that makes the whole sheet
  // feel like it was written for somebody else.
  var _mac = null;

  function isMac() {
    if (_mac === null) {
      var platform =
        (typeof navigator !== "undefined" &&
          (navigator.platform || navigator.userAgent)) ||
        "";
      _mac = /Mac|iPhone|iPad|iPod/i.test(platform);
    }
    return _mac;
  }

  function init() {
    D = App.dom;
    T = App.i18n.t;
    if (!_bound) {
      document.addEventListener("keydown", _onKeyDown);
      document.addEventListener("keyup", _onKeyUp);
      // Not "blur" on the document: a click into the map's own container
      // blurs whatever had focus, and releasing the eraser every time the
      // pointer lands somewhere would make a held key mean nothing.
      window.addEventListener("blur", releaseAll);
      _bound = true;
    }

    global([
      {
        // The one shortcut whose whole job is to reveal the others, so it is
        // also the only one that fires while its own sheet is open.
        //
        // Two combos because "?" is not a key on most keyboards — it is Shift
        // and something, and which something depends on the layout. It is
        // still the conventional binding and worth having, but F1 is one
        // physical key everywhere, which is what makes it the reliable half
        // of this pair.
        combos: ["?", "F1"],
        labelKey: "shortcuts.sheet",
        // Every screen that takes over the keyboard still has to be able to
        // say what it answers. This was the one binding whose whole job is
        // to reveal the others and it was unavailable in exactly the screens
        // with the most keys to reveal.
        overModal: true,
        whileTyping: true,
        run: toggleSheet,
      },
      {
        // Owned by App.ui, which closes the topmost thing on screen. Listed
        // because a key that works everywhere and appears nowhere is the
        // reason this module exists.
        combos: ["Escape"],
        labelKey: "shortcuts.escape",
        note: true,
      },
      { combos: ["Right-click"], labelKey: "shortcuts.menuTerritory", note: true },
    ]);

    App._loaded.push("shortcuts");
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMBO PARSING
  // ══════════════════════════════════════════════════════════════════════

  /**
   * "Ctrl+Shift+Z" → { ctrl: true, shift: true, alt: false, key: "z" }
   *
   * "Mod" means Ctrl on Windows and Linux, ⌘ on a Mac, and matches either —
   * a Mac keyboard has a Ctrl key too and somebody used to it should not find
   * that undo has stopped working.
   */
  function parse(combo) {
    var parts = String(combo).split("+");
    var spec = { ctrl: false, shift: false, alt: false, mod: false, key: "" };
    parts.forEach(function (part) {
      var token = part.trim();
      var lower = token.toLowerCase();
      if (lower === "ctrl" || lower === "control") spec.ctrl = true;
      else if (lower === "shift") spec.shift = true;
      else if (lower === "alt" || lower === "option") spec.alt = true;
      else if (lower === "mod" || lower === "cmd" || lower === "meta")
        spec.mod = true;
      else {
        spec.key = lower;
        // Matching is case-insensitive, but a gesture written "Right-drag"
        // should be drawn the way it was written rather than shouted or
        // flattened. Only the lowercased form is ever compared.
        spec.raw = token;
      }
    });
    return spec;
  }

  function _matches(spec, e) {
    if (!spec.key) return false;
    var key = String(e.key || "").toLowerCase();
    if (key !== spec.key) return false;

    var mod = !!(e.ctrlKey || e.metaKey);
    if (spec.mod) {
      if (!mod) return false;
    } else if (spec.ctrl) {
      if (!e.ctrlKey) return false;
    } else if (mod) {
      // An unmodified binding must not swallow Ctrl+S or ⌘+P.
      return false;
    }

    if (spec.shift) {
      if (!e.shiftKey) return false;
    } else if (e.shiftKey && !_isSymbol(spec.key)) {
      // Shift is asserted absent for letters, digits and named keys, so that
      // Backspace and Shift+Backspace stay distinct.
      //
      // Symbols are the exception, and "?" is why: on a US layout it *is*
      // Shift+/, on a German one Shift+ß, and the browser reports the symbol
      // in e.key with shiftKey still true. Requiring Shift to be up meant the
      // one binding whose job is to reveal all the others could never fire on
      // any keyboard that has it. Which modifier produces a symbol is a
      // property of the layout, not of the shortcut.
      return false;
    }
    // Alt is not asserted unless the combo asks for it: Alt is a live modifier
    // in the cut tool, and requiring altKey to be false would mean every other
    // shortcut stopped working for as long as snapping was suspended.
    if (spec.alt && !e.altKey) return false;
    return true;
  }

  /** A single printable character that is neither a letter nor a digit. */
  function _isSymbol(key) {
    return key.length === 1 && !/[a-z0-9]/.test(key);
  }

  // ── Display ───────────────────────────────────────────────────────────

  var KEY_LABELS = {
    escape: "Esc",
    enter: "Enter",
    backspace: "Backspace",
    delete: "Del",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    " ": "Space",
  };

  /** The chips a combo is drawn as: ["Ctrl", "Z"]. */
  function keyCaps(combo) {
    var spec = parse(combo);
    var caps = [];
    if (spec.mod) caps.push(isMac() ? "⌘" : "Ctrl");
    if (spec.ctrl) caps.push("Ctrl");
    if (spec.alt) caps.push(isMac() ? "⌥" : "Alt");
    if (spec.shift) caps.push("Shift");
    if (spec.key) caps.push(_capFor(spec.key, spec.raw));
    // A modifier named on its own — Alt, as a hold — is the whole combo.
    if (!caps.length) caps.push(String(combo));
    return caps;
  }

  function _capFor(key, raw) {
    if (KEY_LABELS[key]) return KEY_LABELS[key];
    if (key.length === 1) return key.toUpperCase();
    return raw || key;
  }

  /** "Ctrl+Z", ready to drop into a tooltip. */
  function hint(combo) {
    return keyCaps(combo).join("+");
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONTEXT STACK
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Take over the keyboard until pop(id). Pushing an id that is already on the
   * stack replaces it, so a mode that restarts without a clean teardown cannot
   * strand a context belonging to a tool that has closed.
   */
  function push(context) {
    if (!context || !context.id) return;
    pop(context.id);
    _contexts.push(context);
    if (_sheetOpen) _renderSheet();
  }

  function pop(id) {
    for (var i = _contexts.length - 1; i >= 0; i--) {
      if (_contexts[i].id === id) {
        _contexts.splice(i, 1);
        if (_sheetOpen) _renderSheet();
        return;
      }
    }
  }

  /** Entries every context shares. Called once, from init. */
  function global(entries) {
    _global.entries = _global.entries.concat(entries || []);
  }

  /** Innermost first, global last — dispatch order and sheet order alike. */
  function _stack() {
    return _contexts.slice().reverse().concat([_global]);
  }

  /** Which context is answering right now — for tests and for debugging. */
  function activeId() {
    return _contexts.length ? _contexts[_contexts.length - 1].id : "global";
  }

  // ══════════════════════════════════════════════════════════════════════
  // DISPATCH
  // ══════════════════════════════════════════════════════════════════════

  function _isTyping(target) {
    if (!target) return false;
    var tag = String(target.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return !!target.isContentEditable;
  }

  /**
   * A dialog owns the keyboard while it is up.
   *
   * Without this, Enter in the print dialog would also commit the cut that
   * was in progress behind it, and Escape would close two things at once —
   * which is how a modal stops being modal. App.ui's own Escape handler is
   * the one that closes the dialog; nothing here needs to.
   *
   * `overModal` is the exception, and there is exactly one kind of entry that
   * earns it: undo and redo, which do not mean anything on their own. They
   * ask App.history which scope is active, and a dialog that has pushed one —
   * the print dialog pushes the eraser's — is the thing they are already
   * addressed to. Blocking them would have quietly taken Ctrl+Z away from the
   * eraser, which had it before this module existed.
   */
  function _modalOpen() {
    if (App.print && App.print.isOpen && App.print.isOpen()) return true;
    if (App.ui && App.ui.isDialogOpen && App.ui.isDialogOpen()) return true;
    return false;
  }

  /**
   * The tour is modal in the stronger sense: it binds on the capture phase and
   * answers every key itself, including the arrows and Escape. Nothing here
   * fires underneath it, `overModal` included — a walkthrough that can be
   * undone out from under itself is worse than one with no shortcuts.
   */
  function _tourOpen() {
    return !!(App.tour && App.tour.isOpen && App.tour.isOpen());
  }

  // ── Held keys ─────────────────────────────────────────────────────────
  //
  // Entries whose run() has fired and whose release() is owed, keyed by the
  // lowercased key that started them. Keyed rather than a list so that the
  // second keydown of an auto-repeat is recognizable as the same press.

  var _held = Object.create(null);

  function _startHold(entry, e) {
    var key = String(e.key || "").toLowerCase();
    if (_held[key]) return; // auto-repeat, or a second context answering
    _held[key] = entry;
    entry.run(e);
  }

  function _onKeyUp(e) {
    if (!e || !e.key) return;
    var key = String(e.key || "").toLowerCase();
    var entry = _held[key];
    if (!entry) return;
    delete _held[key];
    if (typeof entry.release === "function") entry.release(e);
  }

  /**
   * End every hold, whatever is holding it.
   *
   * Called on window blur, and worth calling from a mode's own teardown: a
   * tool that closes while its key is down would otherwise get the release
   * after it has already thrown away the thing being released.
   */
  function releaseAll() {
    Object.keys(_held).forEach(function (key) {
      var entry = _held[key];
      delete _held[key];
      if (entry && typeof entry.release === "function") entry.release();
    });
  }

  function isHeld(combo) {
    return !!_held[parse(combo).key];
  }

  function _onKeyDown(e) {
    if (!e || !e.key) return;
    var typing = _isTyping(e.target);

    // While the sheet is up it is the modal, and the only key it answers is
    // the one that closes it. Undo firing behind a list of shortcuts would
    // be the sheet doing the thing it is supposed to be describing.
    if (_sheetOpen) {
      if (_matches(parse("?"), e) || _matches(parse("F1"), e)) {
        e.preventDefault();
        toggleSheet();
        return;
      }
      // The sheet is the topmost thing on screen, so it is the thing Escape
      // closes — ui.js stands down for exactly as long as it is up, or
      // asking for help over the print dialog would shut the print dialog.
      if (_matches(parse("Escape"), e)) {
        e.preventDefault();
        closeSheet();
      }
      return;
    }
    if (_tourOpen()) return;

    var stack = _stack();
    // Innermost exclusive context, if any: everything past it is a tool the
    // dialog is covering.
    var barrier = -1;
    for (var b = 0; b < stack.length; b++) {
      if (stack[b].exclusive) {
        barrier = b;
        break;
      }
    }
    // A dialog that has not been given a context of its own still blocks the
    // tools underneath, the way every dialog did before contexts existed.
    var blanket = barrier < 0 && _modalOpen();

    for (var i = 0; i < stack.length; i++) {
      var entries = stack[i].entries || [];
      var covered = blanket || (barrier >= 0 && i > barrier);
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (entry.note || typeof entry.run !== "function") continue;
        if (covered && !entry.overModal) continue;
        if (typing && !entry.whileTyping) continue;
        if (entry.when && !entry.when()) continue;
        if (!_hits(entry, e, typing)) continue;
        e.preventDefault();
        if (entry.hold) _startHold(entry, e);
        else entry.run(e);
        return;
      }
    }
  }

  function _hits(entry, e, typing) {
    var combos = entry.combos || [];
    for (var i = 0; i < combos.length; i++) {
      var spec = parse(combos[i]);
      // A combo that produces a character never fires into a text field,
      // whatever the entry says. "?" and F1 both open the sheet and only one
      // of them can be typed — without this, whileTyping on that pair would
      // mean somebody typing a question mark into the locality field gets a
      // list of shortcuts and no question mark.
      if (typing && _typesACharacter(spec)) continue;
      if (_matches(spec, e)) return true;
    }
    return false;
  }

  /** A single printable key with no modifier that would stop it printing. */
  function _typesACharacter(spec) {
    return (
      spec.key.length === 1 && !spec.ctrl && !spec.mod && !spec.alt
    );
  }

  /** Fire a combo as though it had been typed — for tests and for the sheet. */
  function trigger(combo) {
    var spec = parse(combo);
    var fake = {
      key: spec.key,
      ctrlKey: spec.ctrl || spec.mod,
      metaKey: false,
      shiftKey: spec.shift,
      altKey: spec.alt,
      target: null,
      preventDefault: function () {},
    };
    _onKeyDown(fake);
  }

  /** The other half of a hold, for the same audience as trigger(). */
  function triggerUp(combo) {
    _onKeyUp({ key: parse(combo).key });
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE SHEET
  // ══════════════════════════════════════════════════════════════════════

  function isSheetOpen() {
    return _sheetOpen;
  }

  function toggleSheet() {
    if (_sheetOpen) closeSheet();
    else openSheet();
  }

  function closeSheet() {
    if (!_sheetOpen) return;
    if (_sheet) {
      _sheet = D.remove(_sheet);
      _sheetOpen = false;
      return;
    }
    // Opened as the dialog: its own teardown flips the flag.
    App.ui.closeDialog();
  }

  /**
   * The list, in dispatch order, with the mode you are actually in at the top.
   * Which is the whole point: "what can I do right now" is the question being
   * asked, and answering it with an alphabetical index of everything would be
   * answering a different one.
   */
  function openSheet() {
    if (_sheetOpen) return;
    var dialog;
    if (App.ui.isDialogOpen()) {
      // Mounted on top rather than opened as *the* dialog, the way the
      // placement frame stacks over the print dialog. App.ui.openDialog()
      // closes whatever is already up, and a help sheet that destroys the
      // screen you asked for help about is not help — which is precisely
      // what "?" did in every dialog in the app until now.
      _sheet = D.mountOnMap("tpl-shortcuts-dialog", App.state.leafletMap);
      dialog = _sheet;
    } else {
      dialog = App.ui.openDialog("tpl-shortcuts-dialog", function () {
        _sheetOpen = false;
      });
    }
    _sheetOpen = true;
    D.onRole(dialog, "close", closeSheet);
    _renderSheet(dialog);
    var close = D.role(dialog, "close");
    if (close && close.focus) close.focus();
  }

  function _renderSheet(dialog) {
    var root =
      dialog || _sheet || (App.ui.dialogNode && App.ui.dialogNode());
    if (!root) return;
    var host = D.role(root, "groups");
    if (!host) return;
    host.textContent = "";

    _stack().forEach(function (context) {
      var entries = (context.entries || []).filter(function (entry) {
        return entry.labelKey;
      });
      if (!entries.length) return;

      var section = D.mount("tpl-shortcuts-group", host);
      D.text(section, "title", T(context.titleKey));
      var list = D.role(section, "items");

      entries.forEach(function (entry) {
        var row = D.mount("tpl-shortcuts-item", list);
        var available = !entry.when || entry.when();
        D.toggleClass(row, "is-unavailable", !available);

        var keys = D.role(row, "keys");
        keys.textContent = "";
        // A key that has to stay down is a different instruction from a key
        // that has to be pressed, and the caps look identical. The word is
        // the only thing that distinguishes them.
        if (entry.hold) {
          var hold = document.createElement("span");
          hold.className = "shortcuts-item__hold";
          hold.textContent = T("shortcuts.hold");
          keys.appendChild(hold);
        }
        (entry.combos || []).forEach(function (combo, index) {
          if (index > 0) {
            var or = document.createElement("span");
            or.className = "shortcuts-item__or";
            or.textContent = T("shortcuts.or");
            keys.appendChild(or);
          }
          keyCaps(combo).forEach(function (cap, position) {
            if (position > 0) {
              var plus = document.createElement("span");
              plus.className = "shortcuts-item__plus";
              plus.textContent = "+";
              keys.appendChild(plus);
            }
            var kbd = document.createElement("kbd");
            kbd.textContent = cap;
            keys.appendChild(kbd);
          });
        });

        D.text(row, "label", T(entry.labelKey));
      });
    });
  }

  return {
    init: init,
    push: push,
    pop: pop,
    global: global,
    activeId: activeId,
    parse: parse,
    keyCaps: keyCaps,
    hint: hint,
    trigger: trigger,
    triggerUp: triggerUp,
    releaseAll: releaseAll,
    isHeld: isHeld,
    openSheet: openSheet,
    closeSheet: closeSheet,
    toggleSheet: toggleSheet,
    isSheetOpen: isSheetOpen,
    isMac: isMac,
  };
})();

window.App = App;
