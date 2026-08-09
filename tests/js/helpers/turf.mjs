/**
 * turf.mjs — the real, vendored turf, in this realm.
 *
 * Most tests here stub turf, and should: they are about bookkeeping, and a
 * stub says exactly which calls the module makes. But three things in
 * geometry.js are *about* turf — unionHealed's grow/union/shrink, the hole
 * filter, and the interior point — and stubbing turf to test them would only
 * assert that the stub was called.
 *
 * The bundle is loaded the same way load.mjs loads app files, and for the same
 * reason: `vm.createContext` would put turf in a separate realm, so a
 * `turf.polygon()` built in there would not share Array.prototype with this
 * one and `assert.deepEqual` would reject every structural comparison.
 *
 * The UMD wrapper checks `exports`/`module`/`define` and, finding none,
 * assigns to `globalThis`. Passing all three as declared-but-undefined
 * parameters is what steers it down that branch — and the `globalThis` it
 * lands on is ours.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BUNDLE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "osmapp",
  "static",
  "vendor",
  "cdn.jsdelivr.net",
  "npm",
  "turf",
  "turf@6.5.0",
  "turf.min.js",
);

let _turf = null;

/** The vendored turf. Loaded once, shared by every caller. */
export function loadTurf() {
  if (_turf) return _turf;
  vm.compileFunction(readFileSync(BUNDLE, "utf8"), ["module", "exports", "define"], {
    filename: "turf.min.js",
  })(undefined, undefined, undefined);
  _turf = globalThis.turf;
  if (!_turf) throw new Error("the turf bundle did not export anything");
  return _turf;
}

/** A closed axis-aligned square as a turf polygon, for readable fixtures. */
export function square(turf, lng, lat, size) {
  return turf.polygon([
    [
      [lng, lat],
      [lng + size, lat],
      [lng + size, lat + size],
      [lng, lat + size],
      [lng, lat],
    ],
  ]);
}
