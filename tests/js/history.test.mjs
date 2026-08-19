/**
 * Undo and redo, and which stack they land on.
 *
 * ── The thing being tested ────────────────────────────────────────────────
 *
 * "Undo" does not mean one thing in this app. Halfway through drawing a split
 * line it means "take back that vertex". With the print dialog open it means
 * "take back that eraser stroke". The rest of the time it means "take back
 * that edit to the territories".
 *
 * history.js resolves this with a stack of scopes: a modal tool pushes a scope
 * when it opens and pops it when it closes, and undo is delegated to whichever
 * scope is on top. Read the header of src/osmapp/static/js/history.js for the
 * shape a scope has to have.
 *
 * Getting the routing wrong is not a milder version of the right answer. Undo
 * that reaches past the open tool destroys territory work the user was not
 * editing and cannot get back, in response to a keystroke that was aimed at a
 * half-drawn line.
 *
 * ── What the tests are organized around ───────────────────────────────────
 *
 * Three failure modes, each with its own section below.
 *
 * *Entry points disagreeing.* Undo is reachable from the keyboard, from the
 * toolbar button and from a tool's own Back button. All three have to resolve
 * to the same scope, and so do the depths and tooltip keys they display — a
 * button labelled from one stack that acts on another is worse than no label.
 *
 * *Asymmetry between undo and redo.* A tool that intercepts one and not the
 * other lets the unhandled key fall through to the territories mid-edit.
 *
 * *A leaked scope.* This one has no symptom at the moment it happens: undo goes
 * on answering for a tool that has closed, so the territories stop being
 * undoable for the rest of the session with nothing on screen to say so.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/**
 * Build a history module with its neighbors stubbed, and return handles for
 * driving it.
 *
 * history.js talks to three of them: App.state, App.polygons for taking and
 * restoring snapshots, and App.controls.refresh() to repaint the toolbar
 * buttons. All three are stubbed, because these tests are about which stack a
 * keystroke reaches rather than about geometry.
 *
 * shortcuts.js is the exception and is loaded for real. Undo and redo are
 * registered as shortcuts rather than handled by a private key listener, so
 * stubbing it would mean asserting that Ctrl+Z reaches the active scope
 * against a stub of the very thing doing the reaching.
 */
function setup() {
  // shortcuts.js also listens on window, for keyup and for the window losing
  // focus, so that a key held down when the user tabs away is not left stuck.
  // Only keydown is captured here, since that is what these tests fire.
  const window = { addEventListener() {} };
  const listeners = [];
  const document = {
    addEventListener(type, fn) {
      if (type === "keydown") listeners.push(fn);
    },
  };

  const App = loadApp(["shortcuts.js", "history.js"], { window, document });

  let clusters = [{ id: "a" }];
  let refreshes = 0;

  App.state = { clusters };
  App.polygons = {
    clusterFeatures: () => clusters,
    setClusters: (features) => {
      clusters = features;
      App.state.clusters = features;
    },
  };
  App.controls = {
    refresh() {
      refreshes += 1;
    },
  };
  App.i18n = { onChange() {}, t: (key) => key };
  App.dom = {};

  App.shortcuts.init();
  App.history.init();

  return {
    history: App.history,
    current: () => clusters,
    set: (features) => {
      clusters = features;
      App.state.clusters = features;
    },
    refreshes: () => refreshes,
    /** Fire a keydown at whatever history.js bound to the document. */
    key: (key, mods = {}) => {
      const event = {
        key,
        ctrlKey: true,
        shiftKey: false,
        metaKey: false,
        target: { tagName: "DIV" },
        preventDefault() {},
        ...mods,
      };
      listeners.forEach((fn) => fn(event));
    },
  };
}

/** A scope that records what it was asked to do. */
function fakeScope(id, state = {}) {
  const calls = [];
  return {
    id,
    calls,
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    canUndo: () => state.canUndo ?? true,
    canRedo: () => state.canRedo ?? true,
    undoDepth: () => state.undoDepth ?? 0,
    redoDepth: () => state.redoDepth ?? 0,
    undoKey: `toolbar.undo${id}`,
    redoKey: `toolbar.redo${id}`,
  };
}

// ── the base scope ───────────────────────────────────────────────────────────

