/**
 * The keyboard, and which context answers it.
 *
 * This module exists because the answer used to be "whichever module happened
 * to bind a listener first, filtered through its own reading of a mode flag".
 * That arrangement shipped three bugs of the same shape and they are the ones
 * pinned below:
 *
 *   • A mode bound one half of a pair. Cut had Backspace and nothing for
 *     going forward; merge had Escape and nothing else at all. A registry
 *     does not prevent that by itself — but a registry that renders the help
 *     sheet does, because the gap becomes something you can see.
 *   • A key kept firing after its tool closed. Nothing popped, nothing
 *     complained, and the binding simply outlived the thing it belonged to.
 *   • A modal shared its keys with whatever was behind it. Enter in a dialog
 *     also committed the cut underneath, which is a modal that is not modal.
 *
 * The sheet is asserted through the registry rather than through the DOM: the
 * point is that the list which dispatches and the list which is displayed are
 * the same object, so what is worth checking is that entries with no `run`
 * never fire and entries with a false `when` are skipped rather than hidden.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

function setup({ navigator: nav } = {}) {
  const listeners = [];
  const upListeners = [];
  const blurListeners = [];
  // A held key is three browser events, not one: the press, the release, and
  // the window losing focus with the key still down. All three are modeled
  // here, because the third is the one nobody remembers and the one that
  // leaves a destructive gesture running with nothing to end it.
  const window = {
    addEventListener(type, fn) {
      if (type === "blur") blurListeners.push(fn);
    },
  };
  const document = {
    addEventListener(type, fn) {
      if (type === "keydown") listeners.push(fn);
      if (type === "keyup") upListeners.push(fn);
    },
  };

  const App = loadApp(["shortcuts.js"], {
    window,
    document,
    navigator: nav ?? { platform: "Linux x86_64" },
  });

  App.i18n = { t: (key) => key };
  // The sheet is mounted rather than opened when something else is already
  // up, so both routes have to exist here.
  const mounted = [];
  let dialogOpen = false;
  App.dom = {
    role: () => null,
    onRole: () => null,
    mount: () => ({}),
    mountOnMap: (id) => {
      mounted.push(id);
      return { id };
    },
    remove: () => null,
    text: () => {},
    toggleClass: () => {},
  };
  App.state = { leafletMap: {} };
  App.ui = {
    isDialogOpen: () => dialogOpen,
    openDialog: (id) => {
      mounted.push(id);
      dialogOpen = true;
      return { id };
    },
    closeDialog: () => {
      dialogOpen = false;
    },
    dialogNode: () => null,
  };
  App.shortcuts.init();

  return {
    shortcuts: App.shortcuts,
    App,
    /** Pretend a dialog — the print view, a prompt — is already on screen. */
    setDialogOpen(open) {
      dialogOpen = open;
    },
    isDialogOpen: () => dialogOpen,
    mounted,
    /** Fire a keydown at whatever shortcuts.js bound to the document. */
    key(combo, extra = {}) {
      const spec = App.shortcuts.parse(combo);
      const event = {
        key: spec.key,
        ctrlKey: spec.ctrl || spec.mod,
        metaKey: false,
        shiftKey: spec.shift,
        altKey: spec.alt,
        target: { tagName: "DIV" },
        preventDefault() {},
        ...extra,
      };
      listeners.forEach((fn) => fn(event));
    },
    /** The other half of a hold. */
    keyUp(combo) {
      const spec = App.shortcuts.parse(combo);
      upListeners.forEach((fn) => fn({ key: spec.key }));
    },
    blur() {
      blurListeners.forEach((fn) => fn());
    },
  };
}

