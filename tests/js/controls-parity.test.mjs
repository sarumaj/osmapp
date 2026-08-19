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
 * neighbors, and every action on a toolbar has a key beside it. Those are
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
  join(ROOT, "src", "osmapp", "templates", "index.html.j2"),
  "utf8",
);

const CSS = readFileSync(
  join(ROOT, "src", "osmapp", "static", "css", "style.css"),
  "utf8",
);

const FA_CSS = readFileSync(
  join(
    ROOT,
    "src",
    "osmapp",
    "static",
    "vendor",
    "cdnjs.cloudflare.com",
    "ajax",
    "libs",
    "font-awesome",
    "css",
    "all.min.css",
  ),
  "utf8",
);

const SOURCE = {
  editing: readFileSync(join(JS_DIR, "editing.js"), "utf8"),
  trim: readFileSync(join(JS_DIR, "trim.js"), "utf8"),
  main: readFileSync(join(JS_DIR, "main.js"), "utf8"),
  history: readFileSync(join(JS_DIR, "history.js"), "utf8"),
  ui: readFileSync(join(JS_DIR, "ui.js"), "utf8"),
  polygons: readFileSync(join(JS_DIR, "polygons.js"), "utf8"),
  outline: readFileSync(join(JS_DIR, "outline.js"), "utf8"),
  controls: readFileSync(join(JS_DIR, "controls.js"), "utf8"),
  shortcuts: readFileSync(join(JS_DIR, "shortcuts.js"), "utf8"),
  labels: readFileSync(join(JS_DIR, "labels.js"), "utf8"),
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
  { name: "outline", module: "outline", context: "OUTLINE_KEYS" },
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

for (const mode of ["cut", "merge", "trim", "outline"]) {
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
    ["outline", "OUTLINE_SCOPE", "outline"],
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
  assert.match(SOURCE.outline, /function _showMenu/);
  assert.match(SOURCE.ui, /function showOuterContextMenu/);
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

// ── Dialogs answer the keyboard too ──────────────────────────────────────────
//
// A screen that takes over has to register its own keys, not merely silence the
// tools beneath it. Deciding on "is a dialog open" does only the second half,
// which leaves a dialog's bindings on listeners the sheet cannot see, number
// fields that do not answer Enter, and "?" blocked in exactly the screens with
// the most keys worth listing.
//
// Read off the source for the same reason as everything above: standing these
// up means a map, a PDF and a network.

const DIALOG_SOURCE = {
  print: readFileSync(join(JS_DIR, "print.js"), "utf8"),
  clustering: readFileSync(join(JS_DIR, "clustering.js"), "utf8"),
  boundary: readFileSync(join(JS_DIR, "boundary.js"), "utf8"),
  ui: readFileSync(join(JS_DIR, "ui.js"), "utf8"),
  labels: readFileSync(join(JS_DIR, "labels.js"), "utf8"),
};

const DIALOGS = [
  { name: "print", module: "print", id: "print" },
  { name: "placement", module: "print", id: "place" },
  { name: "partition", module: "clustering", id: "partition" },
  { name: "boundary", module: "boundary", id: "boundary" },
  { name: "confirm", module: "ui", id: "confirm" },
  // The last screen that took over without registering anything, so "?" over
  // it listed the keys of the map underneath and said nothing about the list.
  { name: "territory list", module: "labels", id: "list" },
];

for (const dialog of DIALOGS) {
  test(`the ${dialog.name} dialog pushes a context and pops it again`, () => {
    const source = DIALOG_SOURCE[dialog.module];
    assert.match(
      source,
      new RegExp(`shortcuts\\.push\\(`),
      `${dialog.name} never pushes a context`,
    );
    assert.match(
      source,
      new RegExp(`shortcuts\\.pop\\(["']${dialog.id}["']\\)`),
      `${dialog.name} never pops "${dialog.id}" — a context that outlives its dialog answers for a screen that has closed`,
    );
  });
}

// ── The main view answers the keyboard too ───────────────────────────────────
//
// The same asymmetry as everything above, one level out. Every modal tool in
// the app binds a dozen keys; *entering* one of them was mouse-only, so the
// shortcut sheet on the main map listed five lines one keystroke before it
// listed fourteen — which reads as an app that mostly has no shortcuts.

test("every key a toolbar button advertises is a key the app answers", () => {
  // The tooltip is a promise. A button that says "— T" and a registry with no
  // T in it is the documentation-drift this whole module exists to catch,
  // pointed the other way.
  const advertised = [...SOURCE.controls.matchAll(/\bshortcut:\s*"([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(advertised.length >= 8, "the toolbar advertises no keys at all");

  const answered = new Set(
    [SOURCE.controls, SOURCE.shortcuts]
      .flatMap((source) => [...source.matchAll(/combos:\s*\[([^\]]+)\]/g)])
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((c) => c[1])),
  );

  const unanswered = advertised.filter((key) => !answered.has(key));
  assert.deepStrictEqual(unanswered, []);
});

test("entering a tool has a key, the way leaving one does", () => {
  for (const label of [
    "goDraw",
    "goTrim",
    "goSplit",
    "goCut",
    "goMerge",
    "goNumbers",
    "goPrint",
    "goTour",
  ]) {
    assert.match(
      SOURCE.controls,
      new RegExp(`labelKey:\\s*"shortcuts\\.${label}"`),
      `nothing enters the tool behind shortcuts.${label}`,
    );
  }
});

test("a mode-entry key stands down while a mode is running", () => {
  // Single letters are only safe out here because the tools own them while
  // they are open. Without the gate, T inside the merge tool starts trimming
  // from underneath it — the tools bind their own letters, but only the ones
  // they use.
  assert.match(SOURCE.controls, /function _idle\(/);
  assert.match(SOURCE.controls, /function _whenIdle\(/);
  assert.match(SOURCE.controls, /\.map\(_whenIdle\)/);
});

// ── Menus ────────────────────────────────────────────────────────────────────

test("right-clicking bare ground is not left to the browser", () => {
  // Every menu in the app needed something under the pointer, so empty map
  // fell through to the browser's own — including in the two modes whose hint
  // banner promises a menu and whose menu is the only route to some of what
  // they do.
  assert.match(SOURCE.ui, /function showMapContextMenu/);
  assert.match(SOURCE.main, /map\.on\("contextmenu"/);
  assert.match(SOURCE.main, /App\.ui\.showMapContextMenu/);
  // Cut is the one exception and has to stay one: it spends the right button
  // on panning.
  assert.match(SOURCE.main, /if \(s\.editMode\) return;/);
});

test("a menu never opens behind a dialog", () => {
  // --z-menu is below --z-dialog, so one opened while a dialog is up renders
  // underneath it: invisible, and still holding the document click listener
  // that swallows the next click anywhere on the page.
  assert.match(SOURCE.ui, /if \(isDialogOpen\(\)\) return null;/);
});

// ── Dialogs are modal for the mouse and the keyboard alike ───────────────────

test("every dialog gets a veil and a way to ask for the keys", () => {
  // aria-modal="true" was a claim about where focus and clicks can go, and it
  // was true of neither: the map still panned, the toolbar was still live, and
  // Tab walked straight out of the print dialog into it.
  for (const id of ["tpl-dialog-veil", "tpl-dialog-help"]) {
    assert.ok(INDEX.includes(`id="${id}"`), `${id} is missing`);
  }
  assert.match(SOURCE.ui, /D\.mountOnMap\("tpl-dialog-veil"/);
  assert.match(SOURCE.ui, /function addHelpButton/);
  assert.match(SOURCE.ui, /function trapFocus/);
  // The placement frame mounts itself rather than going through openDialog,
  // and it is the screen with the most gestures and the least room to write
  // them down.
  assert.match(DIALOG_SOURCE.print, /App\.ui\.addHelpButton\(_placeDialog\)/);
});

test("the sheet and the confirm prompt are the two that need no help button", () => {
  // One is the help; the other is a sentence with two buttons. A "?" on
  // either points at itself or at nothing.
  const start = SOURCE.ui.indexOf("var NO_HELP");
  assert.notEqual(start, -1, "NO_HELP is gone — every dialog now gets one");
  const line = SOURCE.ui.slice(start, SOURCE.ui.indexOf("};", start));
  assert.ok(line.includes("tpl-shortcuts-dialog"));
  assert.ok(line.includes("tpl-confirm-dialog"));
});

// ── Printing has a button ────────────────────────────────────────────────────

test("the thing the app exists to produce is reachable from the toolbar", () => {
  // Printing was context-menu-only: a gesture you have to already know about,
  // aimed at a shape you have to already have found. The tour conceded as
  // much — it had a step whose job was to introduce a screen with no control.
  assert.match(SOURCE.controls, /id:\s*"print"/);
  assert.match(SOURCE.controls, /titleKey:\s*"toolbar\.print"/);
  assert.ok(
    INDEX.includes('data-role="print"'),
    "the territory list has no printer beside its rows",
  );
  assert.match(SOURCE.labels, /App\.print\.printCluster/);
});

test("the row printer stays live offline", () => {
  // Composition is client-side and the basemap comes out of the tile cache,
  // so the printer no longer hides when the connection goes.
  const start = INDEX.indexOf('id="tpl-territory-row"');
  const row = INDEX.slice(start, INDEX.indexOf("</template>", start));
  assert.ok(!row.includes("data-online-only"));
});

test("every dialog context is exclusive", () => {
  // Without it the tool behind the dialog keeps answering, which is what
  // being modal is supposed to prevent — and the blanket rule that used to
  // provide it is exactly what these contexts replaced.
  const ids = DIALOGS.map((d) => d.id);
  const found = [];
  for (const source of Object.values(DIALOG_SOURCE)) {
    for (const match of source.matchAll(/id:\s*"([\w-]+)"[\s\S]{0,200}?exclusive:\s*true/g)) {
      found.push(match[1]);
    }
  }
  for (const id of ids) {
    assert.ok(found.includes(id), `the "${id}" context is not exclusive`);
  }
});

test("the print view no longer keeps its binding on the dialog node", () => {
  // One listener, one key, invisible to the sheet. It is the pattern this
  // registry exists to replace, and print.js was the last place using it.
  const listeners = [
    ...DIALOG_SOURCE.print.matchAll(/_dialog\.addEventListener\(\s*["']keydown["']/g),
  ];
  assert.equal(listeners.length, 0);
});

test("the placement frame keeps its capture listener, and says why", () => {
  // The exception, and a deliberate one: the dialog lives inside the Leaflet
  // map container, whose own handler pans on an arrow press, so the event has
  // to be stopped before it bubbles rather than answered when it arrives. The
  // keys are still listed — as notes — so the sheet knows about them.
  assert.match(
    DIALOG_SOURCE.print,
    /addEventListener\("keydown", _placeKeys, true\)/,
    "the capture listener is the placement frame's implementation",
  );
  assert.match(DIALOG_SOURCE.print, /var PLACE_KEYS = \{/);
});

test("the gestures the print view lists are the modifiers it reads", () => {
  // The sheet said Alt-drag rotates, which is not a gesture this dialog has:
  // Shift starts the turn and Alt only takes the snapping off it. On a Mac
  // that rendered as ⌥ beside an on-screen hint that said Shift — two labels
  // for one gesture, disagreeing.
  //
  // Checked against the handlers rather than against a list, because a list
  // is what was wrong. Every modifier the pointer handlers test for has to
  // appear in a combo, and nothing may claim a modifier they never read.
  const source = DIALOG_SOURCE.print;

  const rotateStart = /if \(e\.shiftKey\) \{[\s\S]{0,200}?_rotate = \{/.test(source);
  assert.ok(rotateStart, "shift is what starts a rotation drag");

  // Bounded rather than [^)]*: the angle argument has parentheses of its own.
  const freeform = /_setRotation\([^;]{0,120}e\.altKey\)/.test(source);
  assert.ok(freeform, "alt is what makes the angle freeform");

  const context = source.slice(source.indexOf("var PRINT_KEYS = {"));
  const body = context.slice(0, context.indexOf("\n  };"));
  assert.match(body, /combos: \["Shift\+drag"\]/, "so Shift+drag must be listed");
  assert.doesNotMatch(
    body,
    /combos: \["Alt\+drag"\]/,
    "and Alt must not be listed as a gesture of its own",
  );
});

// ── The icons are real ───────────────────────────────────────────────────────

test("every glyph the toolbar names exists in the icon font", () => {
  // A name Font Awesome does not define renders as nothing at all: the tile
  // keeps its label, its tooltip and its click, and loses the only thing a
  // collapsed panel has left. Nothing else in the suite can see that — the
  // spec is valid JavaScript and the button works.
  //
  // The free set is not stable across majors: fa-vector-square is absent from
  // 7.x, so a rename arrives with a dependency bump rather than with a typo.
  //
  // The bundle is minified with aliases grouped into one rule
  // (`.fa-warning,.fa-triangle-exclamation{--fa:"\f071"}`), so the selector is
  // matched inside a rule head rather than at the start of one.
  const named = [
    ...SOURCE.controls.matchAll(/\bicon:\s*"(fa-[\w-]+)"/g),
  ].map((m) => m[1]);
  assert.ok(named.length >= 15, "the toolbar names no icons at all");

  const missing = named.filter(
    (name) => !new RegExp(`\\.${name}[,{]`).test(FA_CSS),
  );
  assert.deepStrictEqual(missing, []);
});

// ── What is shown is answered in one place ───────────────────────────────────

test("the layer switcher is the toolbar, not a second panel", () => {
  // "What is shown" is answered by one group in one panel. A second control in
  // another corner splits that answer in two, and the number chips — a view
  // switch that is not a layer — have no place to live in a switcher that only
  // holds layers.
  assert.ok(
    !/L\.control\s*\n?\s*\.layers\(/.test(SOURCE.controls),
    "the Leaflet layer control is back",
  );
  assert.match(SOURCE.controls, /key:\s*"view"/);
  assert.match(SOURCE.controls, /titleKey:\s*"toolbar\.groupView"/);
});

test("zooming is the toolbar's too, not Leaflet's control beside it", () => {
  // Same argument as the layer switcher above, and the last control it left
  // behind: Leaflet's zoom pair sat in the top-left corner the panel occupies,
  // styled by leaflet.css and by nothing in this app, and named neither of its
  // two buttons. So the map had one piece of chrome that looked like it came
  // from a different program — which is the whole thing the single panel was
  // built to end.
  assert.match(
    SOURCE.main,
    /zoomControl:\s*false/,
    "Leaflet's own zoom control is back beside the panel",
  );
  for (const id of ["zoom-in", "zoom-out"]) {
    assert.ok(
      SOURCE.controls.includes(`id: "${id}"`),
      `the View group has no ${id} tile`,
    );
  }
  assert.match(SOURCE.controls, /_map\.zoomIn\(\)/);
  assert.match(SOURCE.controls, /_map\.zoomOut\(\)/);

  // Greyed at the ends of the scale, with a tooltip that says why — the same
  // bargain every other unavailable button in the panel makes. Which only
  // holds while something repaints it: the scroll wheel and a fitBounds change
  // these two buttons' availability without anyone touching the panel.
  assert.match(SOURCE.controls, /function canZoomIn\(/);
  assert.match(SOURCE.controls, /function canZoomOut\(/);
  assert.match(SOURCE.controls, /disabledTitleKey:\s*"toolbar\.atMaxZoom"/);
  assert.match(SOURCE.controls, /disabledTitleKey:\s*"toolbar\.atMinZoom"/);
  assert.match(
    SOURCE.controls,
    /\.on\("zoomend", refresh\)/,
    "nothing repaints the pair when the map zooms by itself",
  );
});

test("every layer the old switcher offered still has a switch", () => {
  // The five overlays and the basemaps. A layer with no switch cannot be turned
  // off, and nothing about the map says which one is missing.
  for (const group of [
    "outerPolygonLayerGroup",
    "streetsLayerGroup",
    "buildingsLayerGroup",
    "innerPolygonsLayerGroup",
  ]) {
    assert.ok(
      SOURCE.controls.includes(`_toggleOverlay("${group}")`),
      `${group} has no switch`,
    );
    assert.ok(
      SOURCE.controls.includes(`_overlayShown("${group}")`),
      `${group}'s switch does not show its state`,
    );
  }
  // The gaps layer is the one that is not merely a draw call: switching it off
  // stops the subtraction, so it goes through the module rather than the map.
  assert.match(SOURCE.controls, /App\.gaps\.setVisible\(!App\.gaps\.isVisible\(\)\)/);
  // The basemap is a drop-down built from App.basemap, because which layers
  // exist is a server decision and the choice is exclusive.
  assert.match(SOURCE.controls, /custom:\s*_mountBasemapPicker/);
  assert.match(SOURCE.controls, /App\.basemap\.entries\(\)/);
  assert.match(SOURCE.controls, /App\.basemap\.select\(select\.value\)/);
  assert.ok(
    INDEX.includes('id="tpl-basemap-control"'),
    "the basemap drop-down has no template",
  );
});

test("both drop-downs show a glyph and a label, and survive the collapse", () => {
  // The collapsed panel drops every .tb-item__label, so a control whose only
  // identity is its label goes blank there. Both of these name the current
  // choice with a glyph and the control with a label, which is what lets the
  // label go without the tile becoming unreadable.
  for (const id of ["tpl-basemap-control", "tpl-language-control"]) {
    const start = INDEX.indexOf(`id="${id}"`);
    assert.notEqual(start, -1, `${id} is missing`);
    const body = INDEX.slice(start, INDEX.indexOf("</template>", start));
    assert.match(body, /class="tb-item tb-item--select"/, `${id} is not a select tile`);
    assert.match(body, /class="tb-item__icon"/, `${id} has no glyph`);
    assert.match(body, /class="tb-item__label"/, `${id} has no label`);
  }
  assert.match(CSS, /\.tb-panel\.is-collapsed \.tb-item__label/);
  // One rule for both, so the two cannot drift apart.
  assert.match(CSS, /\.lang-select,\s*\n\.basemap-select \{/);
});

test("both drop-downs list a pictogram and a name, not one or the other", () => {
  // The two arrived at this from opposite ends: a flag with no language name,
  // and layer names with no pictogram. Either half alone costs something — a
  // list of bare flags cannot be read by anyone who does not know the flags, and
  // a list of bare names cannot be scanned without reading it.
  //
  // Checked as "the option text is built from both parts", because the parts
  // themselves live in different places: the languages are literals in i18n.js,
  // the basemap names come out of the dictionary through t().
  assert.match(
    SOURCE.controls,
    /textContent = lang\.flag \+ " " \+ lang\.name/,
    "the language list drops one half",
  );
  assert.match(
    SOURCE.controls,
    /textContent = _emoji\(entry\.id\) \+ " " \+ T\(entry\.labelKey\)/,
    "the basemap list drops one half",
  );

  // And the tile's pictogram is the same string as the list's, so the two cannot
  // disagree about which basemap is which.
  assert.match(SOURCE.controls, /glyph\.textContent = _emoji\(id\)/);
  assert.match(SOURCE.controls, /var BASEMAP_EMOJI = \{/);
  assert.doesNotMatch(
    SOURCE.controls,
    /BASEMAP_ICONS/,
    "a second table for the tile is what this arrangement exists to avoid",
  );
});

test("the note about aid basemaps not printing survived the move", () => {
  // The one line that says a satellite card has no street names on it. Mounted
  // into the group whose basemaps it is about, from a template that carries the
  // English fallback for the moment before the dictionary arrives.
  assert.match(SOURCE.controls, /noteTemplate:\s*"tpl-toolbar-note"/);
  assert.match(SOURCE.controls, /function _syncAidNote/);
  assert.match(SOURCE.controls, /App\.basemap\.isAid\(\)/);
  assert.ok(INDEX.includes('id="tpl-toolbar-note"'), "the note template is gone");
  assert.ok(INDEX.includes('data-i18n="layers.aidNote"'), "the note lost its key");
});
