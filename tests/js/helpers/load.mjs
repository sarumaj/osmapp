/**
 * load.mjs — run a browser module under Node so it can be tested.
 *
 * The client has no build step. It is a list of plain <script> files, each of
 * which wraps itself in an IIFE and assigns the result to `window.App`, so
 * there is nothing for a test to `import`. This helper compiles a source file
 * into a function that takes the browser globals it expects, then calls it
 * with whatever stubs the test supplies. The source file is read as-is and is
 * never modified or transformed.
 *
 * A typical test loads the module under test together with any real
 * dependencies it needs, and stubs the rest afterwards:
 *
 *     const App = loadApp(["util.js", "state.js", "labels.js"], { window, L });
 *     App.i18n = { t: (key) => key };
 *     App.labels.init();
 *
 * Order matters. Files are executed in the order given, exactly as the browser
 * would run the <script> tags, so a module has to be listed after anything it
 * reads at load time.
 *
 * The implementation uses `vm.compileFunction` rather than `vm.createContext`,
 * and the distinction matters. A vm context is a separate JavaScript realm
 * with its own set of built-ins, so an array created inside one does not share
 * a prototype with an array created out here — and `assert.deepStrictEqual`
 * compares prototypes, so every structural comparison in every test would
 * fail. Compiling into a function keeps the module in this realm.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "osmapp", "static", "js");

const GLOBALS = ["window", "document", "navigator", "turf", "L", "console"];

/**
 * Execute browser modules and return the `App` object they built.
 *
 * @param {string[]} files paths relative to src/osmapp/static/js, in load order
 * @param {Object} [stubs] replacements for the browser globals. Any of
 *   `window`, `document`, `navigator`, `turf`, `L` and `console` may be given;
 *   `window`, `document` and `navigator` default to empty objects, `turf` and
 *   `L` to undefined — correct for a module that never touches them — and
 *   `console` to the real one, so a module that warns during load still warns
 *   somewhere a test run can show it.
 * @returns {Object} the `App` namespace, read back off the window object used
 */
export function loadApp(files, stubs = {}) {
  // A test supplies its own window when the module reads bootstrap data off
  // it — the basemap descriptor the server inlines into the page, or
  // localStorage. Note that App is read back off this same object rather than
  // off a global, so a test holding a reference to its own window can inspect
  // anything else the module wrote there.
  const win = stubs.window ?? {};
  const env = {
    window: win,
    // document and navigator are stubbable because several modules
    // feature-detect the browser, and a feature detection is only worth
    // testing if it can be driven against more than one browser's behavior.
    document: stubs.document ?? {},
    navigator: stubs.navigator ?? {},
    turf: stubs.turf,
    L: stubs.L,
    // Defaulted rather than stubbed away: several modules warn on a path a test
    // deliberately exercises, and swallowing those by default would hide them
    // from every test that is not asserting on them. Supply one to capture.
    console: stubs.console ?? console,
  };

  for (const file of files) {
    const source = readFileSync(join(JS_DIR, file), "utf8");
    vm.compileFunction(source, GLOBALS, { filename: file })(...GLOBALS.map((name) => env[name]));
  }
  return win.App;
}