/** A context that records what it was asked to do. */
function fakeContext(id, entries) {
  return { id, titleKey: `shortcuts.group${id}`, entries };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

test("a pushed context answers before the global one", () => {
  const h = setup();
  const calls = [];

  h.shortcuts.global([
    { combos: ["Enter"], labelKey: "a", run: () => calls.push("global") },
  ]);
  h.key("Enter");
  assert.deepEqual(calls, ["global"]);

  h.shortcuts.push(
    fakeContext("cut", [
      { combos: ["Enter"], labelKey: "b", run: () => calls.push("cut") },
    ]),
  );
  h.key("Enter");
  assert.deepEqual(calls, ["global", "cut"]);
});

test("contexts nest, innermost first, and popping hands the key back", () => {
  const h = setup();
  const calls = [];
  const entry = (name) => [
    { combos: ["Escape"], labelKey: name, run: () => calls.push(name) },
  ];

  h.shortcuts.push(fakeContext("merge", entry("merge")));
  h.shortcuts.push(fakeContext("cut", entry("cut")));
  assert.equal(h.shortcuts.activeId(), "cut");

  h.key("Escape");
  h.shortcuts.pop("cut");
  assert.equal(h.shortcuts.activeId(), "merge");
  h.key("Escape");

  assert.deepEqual(calls, ["cut", "merge"]);
});

test("a key stops firing once its context is popped", () => {
  // The leaked-binding bug: it has no symptom at the moment it happens, and
  // afterwards a closed tool is quietly still answering the keyboard.
  const h = setup();
  const calls = [];
  h.shortcuts.push(
    fakeContext("cut", [
      { combos: ["S"], labelKey: "snap", run: () => calls.push("snap") },
    ]),
  );
  h.key("S");
  h.shortcuts.pop("cut");
  h.key("S");
  assert.deepEqual(calls, ["snap"]);
});

test("pushing the same id twice replaces rather than stacks", () => {
  const h = setup();
  const calls = [];
  const make = (tag) =>
    fakeContext("cut", [
      { combos: ["Enter"], labelKey: tag, run: () => calls.push(tag) },
    ]);

  h.shortcuts.push(make("first"));
  h.shortcuts.push(make("second"));
  h.key("Enter");
  h.shortcuts.pop("cut");
  h.key("Enter");

  // One pop must be enough: a duplicate left underneath would answer here.
  assert.deepEqual(calls, ["second"]);
});

// ── What must not fire ───────────────────────────────────────────────────────

test("a note is listed but never runs", () => {
  const h = setup();
  let fired = false;
  h.shortcuts.push(
    fakeContext("cut", [
      {
        combos: ["Alt"],
        labelKey: "shortcuts.cutAlt",
        note: true,
        run: () => {
          fired = true;
        },
      },
    ]),
  );
  h.key("Alt");
  assert.equal(fired, false, "a documentation entry is not a binding");
});

test("an entry whose when() is false is skipped, and the next one gets the key", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.push(
    fakeContext("cut", [
      {
        combos: ["Backspace"],
        labelKey: "gated",
        when: () => false,
        run: () => calls.push("gated"),
      },
      {
        combos: ["Backspace"],
        labelKey: "open",
        run: () => calls.push("open"),
      },
    ]),
  );
  h.key("Backspace");
  assert.deepEqual(calls, ["open"]);
});

test("nothing fires while a text field has focus", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["S"], labelKey: "snap", run: () => calls.push("snap") },
  ]);

  h.key("S", { target: { tagName: "INPUT" } });
  h.key("S", { target: { tagName: "TEXTAREA" } });
  h.key("S", { target: { tagName: "SELECT" } });
  h.key("S", { target: { tagName: "DIV", isContentEditable: true } });
  assert.deepEqual(calls, [], "typing an S is not pressing S");

  h.key("S");
  assert.deepEqual(calls, ["snap"]);
});

test("a modal owns the keyboard while it is up", () => {
  // Enter in the print dialog must not also commit the cut behind it.
  const h = setup();
  const calls = [];
  h.shortcuts.push(
    fakeContext("cut", [
      { combos: ["Enter"], labelKey: "finish", run: () => calls.push("cut") },
    ]),
  );

  let open = true;
  h.App.ui = { isDialogOpen: () => open };
  h.key("Enter");
  assert.deepEqual(calls, []);

  open = false;
  h.key("Enter");
  assert.deepEqual(calls, ["cut"]);
});