test("the base scope restores the previous cluster geometry", () => {
  const h = setup();

  h.history.push(); // records [{id:"a"}]
  h.set([{ id: "a" }, { id: "b" }]);

  assert.equal(h.history.canUndo(), true);
  h.history.undo();
  assert.deepEqual(h.current(), [{ id: "a" }]);

  assert.equal(h.history.canRedo(), true);
  h.history.redo();
  assert.deepEqual(h.current(), [{ id: "a" }, { id: "b" }]);
});

test("nothing recorded means nothing to undo", () => {
  const h = setup();
  assert.equal(h.history.canUndo(), false);
  assert.equal(h.history.canRedo(), false);
  h.history.undo(); // must not throw, must not mutate
  assert.deepEqual(h.current(), [{ id: "a" }]);
});

test("a new edit branches off the timeline", () => {
  // A new action branches the timeline: anything that had been undone belongs
  // to a future that no longer exists, so the redo stack has to be cleared.
  // Otherwise redo resurrects geometry from an abandoned branch.
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);
  h.history.undo();
  assert.equal(h.history.canRedo(), true);

  h.history.push();
  assert.equal(h.history.canRedo(), false, "the redo branch should be gone");
});

test("clear empties both stacks", () => {
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);
  h.history.undo();
  h.history.clear();
  assert.equal(h.history.canUndo(), false);
  assert.equal(h.history.canRedo(), false);
});

test("the snapshot is a copy, not a reference", () => {
  // push() has to store a deep copy rather than a reference. The features it
  // snapshots stay live and are mutated in place by later edits, so a stored
  // reference would be rewritten by the very change undo is meant to reverse.
  const h = setup();
  const live = [{ id: "a", properties: { printed: null } }];
  h.set(live);
  h.history.push();
  live[0].properties.printed = "2026-08-09T00:00:00.000Z";
  h.set([{ id: "b" }]);

  h.history.undo();
  assert.equal(h.current()[0].properties.printed, null);
});

// ── the scope stack ──────────────────────────────────────────────────────────

test("a pushed scope takes over undo, redo and the tooltip keys", () => {
  const h = setup();
  h.history.push(); // the base scope now has something to undo

  const cut = fakeScope("cut", { undoDepth: 3, redoDepth: 1 });
  h.history.pushScope(cut);

  assert.equal(h.history.scopeId(), "cut");
  assert.equal(h.history.undoDepth(), 3);
  assert.equal(h.history.redoDepth(), 1);
  assert.equal(h.history.undoKey(), "toolbar.undocut");
  assert.equal(h.history.redoKey(), "toolbar.redocut");

  h.history.undo();
  h.history.redo();
  assert.deepEqual(cut.calls, ["undo", "redo"]);
  assert.deepEqual(h.current(), [{ id: "a" }], "the base stack must be untouched");
});

test("popping a scope hands undo back to the territories", () => {
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);

  const cut = fakeScope("cut");
  h.history.pushScope(cut);
  h.history.popScope("cut");

  assert.equal(h.history.scopeId(), "clusters");
  h.history.undo();
  assert.deepEqual(h.current(), [{ id: "a" }]);
  assert.deepEqual(cut.calls, []);
});

test("pushing the same id twice replaces rather than stacks", () => {
  // Pushing a scope id that is already on the stack replaces it rather than
  // stacking a second copy. A tool that restarts without a clean teardown —
  // an exception during exit, a mode reopened from a context menu — would
  // otherwise leave a scope behind that nothing will ever pop.
  const h = setup();
  const first = fakeScope("cut");
  const second = fakeScope("cut");

  h.history.pushScope(first);
  h.history.pushScope(second);
  h.history.popScope("cut");

  assert.equal(h.history.scopeId(), "clusters", "one pop should clear both");
});

test("popping an id that is not on the stack is a no-op", () => {
  const h = setup();
  const cut = fakeScope("cut");
  h.history.pushScope(cut);
  h.history.popScope("erase");
  assert.equal(h.history.scopeId(), "cut");
});

test("scopes nest, innermost first", () => {
  const h = setup();
  const cut = fakeScope("cut");
  const erase = fakeScope("erase");

  h.history.pushScope(cut);
  h.history.pushScope(erase);
  assert.equal(h.history.scopeId(), "erase");

  h.history.popScope("erase");
  assert.equal(h.history.scopeId(), "cut");
});

