/**
 * The script list in index.html, and the order it is in.
 *
 * The client has no build step and no imports: it is a list of <script> tags
 * and a shared `window.App`, which means two mistakes are possible that a
 * bundler would have caught for free.
 *
 * A file can be added to static/js and never listed, in which case it is
 * precached by the service worker, shipped to every visitor, and never runs.
 * Or a file can be listed in the wrong place, in which case whether it works
 * depends on whether the module it needs happens to be read at load time or at
 * call time. That second one is genuinely nasty: most of the app resolves
 * `App.something` inside a function, so a misordering hides until the one line
 * that resolves it at the top level runs, and then it is a TypeError in the
 * console on a page that has already gone blank.
 *
 * So: the list and the directory have to agree, and loading every file in the
 * declared order has to produce every module.
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

/** The js/*.js files index.html loads, in order. */
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
  // It is the entry point and reads every other module's surface.
  assert.equal(LISTED[LISTED.length - 1], "main.js");
});

test("every module loads, in the declared order, and registers itself", () => {
  // Stubs only have to survive *load* time. Nothing here calls init(), so what
  // is being asserted is the top-level work each file does — which is exactly
  // where an ordering mistake bites.
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

  const App = loadApp(LISTED, {
    window,
    document,
    navigator: { onLine: true, languages: ["en"] },
    turf: {},
    L,
  });

  assert.ok(App, "window.App should exist after the whole list has run");

  // Every module named in the list, minus the two files that are not modules:
  // state.js is a plain object and main.js is the entry point.
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
  // It owns the localStorage wrapper and the OSM tag normalizer, and it has no
  // dependencies of its own, so it belongs at the front of the list. A module
  // that resolves App.util in a `var` rather than inside a function would
  // otherwise capture undefined.
  assert.equal(LISTED[0], "util.js");
});
