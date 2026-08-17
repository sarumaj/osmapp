/**
 * The <script> list in index.html, and the order the files appear in.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The client has no build step and no import statements. It is a list of
 * <script> tags sharing one `window.App` object, which leaves two mistakes
 * possible that a bundler would catch on its own.
 *
 * The first is a file added to static/js and never listed. It gets precached
 * by the service worker and shipped to every visitor, and never runs.
 *
 * The second is a file listed in the wrong position. Whether that breaks
 * anything depends on when the module it depends on is read. Most of the app
 * resolves `App.something` inside a function body, which happens long after
 * every script has run, so a misordering is invisible — until it reaches a
 * module that resolves a dependency at the top level, where the value is read
 * during load. Then it is a TypeError in the console on a page that has
 * already gone blank, and the stack points at the file that was loaded too
 * early rather than at the list that ordered it.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 * That the list and the directory contain the same files; that running the
 * whole list in its declared order produces every module; and that the two
 * files whose position genuinely matters are where they belong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JS_DIR = join(ROOT, "src", "osmapp", "static", "js");
const INDEX = readFileSync(join(ROOT, "src", "osmapp", "templates", "index.html.j2"), "utf8");

/** The js/*.js filenames index.html loads, in the order it loads them. */
const LISTED = [...INDEX.matchAll(/filename='js\/([\w.-]+\.js)'/g)].map((m) => m[1]);
const ON_DISK = readdirSync(JS_DIR).filter((f) => f.endsWith(".js"));

test("index.html lists exactly the modules on disk", () => {
  assert.deepEqual(
    [...LISTED].sort(),
    [...ON_DISK].sort(),
    "a module that is not listed is shipped and never run",
  );
});

test("main.js is loaded last", () => {
  // main.js is the entry point: it wires the map together and reads the
  // surface of every other module, so nothing may load after it.
  assert.equal(LISTED[LISTED.length - 1], "main.js");
});

test("every module loads, in the declared order, and registers itself", () => {
  // The stubs below only have to survive load time. Nothing here calls any
  // module's init(), so what is under test is the work each file does at the
  // top level — which is precisely where a misordering causes a failure, and
  // is why the stubs can be as crude as they are.
  const noop = () => {};
  const chainable = () => stubLayer();
  function stubLayer() {
    return new Proxy(
      {},
      {
        get: (_, key) => (key === "then" ? undefined : chainable),
        apply: chainable,
      },
    );
  }

  const L = new Proxy(
    {
      Class: { extend: () => function () {} },
      Control: Object.assign(function () {}, { extend: () => function () {} }),
      DomEvent: { on: noop, off: noop, disableClickPropagation: noop, disableScrollPropagation: noop },
      DomUtil: { addClass: noop, removeClass: noop },
      Util: {},
    },
    { get: (target, key) => (key in target ? target[key] : chainable) },
  );

  const window = {
    addEventListener: noop,
    location: { pathname: "/", search: "" },
    localStorage: {
      getItem: () => null,
      setItem: noop,
      removeItem: noop,
    },
    Intl: globalThis.Intl,
  };
  const document = {
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, getContext: () => null }),
    documentElement: {},
    body: {},
  };

  // LISTED rather than a hand-maintained array, so this test follows the page:
  // adding a script tag automatically brings the new module under test.
  const App = loadApp(LISTED, {
    window,
    document,
    navigator: { onLine: true, languages: ["en"] },
    turf: {},
    L,
  });

  assert.ok(App, "window.App should exist after the whole list has run");

  // A file's module name is its filename without the extension, in camel case
  // — print-filters.js registers as App.printFilters. main.js is excluded
  // because it registers nothing, and state.js is handled separately below
  // because it is a plain object rather than an IIFE.
  const expected = LISTED.filter((f) => f !== "main.js").map((f) =>
    f.replace(/\.js$/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
  );

  for (const name of expected) {
    if (name === "state") {
      assert.ok(App.state, "App.state should be present");
      continue;
    }
    assert.ok(App[name], `App.${name} is missing — check where ${name}.js sits in the list`);
  }
});

test("util.js is loaded before everything that reads it at load time", () => {
  // util.js owns the localStorage wrapper and the OSM tag normalizer and has
  // no dependencies of its own, so it goes first. This is the case described
  // in the file header: a module that resolves App.util into a `var` at the
  // top level rather than inside a function captures undefined if util.js has
  // not run yet, and does so silently until that value is used.
  assert.equal(LISTED[0], "util.js");
});
