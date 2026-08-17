// scripts/copy-vendor.js
//
// Copies build artifacts from node_modules into src/.../vendor, mirroring the
// CDN URL layout the app loads them from at runtime. The list of packages,
// files, and copy modes is driven entirely by the "vendorConfig" section of
// package.json, so adding a new vendored dependency only needs an entry there
// — no changes to this script.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { minify } from "terser";
import CleanCSS from "clean-css";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const nm = (pkg) => resolve(root, "node_modules", pkg);

// --- load config from package.json ---
const pkgJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cfg = pkgJson.vendorConfig;
if (!cfg) throw new Error("package.json is missing a \"vendorConfig\" section");
const destRoot = resolve(root, cfg.destRoot);
const packages = cfg.packages;

// --- helpers ---
function ver(pkg) {
  return JSON.parse(readFileSync(resolve(nm(pkg), "package.json"), "utf8")).version;
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function rel(p) {
  return p.replace(root + "/", "");
}

/** First candidate that exists, else throw naming all candidates. */
function pick(pkg, candidates) {
  for (const candidate of candidates) {
    const path = nm(`${pkg}/${candidate}`);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `${pkg}: none of [${candidates.join(", ")}] exist — the package layout ` +
    `changed, so the vendorConfig in package.json and the <script> paths in ` +
    `index.html both need updating`,
  );
}

async function copyMinJS(src, dst) {
  ensureDir(dst);
  const code = readFileSync(src, "utf8");
  const result = await minify(code, { sourceMap: false });
  writeFileSync(dst, result.code, "utf8");
  const ratio = ((1 - result.code.length / code.length) * 100).toFixed(1);
  console.log(`  ✓ ${rel(dst)} (minified JS -${ratio}%)`);
}

function copyMinCSS(src, dst) {
  ensureDir(dst);
  const code = readFileSync(src, "utf8");
  const result = new CleanCSS({ level: 2 }).minify(code);
  if (result.errors.length) throw new Error(`CleanCSS errors: ${result.errors}`);
  writeFileSync(dst, result.styles, "utf8");
  const ratio = ((1 - result.styles.length / code.length) * 100).toFixed(1);
  console.log(`  ✓ ${rel(dst)} (minified CSS -${ratio}%)`);
}

function copyRaw(src, dst) {
  ensureDir(dst);
  cpSync(src, dst);
  console.log(`  ✓ ${rel(dst)} (raw)`);
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`  ✓ ${rel(dst)} (dir)`);
}

/** Substitute {version} inside a path segment with the installed version. */
function subVersion(seg, version) {
  return seg.replaceAll("{version}", version);
}

// --- main ---
const versions = {};
for (const [name, pcfg] of Object.entries(packages)) {
  versions[name] = ver(pcfg.version);
}
console.log("Copying vendor files...\n", versions, "\n");

for (const [name, pcfg] of Object.entries(packages)) {
  console.log(`\n--- ${name} ---`);
  const version = versions[name];
  const destDir = resolve(destRoot, ...pcfg.dest.map((s) => subVersion(s, version)));

  for (const file of pcfg.files) {
    const src = pick(name, file.src);
    const dst = resolve(destDir, file.out);
    switch (file.mode) {
      case "minjs": await copyMinJS(src, dst); break;
      case "mincss": copyMinCSS(src, dst); break;
      case "raw": copyRaw(src, dst); break;
      case "dir": copyDir(src, dst); break;
      default: throw new Error(`${name}: unknown mode "${file.mode}"`);
    }
  }
}

console.log("\nDone.");
