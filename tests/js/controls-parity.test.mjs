/**
 * The controls, read as a set rather than one at a time.
 *
 * Every gap this file pins was invisible while each tool was looked at on its
 * own, and obvious the moment the three modal tools were put side by side:
 *
 *   • Cut bound Backspace and nothing for going forward, though redoPoint()
 *     had existed as long as undoPoint() and Ctrl+Y already reached it.
 *   • Merge bound Escape and nothing else — no Enter, though cut and trim
 *     both commit on Enter and merge is exactly as modal as either.
 *   • Trim's two buttons were the only actions on any mode toolbar with no
 *     key at all.
 *   • The outer-boundary drawer had no way to take back a vertex, though
 *     Leaflet.Editable has shipped pop() since 1.3.0.
 *
 * So the assertions here are about symmetry, not about behavior: a tool that
 * can undo can redo, a modal tool commits and cancels the same way as its
 * neighbours, and every action on a toolbar has a key beside it. Those are
 * properties of the whole control surface, and they are the properties that
 * decay one reasonable-looking commit at a time.
 *
 * Read off the source rather than off a running app on purpose. Standing the
 * modes up would mean Leaflet, a map, a street graph and a boundary — and the
 * question being asked is not whether the cut tool cuts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JS_DIR = join(ROOT, "src", "osmapp", "static", "js");
const INDEX = readFileSync(
  join(ROOT, "src", "osmapp", "templates", "index.html"),
  "utf8",
);

const SOURCE = {
  editing: readFileSync(join(JS_DIR, "editing.js"), "utf8"),
  trim: readFileSync(join(JS_DIR, "trim.js"), "utf8"),
  main: readFileSync(join(JS_DIR, "main.js"), "utf8"),
  history: readFileSync(join(JS_DIR, "history.js"), "utf8"),
  ui: readFileSync(join(JS_DIR, "ui.js"), "utf8"),
  polygons: readFileSync(join(JS_DIR, "polygons.js"), "utf8"),
};

/**
 * The combos a named context registers, e.g. contextCombos("editing",
 * "CUT_KEYS") -> ["Enter", "Backspace", …]. Deliberately a scan rather than a
 * load: the contexts close over module state that only exists inside a
 * running mode.
 */