test("push() always records territory geometry, whatever mode is active", () => {
  // push() always targets the base scope, whatever is on top. Modes never
  // call it themselves, but an edit to the territories can complete while a
  // tool is open, and that belongs on the cluster stack rather than on the
  // tool's.
  const h = setup();
  h.history.pushScope(fakeScope("cut"));

  h.history.push();
  h.history.popScope("cut");
  h.set([{ id: "b" }]);

  h.history.undo();
  assert.deepEqual(h.current(), [{ id: "a" }]);
});

test("a scope that refuses is not called", () => {
  const h = setup();
  const cut = fakeScope("cut", { canUndo: false, canRedo: false });
  h.history.pushScope(cut);

  h.history.undo();
  h.history.redo();
  assert.deepEqual(cut.calls, []);
});

// ── the entry points agree ───────────────────────────────────────────────────

test("the keyboard routes to the active scope, redo included", () => {
  // Undo and redo have to be routed by the same rule. A scope that handles
  // one and lets the other fall through to the territories restores old
  // geometry underneath a split line that is still being drawn.
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);

  const cut = fakeScope("cut");
  h.history.pushScope(cut);

  h.key("z");
  h.key("y");
  h.key("z", { shiftKey: true });

  assert.deepEqual(cut.calls, ["undo", "redo", "redo"]);
  assert.deepEqual(h.current(), [{ id: "b" }], "the territories must not have moved");
});

test("the keyboard leaves text fields alone", () => {
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);

  h.key("z", { target: { tagName: "INPUT" } });
  h.key("z", { target: { tagName: "TEXTAREA" } });
  h.key("z", { target: { tagName: "SELECT" } });
  assert.deepEqual(h.current(), [{ id: "b" }]);

  h.key("z", { ctrlKey: false });
  assert.deepEqual(h.current(), [{ id: "b" }], "Z on its own is not undo");
});

test("the toolbar and the keyboard get the same answer", () => {
  // The toolbar button and the keyboard must resolve to the same scope. A
  // button wired straight to history.undo() bypasses the delegation and so
  // does something different from the shortcut that is meant to mirror it.
  const h = setup();
  const cut = fakeScope("cut");
  h.history.pushScope(cut);

  h.history.undo(); // what the toolbar button calls
  h.key("z"); // what the shortcut calls

  assert.deepEqual(cut.calls, ["undo", "undo"]);
});

test("every mutation repaints the buttons", () => {
  // The reported depths drive the button tooltips, so any mutation has to
  // sync them. Otherwise the button reads "Undo 3 changes" over a stack that
  // now holds two.
  const h = setup();
  const before = h.refreshes();
  h.history.push();
  h.history.pushScope(fakeScope("cut"));
  h.history.popScope("cut");
  h.history.clear();
  assert.ok(h.refreshes() > before + 3);
});

// ── every modal tool registers a scope ───────────────────────────────────────

test("a mode without a scope of its own is the bug this stack exists to stop", () => {
  // Every modal tool has to register a scope, not just the ones whose own
  // undo is obvious. A tool without one lets Ctrl+Z reach past what is being
  // edited and undo the last change to the territories — work the tool was
  // never touching.
  //
  // The assertion is that the base scope does *not* answer while a tool is
  // open, rather than that a particular tool's scope does. What makes this a
  // bug is the fall-through, not which tool happened to be in front.
  const h = setup();
  h.history.push();
  h.set([{ id: "b" }]);

  const merge = fakeScope("merge");
  h.history.pushScope(merge);
  h.key("z");

  assert.deepEqual(merge.calls, ["undo"]);
  assert.deepEqual(
    h.current(),
    [{ id: "b" }],
    "the territories must not move while a selection is being collected",
  );

  // …and the moment the tool closes its scope is popped, so the territories
  // are undoable again. A tool that pushes but never pops fails here.
  h.history.popScope("merge");
  h.key("z");
  assert.deepEqual(h.current(), [{ id: "a" }]);
});

test("the tooltip key follows the scope, so undo never lies about what it will take back", () => {
  // The tooltip key comes from the active scope too. A button reading "Undo
  // last change" while the action would actually take back a selection is
  // describing the fall-through above rather than what the button does.
  const h = setup();
  assert.equal(h.history.undoKey(), "toolbar.undo");

  h.history.pushScope(fakeScope("merge"));
  assert.equal(h.history.undoKey(), "toolbar.undomerge");
  assert.equal(h.history.redoKey(), "toolbar.redomerge");

  h.history.popScope("merge");
  assert.equal(h.history.undoKey(), "toolbar.undo");
});