test("undo still reaches the dialog's own scope through a modal", () => {
  // The regression this guards: the print dialog pushes the eraser's history
  // scope, so with it open Ctrl+Z *is* the dialog's undo. A blanket "no keys
  // while a modal is up" rule takes that away silently — the button in the
  // dialog keeps working, so nothing looks broken until somebody reaches for
  // the shortcut they have always used.
  const h = setup();
  const calls = [];
  h.App.ui = { isDialogOpen: () => true };
  h.shortcuts.global([
    {
      combos: ["Mod+Z"],
      labelKey: "shortcuts.undo",
      overModal: true,
      run: () => calls.push("undo"),
    },
    {
      combos: ["Enter"],
      labelKey: "other",
      run: () => calls.push("enter"),
    },
  ]);

  h.key("Mod+Z");
  h.key("Enter");
  assert.deepEqual(calls, ["undo"], "only the scope-routed entry survives");
});

test("nothing fires underneath the tour, overModal included", () => {
  // The tour binds on the capture phase and answers every key itself. A
  // walkthrough that can be undone out from under itself is worse than one
  // with no shortcuts at all.
  const h = setup();
  const calls = [];
  h.App.tour = { isOpen: () => true };
  h.shortcuts.global([
    {
      combos: ["Mod+Z"],
      labelKey: "shortcuts.undo",
      overModal: true,
      run: () => calls.push("undo"),
    },
  ]);

  h.key("Mod+Z");
  assert.deepEqual(calls, []);
});

// ── Combo matching ───────────────────────────────────────────────────────────

test("an unmodified binding does not swallow the same key with Ctrl", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["S"], labelKey: "snap", run: () => calls.push("snap") },
  ]);
  h.key("S", { ctrlKey: true });
  assert.deepEqual(calls, [], "Ctrl+S belongs to the browser");
});

test("Mod matches Ctrl and Cmd alike", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["Mod+Z"], labelKey: "undo", run: () => calls.push("undo") },
  ]);

  h.key("z", { ctrlKey: true });
  h.key("z", { ctrlKey: false, metaKey: true });
  assert.deepEqual(calls, ["undo", "undo"]);
});

test("Shift is part of the combo, not noise", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.push(
    fakeContext("cut", [
      {
        combos: ["Backspace"],
        labelKey: "back",
        run: () => calls.push("back"),
      },
      {
        combos: ["Shift+Backspace"],
        labelKey: "forward",
        run: () => calls.push("forward"),
      },
    ]),
  );

  h.key("Backspace");
  h.key("Shift+Backspace");
  assert.deepEqual(calls, ["back", "forward"]);

  // …and a named key must not answer while Shift is down unless it said so.
  calls.length = 0;
  h.key("Backspace", { shiftKey: true });
  assert.deepEqual(calls, ["forward"]);
});

test("a symbol binding fires however the layout produces the symbol", () => {
  // A symbol is not a key. "?" is Shift+/ on a US layout and Shift+ß on a
  // German one, and the browser reports the symbol in e.key with shiftKey
  // still true — so asserting that Shift is up meant the binding whose entire
  // job is to reveal the other bindings could never fire on a real keyboard.
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["/"], labelKey: "slash", run: () => calls.push("slash") },
  ]);

  h.key("/", { shiftKey: true });
  assert.deepEqual(calls, ["slash"], "shifted into existence, still a match");

  h.key("/", { shiftKey: false });
  assert.deepEqual(calls, ["slash", "slash"], "and unshifted on a layout that has it");
});

test("the sheet opens from the keyboard the way a keyboard actually sends it", () => {
  // The end-to-end version of the case above, against the binding it was
  // reported broken on rather than against a stand-in.
  const h = setup();
  let opened = 0;
  h.App.ui = {
    isDialogOpen: () => false,
    openDialog: () => {
      opened += 1;
      return {};
    },
    closeDialog: () => {},
  };

  h.key("?", { shiftKey: true });
  assert.equal(opened, 1, "Shift+/ produces ? and must open the sheet");

  // F1 is one physical key on every layout, which is what makes it the
  // reliable half of the pair.
  const other = setup();
  let f1Opened = 0;
  other.App.ui = {
    isDialogOpen: () => false,
    openDialog: () => {
      f1Opened += 1;
      return {};
    },
    closeDialog: () => {},
  };
  other.key("F1");
  assert.equal(f1Opened, 1);
});

test("a letter binding is still not reachable with Shift held", () => {
  // The exemption above is for symbols only; S and Shift+S remain distinct.
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["S"], labelKey: "snap", run: () => calls.push("snap") },
  ]);
  h.key("S", { shiftKey: true });
  assert.deepEqual(calls, []);
});

