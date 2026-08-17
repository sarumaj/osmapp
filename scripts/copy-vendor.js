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
//   • The key is the package name, and the version comes from the package's
//     own package.json. Nothing about a version is written down twice.
//   • "dest" is a path under destRoot, matching the CDN URL.
//   • "src" is a path inside the package, or a list of candidates tried in
//     order — pdf-lib and pdfjs-dist have both moved their build outputs
//     between majors, and a list survives that without a code change.
//   • "out" defaults to the file name of "src", which is what most entries
//     want. Give it only to rename, or to place the file in a subdirectory.
//   • "mode" is inferred and rarely written: a directory is copied whole, an
//     already-minified source is copied verbatim, and any other .js/.mjs/.css
//     is minified on the way through. Set it explicitly to override.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
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

function pick(name, candidates) {
  for (const candidate of candidates) {
    const path = inPackage(name, candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `${name}: none of [${candidates.join(", ")}] exist — the package layout ` +
      `changed, so the vendorConfig in package.json and the <script> paths ` +
      `in index.html both need updating`,
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
    const candidates = Array.isArray(file.src) ? file.src : [file.src];
    const src = pick(name, candidates);
    const dst = resolve(destRoot, pcfg.dest, file.out ?? basename(candidates[0]));
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