function contextCombos(module, name) {
  const source = SOURCE[module];
  const start = source.indexOf(`var ${name} = {`);
  assert.notEqual(start, -1, `${name} not found in ${module}.js`);

  // Balance braces from the opening one so the walk stops at the end of the
  // literal rather than at the first nested close.
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const body = source.slice(start, end);
  return [...body.matchAll(/combos:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
  );
}

/** Entries in a context that actually fire, by their combos. */
function boundCombos(module, name) {
  const source = SOURCE[module];
  const start = source.indexOf(`var ${name} = {`);
  const body = source.slice(start, source.indexOf("\n  };", start));
  return [...body.matchAll(/\{[^{}]*combos:\s*\[([^\]]*)\][\s\S]*?\}/g)]
    .filter((match) => !/note:\s*true/.test(match[0]))
    .flatMap((match) =>
      [...match[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
    );
}

const MODES = [
  { name: "cut", module: "editing", context: "CUT_KEYS" },
  { name: "merge", module: "editing", context: "MERGE_KEYS" },
  { name: "trim", module: "trim", context: "TRIM_KEYS" },
  { name: "draw", module: "main", context: "DRAW_KEYS" },
];

// ── Every modal tool agrees on the basics ────────────────────────────────────

for (const mode of MODES) {
  test(`${mode.name} commits on Enter and cancels on Escape`, () => {
    // Merge had neither half of this. A modal tool that leaves one of them to
    // the mouse is a tool you cannot finish without moving your hand.
    const combos = contextCombos(mode.module, mode.context);
    assert.ok(combos.includes("Enter"), `${mode.name} has no Enter`);
    assert.ok(combos.includes("Escape"), `${mode.name} has no Escape`);
  });
}

for (const mode of MODES) {
  test(`${mode.name} can step back`, () => {
    const combos = contextCombos(mode.module, mode.context);
    assert.ok(
      combos.includes("Backspace"),
      `${mode.name} cannot take back its last step`,
    );
  });
}

for (const mode of ["cut", "merge", "trim"]) {
  test(`${mode} can step forward as well as back`, () => {
    // The asymmetry that started all of this: an undo with no redo makes the
    // safe move "abandon it and start again".
    //
    // Drawing a boundary is exempt and stays that way. Leaflet.Editable's
    // pop() discards the vertex rather than handing it back, so a forward
    // step would mean keeping a shadow copy of a list the library owns — a
    // worse bargain than the missing key.
    const spec = MODES.find((m) => m.name === mode);
    const combos = contextCombos(spec.module, spec.context);
    assert.ok(
      combos.includes("Shift+Backspace"),
      `${mode} steps back but not forward`,
    );
  });
}

// ── The registry and the handlers are the same list ──────────────────────────

test("no mode keeps a private keydown listener", () => {
  // A listener outside the registry is a key the sheet cannot show and the
  // context stack cannot order — which is the arrangement all of this
  // replaced. The two survivors are deliberate and named in the source: the
  // tour and the placement frame bind on the capture phase and are modal in
  // the strong sense.
  for (const module of ["editing", "trim", "main", "history"]) {
    const listeners = [
      ...SOURCE[module].matchAll(/addEventListener\(\s*["']keydown["']/g),
    ];
    if (module === "editing") {
      // Alt is a modifier hold rather than a shortcut, and lives next to the
      // pointer state it changes.
      assert.equal(listeners.length, 1, "editing.js: only the Alt hold");
      assert.match(SOURCE.editing, /keydown["'],\s*_onModifierDown/);
    } else {
      assert.equal(
        listeners.length,
        0,
        `${module}.js binds the keyboard outside the registry`,
      );
    }
  }
});

test("every context is popped by the mode that pushed it", () => {
  // A leaked context answers the keyboard for a tool that has closed, and
  // does it silently.
  for (const mode of MODES) {
    const source = SOURCE[mode.module];
    assert.match(
      source,
      new RegExp(`shortcuts\\.push\\(${mode.context}\\)`),
      `${mode.name} never pushes its context`,
    );
    assert.match(
      source,
      new RegExp(`shortcuts\\.pop\\(["']${mode.name}["']\\)`),
      `${mode.name} never pops its context`,
    );
  }
});

test("every modal tool registers a history scope", () => {
  // Without one, Ctrl+Z inside the tool reaches past it into the territories.
  const scopes = [
    ["editing", "CUT_SCOPE", "cut"],
    ["editing", "MERGE_SCOPE", "merge"],
    ["trim", "TRIM_SCOPE", "trim"],
  ];
  for (const [module, scope, id] of scopes) {
    assert.match(
      SOURCE[module],
      new RegExp(`history\\.pushScope\\(${scope}\\)`),
      `${id} never pushes ${scope}`,
    );
    assert.match(
      SOURCE[module],
      new RegExp(`history\\.popScope\\(["']${id}["']\\)`),
      `${id} never pops its scope`,
    );
  }
});

test("undo and redo are registered globally rather than bound privately", () => {
  assert.match(SOURCE.history, /shortcuts\.global\(/);
  assert.match(SOURCE.history, /combos:\s*\[["']Mod\+Z["']\]/);
  assert.match(SOURCE.history, /["']Mod\+Y["']/);
  assert.match(SOURCE.history, /["']Mod\+Shift\+Z["']/);
});

// ── Menus ────────────────────────────────────────────────────────────────────

test("every mode offers a context menu", () => {
  // The toolbar sits in a corner and the work happens under the cursor. Merge
  // and trim discarded the right button entirely; cut spent it on panning and
  // threw away the stationary case.
  assert.match(SOURCE.editing, /function _showCutMenu/);
  assert.match(SOURCE.editing, /function _showMergeMenu/);
  assert.match(SOURCE.trim, /function _showTrimMenu/);
  assert.match(SOURCE.polygons, /handleModeContextMenu/);
  assert.match(SOURCE.polygons, /trim\.handleContextMenu/);
});

test("the context menu keeps the promise role=menu makes", () => {
  // It was mouse-only, so the entries reachable by right-click were reachable
  // no other way.
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.ok(
      SOURCE.ui.includes(`"${key}"`),
      `the menu does not answer ${key}`,
    );
  }
});

test("one menu implementation, built from a list", () => {
  // Two builders would drift, and the one nobody remembered to update would
  // be the one on the mode that gets used least.
  assert.match(SOURCE.ui, /function showContextMenu/);
  assert.match(SOURCE.ui, /showContextMenu\(point, \[/, "the territory menu is built from the generic one");
  assert.ok(
    !INDEX.includes('id="tpl-polygon-menu"'),
    "the hard-wired menu template is gone",
  );
});

// ── Toolbars ─────────────────────────────────────────────────────────────────

test("the cut toolbar has a forward button beside its back button", () => {
  const start = INDEX.indexOf('id="tpl-cut-toolbar"');
  const body = INDEX.slice(start, INDEX.indexOf("</template>", start));
  assert.ok(body.includes('data-role="undo"'));
  assert.ok(body.includes('data-role="redo"'), "Back still has no forward twin");
});

test("the merge toolbar can clear its selection", () => {
  const start = INDEX.indexOf('id="tpl-merge-toolbar"');
  const body = INDEX.slice(start, INDEX.indexOf("</template>", start));
  assert.ok(body.includes('data-role="clear"'), "trim has had one from the start");
});

test("every modal tool explains itself with a hint banner", () => {
  for (const id of ["tpl-draw-hint", "tpl-merge-hint"]) {
    assert.ok(INDEX.includes(`id="${id}"`), `${id} is missing`);
  }
  // Trim's is mounted from its own template body; what matters is that all
  // three modes mount one.
  assert.match(SOURCE.editing, /tpl-merge-hint/);
  assert.match(SOURCE.editing, /tpl-draw-hint/);
  assert.match(SOURCE.trim, /_hint = D\.mount/);
});