test("Alt is not asserted unless the combo asks for it", () => {
  // Alt suspends snapping in the cut tool, and every other key has to keep
  // working for as long as it is held.
  const h = setup();
  const calls = [];
  h.shortcuts.global([
    { combos: ["S"], labelKey: "snap", run: () => calls.push("snap") },
  ]);
  h.key("S", { altKey: true });
  assert.deepEqual(calls, ["snap"]);
});

// ── Display ──────────────────────────────────────────────────────────────────

test("a combo renders as the caps it is drawn with", () => {
  const h = setup();
  assert.deepEqual(h.shortcuts.keyCaps("Mod+Shift+Z"), ["Ctrl", "Shift", "Z"]);
  assert.deepEqual(h.shortcuts.keyCaps("Escape"), ["Esc"]);
  assert.deepEqual(h.shortcuts.keyCaps("Backspace"), ["Backspace"]);
  assert.equal(h.shortcuts.hint("Mod+Z"), "Ctrl+Z");
});

test("a Mac is told about the key its keyboard is labelled with", () => {
  const h = setup({ navigator: { platform: "MacIntel" } });
  assert.equal(h.shortcuts.isMac(), true);
  assert.equal(h.shortcuts.hint("Mod+Z"), "⌘+Z");
  assert.deepEqual(h.shortcuts.keyCaps("Alt"), ["⌥"]);
});

test("a gesture with no key still renders the way it was written", () => {
  // "Right-drag" is not a keystroke; it must not come out blank, shouted, or
  // flattened to lower case just because matching is case-insensitive.
  const h = setup();
  assert.deepEqual(h.shortcuts.keyCaps("Right-drag"), ["Right-drag"]);
  assert.deepEqual(h.shortcuts.keyCaps("Double-click"), ["Double-click"]);
  assert.deepEqual(h.shortcuts.keyCaps("Shift+drag"), ["Shift", "drag"]);
});

// ── Held keys ────────────────────────────────────────────────────────────────
//
// A hold is the only entry kind whose failure is destructive rather than
// inert. A binding that does not fire is a key that does nothing; a hold that
// does not *release* is a gesture left running — for the vertex eraser, a
// pointer that goes on destroying what it touches after the key came up.

test("a hold runs on the way down and releases on the way up", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.push({
    id: "erase",
    titleKey: "g",
    entries: [
      {
        combos: ["X"],
        labelKey: "erase",
        hold: true,
        run: () => calls.push("down"),
        release: () => calls.push("up"),
      },
    ],
  });

  h.key("X");
  assert.deepEqual(calls, ["down"]);
  h.keyUp("X");
  assert.deepEqual(calls, ["down", "up"]);
});

test("auto-repeat is one press, however many the platform sends", () => {
  // Holding a key down delivers keydown over and over. Starting the gesture
  // again on each of them would re-arm it dozens of times a second, and every
  // arming after the first would be paired with no release at all.
  const h = setup();
  let downs = 0;
  h.shortcuts.push({
    id: "erase",
    titleKey: "g",
    entries: [
      {
        combos: ["X"],
        labelKey: "erase",
        hold: true,
        run: () => (downs += 1),
        release: () => {},
      },
    ],
  });

  h.key("X");
  h.key("X");
  h.key("X");
  assert.equal(downs, 1);
});

test("losing the window releases whatever is held", () => {
  // Alt+Tab away mid-sweep and the keyup is delivered to somebody else. With
  // nothing watching for that, the eraser is still armed when you come back.
  const h = setup();
  let released = 0;
  h.shortcuts.push({
    id: "erase",
    titleKey: "g",
    entries: [
      {
        combos: ["X"],
        labelKey: "erase",
        hold: true,
        run: () => {},
        release: () => (released += 1),
      },
    ],
  });

  h.key("X");
  assert.equal(h.shortcuts.isHeld("X"), true);
  h.blur();
  assert.equal(released, 1);
  assert.equal(h.shortcuts.isHeld("X"), false);
});

