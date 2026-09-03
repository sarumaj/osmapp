// scripts/build-app-assets.js
//
// Minifies the application's own JavaScript and CSS into
// src/osmapp/static/dist, which internal/assets.py serves in place of the
// sources when it is present. Nothing here is configurable: there is one
// stylesheet, one bundle, and one template that names what goes into it.
//
// The load order is not written down twice. templates/index.html.j2 lists the
// modules in dependency order for the unbundled path, with the comments that
// explain why particular files come before others, and this script reads that
// list out of the template. A module added to the page is therefore in the
// bundle with no second edit, and one removed cannot linger here.
//
// The sources are left untouched. `npm run bundle` produces an additional
// tree rather than rewriting anything, so tests/js keeps loading the readable
// files by path and a checkout that never runs this step still serves a
// working page - just an unminified one.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import CleanCSS from "clean-css";
import { minify } from "terser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => relative(root, p);

const STATIC = resolve(root, "src/osmapp/static");
const TEMPLATE = resolve(root, "src/osmapp/templates/index.html.j2");
const DEST = resolve(STATIC, "dist");
const BUNDLE = resolve(DEST, "js/app.min.js");
const STYLESHEET = resolve(DEST, "css/style.min.css");
const SOURCE_STYLESHEET = resolve(STATIC, "css/style.css");

/** Every `js/<name>.js` the template loads, in the order it loads them. */
function scriptOrder() {
  const template = readFileSync(TEMPLATE, "utf8");
  const names = [...template.matchAll(/filename='js\/([A-Za-z0-9._-]+\.js)'/g)].map(
    (match) => match[1],
  );
  if (!names.length)
    throw new Error(
      `${rel(TEMPLATE)} names no js/ sources - the bundle would be empty. ` +
        `Either the template stopped listing them or the pattern here needs ` +
        `updating.`,
    );
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate)
    throw new Error(`${rel(TEMPLATE)} loads ${duplicate} twice`);
  return names;
}

const size = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const br = (text) =>
  brotliCompressSync(Buffer.from(text), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;

/** What the two encodings the server offers make of a finished file. */
function report(label, before, after) {
  const percent = ((1 - after.length / before.length) * 100).toFixed(1);
  console.log(
    `  ${label}: ${size(before.length)} -> ${size(after.length)} (-${percent}%), ` +
      `gzip ${size(gzipSync(Buffer.from(after), { level: 9 }).length)}, ` +
      `brotli ${size(br(after))}`,
  );
}

if (existsSync(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
  console.log(`Cleaned ${rel(DEST)}\n`);
}

// ── JavaScript ───────────────────────────────────────────────────────────────

const names = scriptOrder();
console.log(`Bundling ${names.length} modules named in ${rel(TEMPLATE)}...`);

const sources = names.map((name) => ({
  name,
  code: readFileSync(resolve(STATIC, "js", name), "utf8"),
}));

// Minified one file at a time rather than as one input: each module is a
// self-contained IIFE assigned to a property of `window.App`, and minifying
// them separately keeps that boundary exactly where the sources put it.
// Compressing the concatenation is where the cross-file redundancy is
// recovered anyway, and the server does that.
const minified = [];
for (const { name, code } of sources) {
  const { code: out } = await minify(code, { sourceMap: false });
  if (!out) throw new Error(`${name}: terser produced nothing`);
  minified.push(out);
}

// Terser omits a trailing semicolon, and every module ends in a call
// expression. Joined on a newline alone, `})()` followed by `(function(){` on
// the next line parses as a call of the first module's return value.
const bundle = minified.map((code) => `${code};`).join("\n");

// A concatenation that does not parse is the one way this step can break the
// page while producing plausible output, and it is cheap to rule out.
await minify(bundle, { compress: false, mangle: false }).catch((error) => {
  throw new Error(`the bundle does not parse: ${error.message}`);
});

mkdirSync(dirname(BUNDLE), { recursive: true });
writeFileSync(BUNDLE, bundle, "utf8");

const joinedSources = sources.map(({ code }) => code).join("\n");
report(rel(BUNDLE), joinedSources, bundle);

// ── CSS ──────────────────────────────────────────────────────────────────────

const css = readFileSync(SOURCE_STYLESHEET, "utf8");
const { errors, styles } = new CleanCSS({ level: 2 }).minify(css);
if (errors.length) throw new Error(`CleanCSS: ${errors.join("; ")}`);

// style.css contains no url() references, so moving it out of static/css into
// static/dist/css cannot break a relative path. Adding one to the source means
// making it absolute, or rewriting it here.
if (/url\(/.test(css))
  throw new Error(
    `${rel(SOURCE_STYLESHEET)} now has url() references, which resolve ` +
      `relative to the stylesheet and would break under ${rel(DEST)}`,
  );

mkdirSync(dirname(STYLESHEET), { recursive: true });
writeFileSync(STYLESHEET, styles, "utf8");
report(rel(STYLESHEET), css, styles);

console.log(`\nDone - ${rel(DEST)} is what the page will load.`);
