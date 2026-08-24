/**
 * pdflib.mjs - load the real, vendored pdf-lib for the tests that need it.
 *
 * Most of pdfdoc.js is tested without it, and that is the right choice there:
 * the placeholder geometry and the annotation maths are arithmetic, and a stub
 * records exactly which calls were made.
 *
 * This is for the one part where the library is the subject. A PDF name tree
 * has two shapes, the reader has to survive both, and what a stub returns for
 * a key that is not there is a decision the test author makes rather than one
 * pdf-lib makes - which is precisely how a reader that throws on every file
 * the app itself writes passed its tests.
 *
 * Compiled through `vm.compileFunction` for the same reason helpers/turf.mjs
 * is: a separate vm realm has its own built-ins, so a Uint8Array made in one
 * would not satisfy an `instanceof` out here.
 *
 * pdf-lib ships as a UMD bundle. It checks for `exports`, `module` and
 * `define` in that order before falling back to assigning onto a global, so
 * the three undefined parameters are what steer it down the fallback branch,
 * and `self`/`window` are what it assigns to.
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
  "unpkg.com",
  "pdf-lib",
  "dist",
  "pdf-lib.min.js",
);

let cached = null;

/** @returns {Object} the PDFLib namespace */
export function loadPdfLib() {
  if (cached) return cached;
  const source = readFileSync(BUNDLE, "utf8");
  const load = vm.compileFunction(
    source + "\n;return PDFLib;",
    ["exports", "module", "define", "self", "window"],
    { filename: BUNDLE },
  );
  cached = load(undefined, undefined, undefined, globalThis, globalThis);
  return cached;
}