test("a release with nothing held is not a release", () => {
  const h = setup();
  let released = 0;
  h.shortcuts.push({
    id: "erase",
    titleKey: "g",
    entries: [
      {
        combos: ["X"],
        labelKey: "erase",
        hold: true,
        run: () => {},
        release: () => (released += 1),
      },
    ],
  });

  h.keyUp("X");
  h.shortcuts.releaseAll();
  assert.equal(released, 0);
});

test("a hold whose when() says no never starts, so it never owes a release", () => {
  const h = setup();
  const calls = [];
  h.shortcuts.push({
    id: "erase",
    titleKey: "g",
    entries: [
      {
        combos: ["X"],
        labelKey: "erase",
        hold: true,
        when: () => false,
        run: () => calls.push("down"),
        release: () => calls.push("up"),
      },
    ],
  });

  h.key("X");
  h.keyUp("X");
  assert.deepEqual(calls, []);
});

// ── Dialogs ──────────────────────────────────────────────────────────────────
//
// A dialog used to be a hole in this module: App.ui was asked whether one was
// open and, if so, nothing fired except the handful of entries marked
// overModal. That was right about the tool underneath and wrong about the
// dialog itself, which had no way to register anything — so the print view's
// one binding lived on a listener nobody could enumerate, and "?", whose
// entire job is to enumerate, was the binding a dialog blocked.

function withModes(h) {
  h.shortcuts.push({
    id: "cut",
    titleKey: "g",
    entries: [{ combos: ["Enter"], labelKey: "cut", run: () => h.fired.push("cut") }],
  });
  h.shortcuts.push({
    id: "print",
    titleKey: "g",
    exclusive: true,
    entries: [
      { combos: ["Enter"], labelKey: "print", run: () => h.fired.push("print") },
    ],
  });
}

test("an exclusive context is a floor the tool underneath cannot answer through", () => {
  const h = setup();
  h.fired = [];
  withModes(h);

  h.key("Enter");
  assert.deepEqual(h.fired, ["print"], "the dialog answers, the cut tool does not");
});

test("undo still reaches the dialog's own scope through the floor", () => {
  // The print dialog pushes the eraser's history scope, so Ctrl+Z inside it
  // *is* the dialog's undo. It had that before contexts existed and a rule
  // about modals must not quietly take it away.
  const h = setup();
  h.fired = [];
  h.shortcuts.global([
    {
      combos: ["Mod+Z"],
      labelKey: "undo",
      overModal: true,
      run: () => h.fired.push("undo"),
    },
  ]);
  withModes(h);

  h.key("Mod+Z");
  assert.deepEqual(h.fired, ["undo"]);
});

test("the sheet opens over a dialog instead of replacing it", () => {
  // openDialog() closes whatever is already up. Routing the sheet through it
  // meant asking for help in the print view closed the print view — which is
  // why "?" was blocked there rather than fixed.
  const h = setup();
  h.setDialogOpen(true);
  h.shortcuts.openSheet();

  assert.equal(h.shortcuts.isSheetOpen(), true);
  assert.equal(h.isDialogOpen(), true, "the screen underneath survives");

  h.shortcuts.closeSheet();
  assert.equal(h.shortcuts.isSheetOpen(), false);
  assert.equal(h.isDialogOpen(), true, "and is still there afterwards");
});

test("Escape closes the sheet and stops there", () => {
  const h = setup();
  h.setDialogOpen(true);
  h.shortcuts.openSheet();

  h.key("Escape");
  assert.equal(h.shortcuts.isSheetOpen(), false);
  assert.equal(h.isDialogOpen(), true, "not the thing it was explaining");
});

// ── Typing ───────────────────────────────────────────────────────────────────

const TEXT_FIELD = { tagName: "INPUT" };

test("nothing fires into a text field unless it says it should", () => {
  const h = setup();
  h.fired = [];
  h.shortcuts.push({
    id: "form",
    titleKey: "g",
    exclusive: true,
    entries: [
      {
        combos: ["Enter"],
        labelKey: "submit",
        whileTyping: true,
        run: () => h.fired.push("submit"),
      },
      { combos: ["E"], labelKey: "erase", run: () => h.fired.push("erase") },
    ],
  });

  h.key("E", { target: TEXT_FIELD });
  assert.deepEqual(h.fired, [], "a bare letter is a letter while typing");

  h.key("Enter", { target: TEXT_FIELD });
  assert.deepEqual(h.fired, ["submit"], "type a number, press Enter");
});

