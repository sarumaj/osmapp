/**
 * turf.mjs — load the real, vendored turf for the tests that need it.
 *
 * Most tests stub turf instead of using this, and that is usually the right
 * choice: they are checking bookkeeping rather than geometry, and a stub
 * records exactly which turf calls the module made and with what.
 *
 * Reach for the real thing when the behavior under test *is* the geometry —
 * whether a union actually dissolves a shared boundary, whether a point really
 * falls inside a polygon. Stubbing turf there would only assert that the stub
 * was called, which is a test of the test.
 *
 * The bundle is executed through `vm.compileFunction` for the same reason
 * load.mjs uses it: a separate vm realm has its own built-ins, so a polygon
 * built by a turf living in one would not share Array.prototype with the
 * assertions out here.
 *
 * The three undefined arguments are not an oversight. turf ships as a UMD
 * bundle, which picks its export mechanism by checking for `exports`, `module`
 * and `define` in that order and falling back to assigning onto `globalThis`.
 * Passing all three as parameters that are declared but undefined is what
 * steers it down the fallback branch, and the `globalThis` it then assigns to
 * is this realm's.
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
  "turf",
  "turf.min.js",
);

let _turf = null;

/**
 * The vendored turf, parsed once and shared by every caller.
 *
 * @returns {Object} the same turf namespace the browser gets
 */
export function loadTurf() {
  if (_turf) return _turf;
  vm.compileFunction(readFileSync(BUNDLE, "utf8"), ["module", "exports", "define"], {
    filename: "turf.min.js",
  })(undefined, undefined, undefined);
  _turf = globalThis.turf;
  if (!_turf) throw new Error("the turf bundle did not export anything");
  return _turf;
}

/**
 * Build an axis-aligned square as a turf polygon.
 *
 * A fixture helper: most geometry assertions are about areas and containment
 * rather than about shape, and a square keeps the expected numbers something a
 * reader can verify in their head. The ring is closed, as GeoJSON requires.
 *
 * @param {Object} turf the namespace from loadTurf()
 * @param {number} lng left edge
 * @param {number} lat bottom edge
 * @param {number} size edge length in degrees
 */
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
