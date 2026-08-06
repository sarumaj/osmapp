/**
 * harness.js — load the pure browser modules into a Node VM.
 *
 * geometry.js and spatial.js touch neither the DOM nor Leaflet, so they run
 * unmodified given a `window` and Turf. Turf is already vendored under
 * static/cdn, which is why these tests need no npm install and no build step.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STATIC = path.join(__dirname, "..", "src", "osmapp", "static");
const TURF = "vendor/cdn.jsdelivr.net/npm/turf/turf@6.5.0/turf.min.js";

/**
 * @param {string[]} modules paths under static/, e.g. ["js/geometry.js"]
 * @returns {object} the VM context, carrying `App` and `turf`
 */
function load(modules) {
  // Deliberately NOT seeding host built-ins here. Passing the host Array,
  // Object or Math into the context puts two realms in play, and Turf's jsts
  // buffer implementation does `instanceof` checks that then fail — which
  // shows up as turf.buffer throwing on every input. Let the VM build its own.
  const ctx = vm.createContext({ console, setTimeout, clearTimeout });
  vm.runInContext("var window = globalThis;", ctx);

  for (const file of [TURF, ...modules]) {
    const source = fs.readFileSync(path.join(STATIC, file), "utf8");
    vm.runInContext(source, ctx, { filename: file });
  }
  return ctx;
}

/** Square polygon of roughly `metres` a side, centred on [lng, lat]. */
function square(lng, lat, metres) {
  const dLat = metres / 111320;
  const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180));
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng - dLng / 2, lat - dLat / 2],
          [lng + dLng / 2, lat - dLat / 2],
          [lng + dLng / 2, lat + dLat / 2],
          [lng - dLng / 2, lat + dLat / 2],
          [lng - dLng / 2, lat - dLat / 2],
        ],
      ],
    },
  };
}

/** Axis-aligned rectangle from corner coordinates. */
function rect(west, south, east, north, properties) {
  return {
    type: "Feature",
    properties: properties || {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

module.exports = { load, square, rect };
