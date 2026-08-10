/**
 * Undo, and which stack it lands on.
 *
 * "Undo" is not one thing here. Halfway through drawing a split line it means
 * "take back that vertex"; with the print dialog open it means "take back that
 * eraser stroke"; the rest of the time it means "take back that edit to the
 * territories". Getting that wrong is not a smaller version of the right
 * answer — undoing a merge because someone hit Ctrl+Z while placing a vertex
 * destroys work that the vertex undo would have left alone.
 *
 * Two shapes of that bug shipped before the scope stack existed, and both are
 * pinned below: the toolbar button called undo() directly and so ignored the
 * routing that the keyboard handler applied, and cut mode intercepted undo but
 * not redo, so Ctrl+Y mid-draw restored old geometry underneath a split line
 * still being drawn. Everything now goes through the same delegation, so what
 * has to be asserted is that *every* entry point sees the same answer — the
 * depths and the tooltip keys as much as the actions.
 *
 * A leaked scope is the other failure worth pinning. It has no symptom at the
 * moment it happens: undo simply keeps answering for a tool that closed, and
 * the territories quietly stop being undoable for the rest of the session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/**
 * history.js talks to three neighbours: App.state, App.polygons for the
 * snapshots, and App.controls.refresh() to repaint the buttons. All three are
 * stubbed, because this is about the routing rather than about geometry.
 *
 * shortcuts.js is loaded for real rather than stubbed. Undo and redo are
 * registered with it now instead of being a private listener, so stubbing it
 * would leave the one thing worth asserting about the keyboard — that Ctrl+Z
 * reaches the *active scope* — asserted against a stub of the thing doing the
 * reaching.
 */
function setup() {
  // shortcuts.js listens for keyup and for the window losing focus as well,
  // to end a held key it would otherwise never hear the release of.
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
  // Redo after an undo after a fresh push would otherwise resurrect geometry
  // from a future that no longer exists.
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
  // push() stores JSON, so mutating the live feature afterwards must not
  // rewrite what undo will restore.
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
  // A mode that restarts without a clean teardown would otherwise leak a
  // scope, and undo would answer for a tool that has closed — for the rest of
  // the session, with nothing on screen to say so.
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
  // Modes never call push(), but a merge finishing while a scope happens to be
  // open must still land on the cluster stack rather than on the mode's.
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
  // The original bug: cut mode intercepted Ctrl+Z but not Ctrl+Y, so redo fell
  // through to the cluster stack and restored old geometry underneath a split
  // line that was still being drawn.
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
  // They used to disagree: the button called history.undo() directly and so
  // skipped the routing the keyboard applied.
  const h = setup();
  const cut = fakeScope("cut");
  h.history.pushScope(cut);

  h.history.undo(); // what the toolbar button calls
  h.key("z"); // what the shortcut calls

  assert.deepEqual(cut.calls, ["undo", "undo"]);
});

test("every mutation repaints the buttons", () => {
  // The depths drive the tooltips, so a mutation that does not sync leaves
  // "Undo 3 changes" over a button that now has two.
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
  // Cut and the eraser registered scopes from the start; merge and trim did
  // not, and the consequence is the one below — Ctrl+Z inside a modal tool
  // reaching past the thing being edited and undoing the last change to the
  // territories, which is work the tool was never touching.
  //
  // Asserted against the base scope rather than against merge or trim
  // directly, because what makes it a bug is the fall-through, not which
  // tool happened to be open.
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

  // …and the moment the tool closes, the territories are undoable again.
  h.history.popScope("merge");
  h.key("z");
  assert.deepEqual(h.current(), [{ id: "a" }]);
});

test("the tooltip key follows the scope, so undo never lies about what it will take back", () => {
  // "Undo last change" while the thing that will actually be taken back is a
  // selected territory is a tooltip describing the bug above.
  const h = setup();
  assert.equal(h.history.undoKey(), "toolbar.undo");

  h.history.pushScope(fakeScope("merge"));
  assert.equal(h.history.undoKey(), "toolbar.undomerge");
  assert.equal(h.history.redoKey(), "toolbar.redomerge");

  h.history.popScope("merge");
  assert.equal(h.history.undoKey(), "toolbar.undo");
});