test("a combo that produces a character never fires into a text field", () => {
  // "?" and F1 both open the sheet and only one of them can be typed. Without
  // this rule, marking that pair as whileTyping — which F1 needs — would mean
  // a question mark in the locality field produces a list of shortcuts and no
  // question mark.
  const h = setup();
  h.key("?", { target: TEXT_FIELD });
  assert.equal(h.shortcuts.isSheetOpen(), false);

  h.key("F1", { target: TEXT_FIELD });
  assert.equal(h.shortcuts.isSheetOpen(), true, "but F1 is not a character");
});

// ── What the sheet promises is what the sheet does ───────────────────────────
//
// Both tests below are the same bug seen from two sides: a key was listed as
// available and did nothing.

test("a slider or a checkbox is not a text field", () => {
  // "Is a text field focused?" was answered by the tag name, and most of the
  // controls in the app's own dialogs are <input>. Click the print dialog's
  // Sharpen box or touch its zoom slider and six of its eight keys went dead
  // while the sheet went on listing all eight; the boundary dialog was worse,
  // because its one control is a range and the keys it killed were the arrows
  // documented to move it.
  const h = setup();
  h.fired = [];
  h.shortcuts.push({
    id: "dialog",
    titleKey: "g",
    exclusive: true,
    entries: [
      { combos: ["E"], labelKey: "erase", run: () => h.fired.push("erase") },
    ],
  });

  for (const type of ["checkbox", "range", "color", "file", "radio"]) {
    h.fired = [];
    h.key("E", { target: { tagName: "INPUT", type } });
    assert.deepEqual(h.fired, ["erase"], `${type} took the key`);
  }

  h.fired = [];
  h.key("E", { target: { tagName: "INPUT", type: "text" } });
  assert.deepEqual(h.fired, [], "a real text field still swallows it");

  h.fired = [];
  h.key("E", { target: { tagName: "INPUT" } });
  assert.deepEqual(h.fired, [], "and so does one with no type at all");
});

test("the sheet greys what a modal has taken away", () => {
  // The sheet rendered every context on the stack as though all of them were
  // live, so a dialog produced a list whose top group worked and whose lower
  // groups were decoration. Nothing was wrong with the dispatch; the list
  // simply was not asking dispatch's question.
  const h = setup();
  h.shortcuts.push({
    id: "tool",
    titleKey: "tool",
    entries: [{ combos: ["T"], labelKey: "toolKey", run: () => {} }],
  });

  const before = h.shortcuts.snapshot();
  const toolBefore = before.find((group) => group.id === "tool");
  assert.equal(toolBefore.entries[0].available, true);

  h.shortcuts.push({
    id: "dialog",
    titleKey: "dialog",
    exclusive: true,
    entries: [{ combos: ["Enter"], labelKey: "go", run: () => {} }],
  });

  const after = h.shortcuts.snapshot();
  assert.equal(
    after.find((group) => group.id === "dialog").entries[0].available,
    true,
    "the dialog's own keys still work",
  );
  assert.equal(
    after.find((group) => group.id === "tool").entries[0].available,
    false,
    "the tool underneath does not",
  );

  // Undo is the exception the barrier was written to keep: a dialog that has
  // pushed a history scope is what Ctrl+Z is addressed to.
  const global = after.find((group) => group.id === "global");
  const sheetRow = global.entries.find((e) => e.labelKey === "shortcuts.sheet");
  assert.equal(sheetRow.available, true, "? survives everything");
});

test("the sheet does not report itself as a modal covering the map", () => {
  // openSheet() with nothing else on screen goes through App.ui.openDialog, so
  // isDialogOpen() becomes true — and a blanket rule read off that would grey
  // every global key at exactly the moment somebody is reading the list to
  // find out which keys are live.
  const h = setup();
  h.shortcuts.openSheet();
  assert.equal(h.isDialogOpen(), true, "it really is the dialog");

  const global = h.shortcuts.snapshot().find((group) => group.id === "global");
  assert.ok(
    global.entries.every((entry) => !entry.covered),
    "nothing global is covered by the sheet itself",
  );
});
