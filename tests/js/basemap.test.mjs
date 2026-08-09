/**
 * The rule this module exists to hold: a territory card is composed from
 * OpenStreetMap tiles and nothing else, whatever is on screen.
 *
 * It fails quietly in the worst possible place. Nothing about a satellite
 * basemap looks wrong while you are looking at it, and a card composed from
 * one is a card with no street names on it — discovered after fifty of them
 * have been printed and handed out. So PRINT_TILE_URL is asserted directly,
 * and the selection is asserted never to reach it.
 *
 * The exclusivity of the switch is worth pinning too: two basemaps added at
 * once is not a visual glitch but a doubling of tile requests against a
 * provider whose terms the project depends on staying inside of.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const CONFIG = {
  base: {
    id: "osm",
    labelKey: "layers.map",
    url: "/tiles/{z}/{x}/{y}.png",
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  },
  aid: [
    {
      id: "imagery",
      labelKey: "layers.imagery",
      url: "/tiles/aid/imagery/{z}/{x}/{y}.png",
      maxNativeZoom: 19,
      attribution: "Esri",
    },
    {
      id: "terrain",
      labelKey: "layers.terrain",
      url: "/tiles/aid/terrain/{z}/{x}/{y}.png",
      maxNativeZoom: 17,
      attribution: "OpenTopoMap",
    },
  ],
};

/** Just enough Leaflet, DOM and storage for the module to run. */
function boot(overrides = {}) {
  const added = new Set();
  const classes = new Set();
  const stored = new Map(Object.entries(overrides.stored || {}));

  const map = {
    hasLayer: (layer) => added.has(layer),
    addLayer: (layer) => added.add(layer),
    removeLayer: (layer) => added.delete(layer),
    getContainer: () => ({
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
    }),
  };

  const window = {
    BASEMAPS: "basemaps" in overrides ? overrides.basemaps : CONFIG,
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, value),
    },
  };

  const L = { tileLayer: (url, options) => ({ url, options }) };

  const App = loadApp(["util.js", "basemap.js"], { window, L });
  App.basemap.init(map);
  return { basemap: App.basemap, added, classes, stored };
}

// ── the rule ─────────────────────────────────────────────────────────────────

test("the printable basemap is OSM and is not a function of the selection", () => {
  const { basemap } = boot();
  assert.equal(basemap.PRINT_TILE_URL, "/tiles/{z}/{x}/{y}.png");

  basemap.select("imagery");
  assert.equal(basemap.PRINT_TILE_URL, "/tiles/{z}/{x}/{y}.png");
  assert.equal(basemap.isAid(), true, "the aid layer really is selected");
});

test("no aid layer can be reached from the print route", () => {
  const { basemap } = boot();
  assert.ok(
    !basemap.PRINT_TILE_URL.includes("/aid/"),
    "the print URL must not be under the aid prefix",
  );
});

// ── selection ────────────────────────────────────────────────────────────────

test("exactly one basemap is on the map at a time", () => {
  const { basemap, added } = boot();
  assert.equal(added.size, 1);

  basemap.select("terrain");
  assert.equal(added.size, 1);
  assert.equal(added.has(basemap.layer("terrain")), true);
  assert.equal(added.has(basemap.layer("osm")), false);

  basemap.select("osm");
  assert.equal(added.size, 1);
  assert.equal(added.has(basemap.layer("osm")), true);
});

test("OSM is the default and is not an aid layer", () => {
  const { basemap } = boot();
  assert.equal(basemap.current(), "osm");
  assert.equal(basemap.isAid(), false);
});

test("an unknown remembered id falls back to OSM", () => {
  // A layer removed from the server config leaves a stale localStorage entry;
  // starting with no basemap at all would be a blank page.
  const { basemap, added } = boot({ stored: { "osmapp.basemap": "gone" } });
  assert.equal(basemap.current(), "osm");
  assert.equal(added.size, 1);
});

test("the choice is remembered", () => {
  const { basemap, stored } = boot();
  basemap.select("imagery");
  assert.equal(stored.get("osmapp.basemap"), "imagery");
});

test("a remembered aid layer comes back on the next visit", () => {
  const { basemap } = boot({ stored: { "osmapp.basemap": "terrain" } });
  assert.equal(basemap.current(), "terrain");
  assert.equal(basemap.isAid(), true);
});

// ── wiring the rest of the app depends on ────────────────────────────────────

test("entries are in switcher order, base first, and carry i18n keys", () => {
  const { basemap } = boot();
  assert.deepEqual(
    basemap.entries().map((e) => [e.id, e.labelKey, e.aid]),
    [
      ["osm", "layers.map", false],
      ["imagery", "layers.imagery", true],
      ["terrain", "layers.terrain", true],
    ],
  );
});

test("an aid layer keeps the map's zoom range and upscales past its own", () => {
  // Without maxNativeZoom a 17-level terrain layer goes blank at z18 rather
  // than going soft, which reads as a broken app rather than a limit.
  const { basemap } = boot();
  const terrain = basemap.layer("terrain");
  assert.equal(terrain.options.maxZoom, 19);
  assert.equal(terrain.options.maxNativeZoom, 17);
  assert.equal(terrain.options.className, "basemap-aid");
});

test("listeners hear a change but not start-up", () => {
  const { basemap } = boot();
  const seen = [];
  basemap.onChange((id) => seen.push(id));

  basemap.select("imagery");
  basemap.select("imagery"); // no change, no notification
  basemap.select("osm");
  assert.deepEqual(seen, ["imagery", "osm"]);
});

test("the app still starts when the server sends no aid layers", () => {
  // Every aid URL blanked in the config is a supported deployment.
  const { basemap, added } = boot({ basemaps: { base: CONFIG.base, aid: [] } });
  assert.equal(added.size, 1);
  assert.deepEqual(
    basemap.entries().map((e) => e.id),
    ["osm"],
  );
  assert.equal(basemap.isAid(), false);
});
