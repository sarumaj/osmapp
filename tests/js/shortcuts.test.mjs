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
  const window = {};
  const listeners = [];
  const document = {
    addEventListener(type, fn) {
      if (type === "keydown") listeners.push(fn);
    },
  };

  const App = loadApp(["shortcuts.js"], {
    window,
    document,
    navigator: nav ?? { platform: "Linux x86_64" },
  });

  App.i18n = { t: (key) => key };
  App.dom = {
    role: () => null,
    onRole: () => null,
    mount: () => ({}),
    text: () => {},
    toggleClass: () => {},
  };
  App.shortcuts.init();

  return {
    shortcuts: App.shortcuts,
    App,
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
