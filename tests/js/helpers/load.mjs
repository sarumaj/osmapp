/**
 * load.mjs — loads a browser module for testing.
 *
 * The client is plain <script> files that assign to `window.App`, so there is
 * nothing to `import`. Each source file is compiled into a function taking the
 * browser globals it expects and called with stubs; the file itself is never
 * modified.
 *
 * `vm.compileFunction` rather than `vm.createContext` on purpose: a new vm
 * context is a separate realm, so arrays built inside it do not share a
 * prototype with arrays out here and `assert.deepStrictEqual` rejects every
 * structural comparison.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const JS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "osmapp", "static", "js");

const GLOBALS = ["window", "document", "navigator", "turf", "L"];

export function loadApp(files, stubs = {}) {
  const win = {};
  const env = {
    window: win,
    // Overridable: anything that feature-detects the browser has to be driven
    // against more than one browser's behaviour to be worth testing.
    document: stubs.document ?? {},
    navigator: stubs.navigator ?? {},
    turf: stubs.turf,
    L: stubs.L,
  };

  for (const file of files) {
    const source = readFileSync(join(JS_DIR, file), "utf8");
    vm.compileFunction(source, GLOBALS, { filename: file })(...GLOBALS.map((name) => env[name]));
  }
  return win.App;
}
