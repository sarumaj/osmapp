// scripts/copy-vendor.js
//
// Copies build artifacts from node_modules into src/osmapp/static/vendor,
// mirroring the CDN URL layout the app loads them from at runtime — minus the
// @version segment, which is intentionally omitted so that the paths in
// index.html never need updating when a dependency is bumped.
//
// Everything is driven by the "vendorConfig" section of package.json, so
// adding a vendored dependency needs an entry there and no change here. An
// entry is as short as the package layout allows:
//
//   "leaflet": {
//     "dest": "unpkg.com/leaflet/dist",
//     "files": [
//       { "src": "dist/leaflet-src.js", "out": "leaflet.js" },
//       { "src": "dist/leaflet.css" },
//       { "src": "dist/images" }
//     ]
//   }
//
//   - The key is the package name, and the version comes from the package's
//     own package.json. Nothing about a version is written down twice.
//   - "dest" is a path under destRoot, matching the CDN URL.
//   - "src" is one exact path inside the package.
//   - "out" defaults to the file name of "src", which is what most entries
//     want. Give it only to rename, or to place the file in a subdirectory.
//   - "mode" is inferred and rarely written: a directory is copied whole, an
//     already-minified source is copied verbatim, and any other .js/.mjs/.css
//     is minified on the way through. Set it explicitly to override.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import CleanCSS from "clean-css";
import { minify } from "terser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const cfg = pkg.vendorConfig;
if (!cfg) throw new Error('package.json has no "vendorConfig" section');

const destRoot = resolve(root, cfg.destRoot);

if (!destRoot.startsWith(root + sep))
  throw new Error(`destRoot must stay inside the repository: ${cfg.destRoot}`);

const rel = (p) => relative(root, p);
const inPackage = (name, path) => resolve(root, "node_modules", name, path);

function locate(name, src) {
  const path = inPackage(name, src);
  if (existsSync(path)) return path;
  throw new Error(
    `${name}: ${src} does not exist — the package layout changed, so both ` +
      `the vendorConfig in package.json and the vendored URLs in ` +
      `templates/index.html.j2 need updating`,
  );
}

function modeOf(src) {
  if (statSync(src).isDirectory()) return "dir";
  if (/\.min\.(js|mjs|css)$/.test(src)) return "raw";
  if (/\.(js|mjs)$/.test(src)) return "minjs";
  if (/\.css$/.test(src)) return "mincss";
  return "raw";
}

const percent = (before, after) =>
  `-${((1 - after.length / before.length) * 100).toFixed(1)}%`;

/** Each mode copies src to dst and returns what to print about it. */
const MODES = {
  async minjs(src, dst) {
    const code = readFileSync(src, "utf8");
    const { code: minified } = await minify(code, { sourceMap: false });
    writeFileSync(dst, minified, "utf8");
    return `minified JS ${percent(code, minified)}`;
  },

  mincss(src, dst) {
    const code = readFileSync(src, "utf8");
    const { errors, styles } = new CleanCSS({ level: 2 }).minify(code);
    if (errors.length) throw new Error(`CleanCSS: ${errors.join("; ")}`);
    writeFileSync(dst, styles, "utf8");
    return `minified CSS ${percent(code, styles)}`;
  },

  raw(src, dst) {
    cpSync(src, dst);
    return "raw";
  },

  dir(src, dst) {
    cpSync(src, dst, { recursive: true });
    return "dir";
  },
};

// ── Run ──────────────────────────────────────────────────────────────────

const packages = Object.entries(cfg.packages);

for (const [name] of packages) {
  if (!pkg.devDependencies?.[name])
    throw new Error(`${name} is in vendorConfig but not in devDependencies`);
}

const versions = Object.fromEntries(
  packages.map(([name]) => [
    name,
    JSON.parse(readFileSync(inPackage(name, "package.json"), "utf8")).version,
  ]),
);
console.log("Copying vendor files...\n", versions, "\n");

if (existsSync(destRoot)) {
  rmSync(destRoot, { recursive: true, force: true });
  console.log(`Cleaned ${rel(destRoot)}\n`);
}

let count = 0;
for (const [name, pcfg] of packages) {
  console.log(`--- ${name} ---`);
  for (const file of pcfg.files) {
    const src = locate(name, file.src);
    const dst = resolve(destRoot, pcfg.dest, file.out ?? basename(file.src));
    const mode = file.mode ?? modeOf(src);
    const copy = MODES[mode];
    if (!copy) throw new Error(`${name}: unknown mode "${mode}"`);

    mkdirSync(dirname(dst), { recursive: true });
    console.log(`  ✓ ${rel(dst)} (${await copy(src, dst)})`);
    count++;
  }
  console.log();
}

console.log(`Done — ${count} entries from ${packages.length} packages.`);

// The client version, written where the server can read it back.
//
// package.json does not travel: the wheel carries src/osmapp and nothing above
// it, and the runtime image is built from that wheel with no Node left in it.
// This file does travel — it sits among the assets whose version it names, and
// internal/version.py falls back to it once package.json is out of reach. It is
// written from here because this is the step that produces those assets, so the
// number cannot end up describing a tree it was not built from.
const versionFile = resolve(root, "src/osmapp/static/version.json");
mkdirSync(dirname(versionFile), { recursive: true });
writeFileSync(
  versionFile,
  JSON.stringify({ version: pkg.version }, null, 2) + "\n",
  "utf8",
);
console.log(`Wrote ${rel(versionFile)} — client version ${pkg.version}.`);

const TEMPLATES = resolve(root, "src/osmapp/templates");
const referenced = new Map();

for (const file of readdirSync(TEMPLATES)) {
  const text = readFileSync(resolve(TEMPLATES, file), "utf8");
  for (const [path] of text.matchAll(/vendor\/[A-Za-z0-9@._/-]+/g)) {
    referenced.set(path.replace(/^vendor\//, "").replace(/\/$/, ""), file);
  }
}

const missing = [...referenced].filter(
  ([path]) => !existsSync(resolve(destRoot, path)),
);

if (missing.length) {
  const lines = missing.map(([path, file]) => `  ${path}  (${file})`);
  throw new Error(
    `the templates reference ${missing.length} vendored path(s) that were ` +
      `not produced:\n${lines.join("\n")}\n` +
      `Either vendorConfig's "out" is wrong or the template needs updating.`,
  );
}

console.log(`Checked ${referenced.size} vendored paths named in templates.`);
