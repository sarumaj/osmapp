// scripts/copy-vendor.js
//
// Copies build artifacts from node_modules into src/.../vendor, mirroring the
// CDN URL layout the app loads them from at runtime. The list of packages,
// files, and copy modes is driven entirely by the "vendorConfig" section of
// package.json, so adding a new vendored dependency only needs an entry there
// — no changes to this script.
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  cpSync, rmSync, readdirSync,
} from "fs";
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

function subVersion(seg, version) {
  return seg.replaceAll("{version}", version);
}

// --- resolve versions ---
const versions = {};
for (const [name, pcfg] of Object.entries(packages)) {
  versions[name] = ver(pcfg.version);
}
console.log("Copying vendor files...\n", versions, "\n");

// --- clean: remove old version directories before copying ---
console.log("Cleaning previous vendor output...\n");

for (const [name, pcfg] of Object.entries(packages)) {
  const version = versions[name];
  const destSegments = pcfg.dest.map((s) => subVersion(s, version));

  const versionSegIndex = pcfg.dest.findIndex((s) => s.includes("{version}"));
  if (versionSegIndex === -1) continue;

  const currentVersionDir = resolve(destRoot, ...destSegments.slice(0, versionSegIndex + 1));
  const parentDir = dirname(currentVersionDir);
  const currentBasename = destSegments[versionSegIndex];

  if (!existsSync(parentDir)) continue;

  const pkgPrefix = currentBasename.includes("@")
    ? currentBasename.slice(0, currentBasename.lastIndexOf("@"))
    : currentBasename;

  for (const entry of readdirSync(parentDir)) {
    if (entry === currentBasename) continue;
    if (entry.startsWith(pkgPrefix + "@") || entry === pkgPrefix) {
      const fullPath = resolve(parentDir, entry);
      rmSync(fullPath, { recursive: true, force: true });
      console.log(`  ✗ removed ${rel(fullPath)}`);
    }
  }
}
console.log();

// --- copy ---
for (const [name, pcfg] of Object.entries(packages)) {
  console.log(`\n--- ${name} ---`);
  const version = versions[name];
  const destDir = resolve(destRoot, ...pcfg.dest.map((s) => subVersion(s, version)));

  for (const file of pcfg.files) {
    const src = pick(name, file.src);
    const dst = resolve(destDir, file.out);
    switch (file.mode) {
      case "minjs":  await copyMinJS(src, dst);  break;
      case "mincss": copyMinCSS(src, dst);       break;
      case "raw":    copyRaw(src, dst);          break;
      case "dir":    copyDir(src, dst);          break;
      default:       throw new Error(`${name}: unknown mode "${file.mode}"`);
    }
  }
}

console.log("\nDone.");
