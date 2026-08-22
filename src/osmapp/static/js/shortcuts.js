/**
 * shortcuts.js — the keyboard dispatcher, and the sheet that lists it.
 *
 * One registry answers every key in the app, and the help sheet is rendered
 * *from* that registry rather than written alongside it: a list and a set of
 * handlers maintained separately disagree about which keys exist.
 *
 * ── Contexts ──────────────────────────────────────────────────────────────
 *
 * Shaped like App.history's scope stack, because it is the same problem: what
 * a key means depends on what you are doing. A mode pushes a context when it
 * starts and pops it when it ends, innermost wins, and the global context is
 * always at the bottom.
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
 * the sheet and nothing else — for gestures (right-drag to pan) and modifier
 * holds (Alt suspends snapping) that are not discrete keystrokes and are
 * handled where the pointer state lives. Both kinds are listed; only the
 * first fires.
 *
 * An entry with `hold: true` is the third kind: `run` on the way down and
 * `release` on the way up, for a gesture that is live only while the key is
 * held. It belongs here rather than in a private keydown listener, which the
 * context stack cannot order and the sheet cannot show.
 *
 * Two guarantees holders rely on. Auto-repeat does not re-fire `run`, because
 * a key held down is one press however many times the platform says so. And
 * `release` is called if the window loses focus with the key down — Alt+Tab
 * away mid-sweep and the keyup is delivered to somebody else, which would
 * otherwise leave the gesture running with nothing to end it.
 *
 * `when()` gates an entry that exists only some of the time — the trim tool's
 * F is locked while corners are being dragged by hand. An entry that cannot
 * fire is greyed on the sheet rather than hidden, so the reason it is
 * unavailable stays visible.
 *
 * ── Dialogs ───────────────────────────────────────────────────────────────
 *
 * A context marked `exclusive: true` is a barrier: nothing beneath it answers
 * the keyboard, and the tool the dialog opened on top of keeps its keys
 * without having to pop its own context. Every screen that takes over should
 * push one. A dialog with no context of its own falls back to the blanket
 * rule in _reach(), which blocks the tools underneath but leaves the dialog
 * itself no way to register keys.
 *
 * `whileTyping: true` is the exception to the exception. Nothing fires while a
 * text field has focus, which is right for every single-letter shortcut and
 * wrong for the one gesture people expect from a form: type a number, press
 * Enter. Entries that mean something *while* typing say so.
 *
 * ── What this does not take over ──────────────────────────────────────────
 *
 * The tour and the PDF placement frame bind on the capture phase and own the
 * keyboard completely while they are up, including Escape. Text fields
 * likewise: nothing here fires while one has focus.
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
  var _sheetIsDialog = false; // the sheet *is* App.ui's dialog

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
      {
        // Labelled for anywhere rather than for a territory: bare ground has
        // a menu of its own, so the right button is never handed back to the
        // browser.
        combos: ["Right-click"],
        labelKey: "shortcuts.menuAnywhere",
        note: true,
      },
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

  /**
   * Input types that swallow a character. Everything else with an <input> tag
   * — a checkbox, a slider, a color well, a file picker — takes focus without
   * taking text.
   *
   * The distinction matters because "is a text field focused?" was being
   * answered by the tag name, and the answer was wrong for most of the
   * controls in the app's own dialogs. Click the print dialog's Sharpen box or
   * touch its zoom slider and focus lands on an <input>; from that moment E,
   * F, [, ], 0 and T were dead, though the sheet went on listing all six. The
   * boundary dialog was worse: its one control is a range, so moving the
   * Detail slider — the thing the dialog exists for — turned off the arrow
   * keys documented to move it.
   *
   * A <select> stays on the typing side. Letters there drive the browser's own
   * option typeahead, which is text entry by another name.
   *
   * Written as the list of things that are *not* text on purpose: the text
   * types are open-ended and grow with the platform, the non-text ones are a
   * closed set, and a type nobody here has heard of renders as a text box —
   * so guessing "text" for it is both safer and what the browser does.
   */
  var NON_TEXT_INPUT_TYPES = {
    button: true,
    checkbox: true,
    color: true,
    file: true,
    hidden: true,
    image: true,
    radio: true,
    range: true,
    reset: true,
    submit: true,
  };

  function _isTyping(target) {
    if (!target) return false;
    var tag = String(target.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      return !NON_TEXT_INPUT_TYPES[String(target.type || "text").toLowerCase()];
    }
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
   * addressed to. Blocking them takes Ctrl+Z away from the eraser, which is the
   * one place inside a dialog where it has something to undo.
   */
  function _modalOpen() {
    if (App.print && App.print.isOpen && App.print.isOpen()) return true;
    // The sheet opened as *the* dialog is a window onto the screen you are on,
    // not a screen of its own. Counting it would make the sheet report every
    // global key as unavailable at exactly the moment somebody is reading the
    // sheet to find out which keys are available.
    if (_sheetIsDialog) return false;
    if (App.ui && App.ui.isDialogOpen && App.ui.isDialogOpen()) return true;
    return false;
  }

  /**
   * Who can answer right now — the one calculation behind both halves of this
   * module.
   *
   * The dispatcher and the sheet both go through here, so a group the sheet
   * greys out is a group that would not fire. Deriving it twice is how a list
   * that agrees about which keys exist comes to disagree about which of them
   * do anything.
   *
   * @returns {{stack:Array, covered:function(number, Object):boolean}}
   */
  function _reach() {
    var stack = _stack();
    // Innermost exclusive context, if any: everything past it is a tool the
    // dialog is covering.
    var barrier = -1;
    for (var i = 0; i < stack.length; i++) {
      if (stack[i].exclusive) {
        barrier = i;
        break;
      }
    }
    // A dialog with no context of its own still blocks the tools underneath:
    // being covered is a property of the dialog, not of what it registered.
    var blanket = barrier < 0 && _modalOpen();

    return {
      stack: stack,
      covered: function (index, entry) {
        if (entry && entry.overModal) return false;
        return blanket || (barrier >= 0 && index > barrier);
      },
    };
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

    var reach = _reach();
    var stack = reach.stack;

    for (var i = 0; i < stack.length; i++) {
      var entries = stack[i].entries || [];
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (entry.note || typeof entry.run !== "function") continue;
        if (reach.covered(i, entry)) continue;
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
      // screen you asked for help about is not help.
      _sheet = D.mountOnMap("tpl-shortcuts-dialog", App.state.leafletMap);
      dialog = _sheet;
    } else {
      dialog = App.ui.openDialog("tpl-shortcuts-dialog", function () {
        _sheetOpen = false;
        _sheetIsDialog = false;
      });
      _sheetIsDialog = true;
    }
    _sheetOpen = true;
    D.onRole(dialog, "close", closeSheet);
    _renderSheet(dialog);
    var close = D.role(dialog, "close");
    if (close && close.focus) close.focus();
  }

  /**
   * The sheet as data: every group, every row, and whether the row would do
   * anything if its combo were pressed right now.
   *
   * The rendering below is built from this rather than walking the stack
   * itself, for the same reason the sheet is built from the registry at all —
   * "what is drawn" and "what would fire" have to be one calculation or they
   * drift. It is also the seam the tests use, because asserting on greyed-out
   * rows through a DOM stub asserts mostly about the stub.
   */
  function snapshot() {
    var reach = _reach();
    return reach.stack.map(function (context, index) {
      return {
        id: context.id,
        titleKey: context.titleKey,
        entries: (context.entries || [])
          .filter(function (entry) {
            return entry.labelKey;
          })
          .map(function (entry) {
            var covered = reach.covered(index, entry);
            return {
              labelKey: entry.labelKey,
              combos: entry.combos || [],
              hold: !!entry.hold,
              note: !!entry.note,
              covered: covered,
              available: !covered && (!entry.when || entry.when()),
            };
          }),
      };
    });
  }

  function _renderSheet(dialog) {
    var root =
      dialog || _sheet || (App.ui.dialogNode && App.ui.dialogNode());
    if (!root) return;
    var host = D.role(root, "groups");
    if (!host) return;
    host.textContent = "";

    snapshot().forEach(function (group) {
      if (!group.entries.length) return;

      var section = D.mount("tpl-shortcuts-group", host);
      var title = D.role(section, "title");
      if (title) title.textContent = T(group.titleKey);

      // A group every one of whose entries is behind the barrier is not a
      // group with some keys greyed — it is a group that does not apply, and
      // saying so once at the top beats saying nothing eleven times.
      var buried = group.entries.every(function (entry) {
        return entry.covered;
      });
      D.toggleClass(section, "is-covered", buried);
      if (buried && title) {
        var note = document.createElement("span");
        note.className = "shortcuts-group__note";
        note.textContent = T("shortcuts.covered");
        title.appendChild(note);
      }

      var list = D.role(section, "items");

      group.entries.forEach(function (entry) {
        var row = D.mount("tpl-shortcuts-item", list);
        D.toggleClass(row, "is-unavailable", !entry.available);

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
    snapshot: snapshot,
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
