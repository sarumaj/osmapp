// scripts/copy-vendor.js
import { mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { minify } from "terser";
import CleanCSS from "clean-css";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const nm = (pkg) => resolve(root, "node_modules", pkg);
const dest = (...parts) => resolve(root, "src", "osmapp", "static", "vendor", ...parts);

function ver(pkg) {
  return JSON.parse(readFileSync(resolve(nm(pkg), "package.json"), "utf8")).version;
}

// --- helpers ---
function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`  ✓ ${dst.replace(root + "/", "")} (dir)`);
}

async function copyMinJS(src, dst) {
  ensureDir(dst);
  const code = readFileSync(src, "utf8");
  const result = await minify(code, { sourceMap: false });
  writeFileSync(dst, result.code, "utf8");
  const ratio = ((1 - result.code.length / code.length) * 100).toFixed(1);
  console.log(`  ✓ ${dst.replace(root + "/", "")} (minified JS -${ratio}%)`);
}

function copyMinCSS(src, dst) {
  ensureDir(dst);
  const code = readFileSync(src, "utf8");
  const result = new CleanCSS({ level: 2 }).minify(code);
  if (result.errors.length) throw new Error(`CleanCSS errors: ${result.errors}`);
  writeFileSync(dst, result.styles, "utf8");
  const ratio = ((1 - result.styles.length / code.length) * 100).toFixed(1);
  console.log(`  ✓ ${dst.replace(root + "/", "")} (minified CSS -${ratio}%)`);
}

function copyRaw(src, dst) {
  ensureDir(dst);
  cpSync(src, dst);
  console.log(`  ✓ ${dst.replace(root + "/", "")} (raw)`);
}

// --- main ---
const versions = {
  leaflet: ver("leaflet"),
  geocoder: ver("leaflet-control-geocoder"),
  editable: ver("leaflet-editable"),
  pathDrag: ver("leaflet-path-drag"),
  turf: ver("@turf/turf"),
  fa: ver("@fortawesome/fontawesome-free"),
};

console.log("Copying vendor files...\n", versions, "\n");

// --- unpkg.com/leaflet ---
const leafletDest = dest("unpkg.com", `leaflet@${versions.leaflet}`, "dist");
await copyMinJS(nm("leaflet/dist/leaflet-src.js"), resolve(leafletDest, "leaflet.js"));
await copyMinCSS(nm("leaflet/dist/leaflet.css"), resolve(leafletDest, "leaflet.css"));
copyDir(nm("leaflet/dist/images"), resolve(leafletDest, "images"));

// --- cdn.jsdelivr.net/npm/leaflet-control-geocoder ---
const geocoderDest = dest(
  "cdn.jsdelivr.net", "npm", `leaflet-control-geocoder@${versions.geocoder}`, "dist"
);
await copyMinJS(nm("leaflet-control-geocoder/dist/Control.Geocoder.js"), resolve(geocoderDest, "Control.Geocoder.min.js"));
await copyMinCSS(nm("leaflet-control-geocoder/dist/Control.Geocoder.css"), resolve(geocoderDest, "Control.Geocoder.css"));
// source map kept as-is (it references the original, not needed at runtime)
copyRaw(nm("leaflet-control-geocoder/dist/Control.Geocoder.js.map"), resolve(geocoderDest, "Control.Geocoder.js.map"));

// --- cdn.jsdelivr.net/npm/leaflet-editable ---
const editableDest = dest(
  "cdn.jsdelivr.net", "npm", `leaflet-editable@${versions.editable}`, "src"
);
await copyMinJS(nm("leaflet-editable/src/Leaflet.Editable.js"), resolve(editableDest, "Leaflet.Editable.min.js"));

// --- cdn.jsdelivr.net/npm/leaflet-path-drag ---
const pathDragDest = dest(
  "cdn.jsdelivr.net", "npm", `leaflet-path-drag@${versions.pathDrag}`, "dist"
);
await copyMinJS(nm("leaflet-path-drag/dist/index.js"), resolve(pathDragDest, "index.js"));

// --- cdn.jsdelivr.net/npm/turf ---
const turfDest = dest("cdn.jsdelivr.net", "npm", "turf", `turf@${versions.turf}`);
// @turf/turf already ships turf.min.js — use it directly, no re-minification needed
copyRaw(nm("@turf/turf/turf.min.js"), resolve(turfDest, "turf.min.js"));

// --- cdnjs.cloudflare.com / font-awesome ---
const faDest = dest("cdnjs.cloudflare.com", "ajax", "libs", `font-awesome@${versions.fa}`);
await copyMinCSS(nm("@fortawesome/fontawesome-free/css/all.css"), resolve(faDest, "css", "all.min.css"));
copyRaw(nm("@fortawesome/fontawesome-free/webfonts/fa-brands-400.woff2"), resolve(faDest, "webfonts", "fa-brands-400.woff2"));
copyRaw(nm("@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2"), resolve(faDest, "webfonts", "fa-solid-900.woff2"));

console.log("\nDone.");
