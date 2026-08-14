// scripts/copy-vendor.js
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "fs";
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

/**
 * First candidate that exists, or a failure that names all of them.
 *
 * pdf-lib and pdfjs-dist have both moved their build outputs between majors —
 * .js to .mjs, dist to build, a legacy tree appearing and disappearing. A
 * rename here should say which file it was looking for rather than throwing
 * ENOENT on whichever guess happened to be first.
 */
function pick(pkg, ...candidates) {
  for (const candidate of candidates) {
    const path = nm(`${pkg}/${candidate}`);
    if (existsSync(path)) return path;
  }
  throw new Error(
    `${pkg}: none of [${candidates.join(", ")}] exist — the package layout changed, ` +
      `so scripts/copy-vendor.js and the <script> paths in index.html both need updating`,
  );
}

// --- main ---
const versions = {
  leaflet: ver("leaflet"),
  geocoder: ver("leaflet-control-geocoder"),
  editable: ver("leaflet-editable"),
  turf: ver("@turf/turf"),
  fa: ver("@fortawesome/fontawesome-free"),
  pdfLib: ver("pdf-lib"),
  fontkit: ver("@pdf-lib/fontkit"),
  pdfjs: ver("pdfjs-dist"),
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

// --- cdn.jsdelivr.net/npm/turf ---
const turfDest = dest("cdn.jsdelivr.net", "npm", "turf", `turf@${versions.turf}`);
// @turf/turf already ships turf.min.js — use it directly, no re-minification needed
copyRaw(nm("@turf/turf/turf.min.js"), resolve(turfDest, "turf.min.js"));

// --- cdnjs.cloudflare.com / font-awesome ---
const faDest = dest("cdnjs.cloudflare.com", "ajax", "libs", `font-awesome@${versions.fa}`);
await copyMinCSS(nm("@fortawesome/fontawesome-free/css/all.css"), resolve(faDest, "css", "all.min.css"));
copyRaw(nm("@fortawesome/fontawesome-free/webfonts/fa-brands-400.woff2"), resolve(faDest, "webfonts", "fa-brands-400.woff2"));
copyRaw(nm("@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff2"), resolve(faDest, "webfonts", "fa-solid-900.woff2"));

// --- unpkg.com/pdf-lib + @pdf-lib/fontkit ---
//
// Both already ship minified UMD builds, and re-minifying pdf-lib through
// terser here would cost a minute for nothing. Loaded lazily by pdfdoc.js, so
// their size is paid by whoever prints a card rather than by every page load.
copyRaw(
  pick("pdf-lib", "dist/pdf-lib.min.js"),
  dest("unpkg.com", `pdf-lib@${versions.pdfLib}`, "dist", "pdf-lib.min.js"),
);
copyRaw(
  pick("@pdf-lib/fontkit", "dist/fontkit.umd.min.js", "dist/fontkit.umd.js"),
  dest("unpkg.com", `@pdf-lib`, `fontkit@${versions.fontkit}`, "dist", "fontkit.umd.min.js"),
);

// --- cdn.jsdelivr.net/npm/pdfjs-dist ---
//
// An ES module since v4, which is why pdfdoc.js reaches it through import()
// rather than a <script> tag. The worker has to be a separate same-origin file
// or pdf.js parses on the main thread; standard_fonts is what lets
// getTextContent recover characters from a template that references the
// standard 14 instead of embedding them.
const pdfjsDest = dest("cdn.jsdelivr.net", "npm", `pdfjs-dist@${versions.pdfjs}`);
copyRaw(
  pick("pdfjs-dist", "build/pdf.min.mjs", "build/pdf.min.js", "legacy/build/pdf.min.mjs"),
  resolve(pdfjsDest, "build", "pdf.min.mjs"),
);
copyRaw(
  pick("pdfjs-dist", "build/pdf.worker.min.mjs", "build/pdf.worker.min.js", "legacy/build/pdf.worker.min.mjs"),
  resolve(pdfjsDest, "build", "pdf.worker.min.mjs"),
);
copyDir(pick("pdfjs-dist", "standard_fonts"), resolve(pdfjsDest, "standard_fonts"));

console.log("\nDone.");
