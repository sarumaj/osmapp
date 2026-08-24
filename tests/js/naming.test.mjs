/**
 * The locality suggestion.
 *
 * The number on a card was always recoverable — it is on the shape. The
 * locality was not: it sits in the addr:* tags of the buildings the app has
 * already downloaded, and until this module existed it was retyped by hand
 * once per card for a whole round. So what is worth pinning here is the
 * judgement, not the plumbing.
 *
 * Three decisions carry the feature and each fails silently if it drifts:
 *
 *   - Agreement, not first-match. A territory that straddles a boundary really
 *     does contain two locality names, and the one most of its addresses use
 *     is the honest pick. A rule that took the first tagged building would
 *     depend on Overpass ordering, which nobody controls.
 *   - addr:place weighs the same as addr:city. Rural Poland numbers houses
 *     against the settlement rather than a street, so the village name is only
 *     ever in addr:place — and a key-priority rule would let one stray
 *     addr:city outvote two hundred buildings agreeing on the village.
 *   - Only buildings *inside* the shape vote, by centroid, matching the
 *     per-territory building count in polygons.js. Two rules for "in this
 *     territory" would eventually disagree in front of a user.
 *
 * Everything runs against stubs. All the geometry here is axis-aligned
 * rectangles, which is enough for every question the module asks of turf.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

// ── Stubs ────────────────────────────────────────────────────────────────────

function ring(x, y, size = 10) {
  return [
    [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ],
  ];
}

function polygon(x, y, size = 10) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: ring(x, y, size) },
  };
}

/** A building is a tiny square at (x, y) carrying whatever tags are given. */
function building(x, y, properties) {
  return {
    type: "Feature",
    properties: properties || {},
    geometry: { type: "Polygon", coordinates: ring(x, y, 0.2) },
  };
}

function coordsOf(feature) {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number") return void out.push(node);
    node.forEach(walk);
  };
  walk(feature.geometry.coordinates);
  return out;
}

const turf = {
  bbox(feature) {
    const points = coordsOf(feature);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  },
  centroid(feature) {
    // A ring repeats its first coordinate as its last. Real turf.centroid
    // averages it twice; skipping it here only makes the expected values in
    // this file the obvious ones.
    const points = coordsOf(feature).slice(0, -1);
    const sum = points.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Point",
        coordinates: [sum[0] / points.length, sum[1] / points.length],
      },
    };
  },
  // Every polygon in this file is an axis-aligned rectangle, so its envelope
  // is the polygon.
  booleanPointInPolygon(point, feature) {
    const [x, y] = point.geometry.coordinates;
    const [west, south, east, north] = turf.bbox(feature);
    return x >= west && x <= east && y >= south && y <= north;
  },
  pointOnFeature(feature) {
    return turf.centroid(feature);
  },
};

/**
 * Load naming.js against a stub state object holding `buildings`.
 *
 * App.labels and App.i18n are read at call time rather than at init, so a test
 * may attach them afterwards — or leave them off entirely, which is how the
 * module's tolerance of their absence is checked.
 */
function setup(buildings) {
  const App = loadApp(["util.js", "state.js", "geometry.js", "naming.js"], { window: {}, turf });
  App.state.cachedBuildings = {
    type: "FeatureCollection",
    features: buildings || [],
  };
  App.naming.init();
  return App;
}

/** The stub half of labels.js: numbering by position, exactly as numberOf does. */
function withLabels(App, clusters) {
  App.state.clusters = clusters.map((feature) => ({ feature, layer: {} }));
  App.labels = {
    numberOf(feature) {
      const at = App.state.clusters.findIndex((c) => c.feature === feature);
      return at < 0 ? null : at + 1;
    },
  };
  App.i18n = { n: (value) => String(value), current: () => "de" };
  return App;
}

const values = (candidates) => candidates.map((c) => c.value);

// ── Whose addresses count ────────────────────────────────────────────────────

test("only buildings inside the territory are read", () => {
  const App = setup([
    building(2, 2, { "addr:city": "Mainz" }),
    building(4, 4, { "addr:city": "Mainz" }),
    building(40, 40, { "addr:city": "Wiesbaden" }),
  ]);

  const inside = App.naming.buildingsIn(polygon(0, 0));
  assert.equal(inside.length, 2);
});

test("a building on the far side of the bounding box still has to be inside it", () => {
  // The bbox pre-filter is an optimization, not the test. A building that
  // passes it and fails the polygon must not vote, or every L-shaped territory
  // would inherit its neighbor's name.
  const App = setup([building(2, 2, { "addr:city": "Mainz" })]);
  assert.equal(App.naming.buildingsIn(polygon(20, 20)).length, 0);
});

test("the name most of the addresses agree on comes first", () => {
  const App = setup([
    building(1, 1, { "addr:city": "Mainz" }),
    building(2, 2, { "addr:city": "Mainz" }),
    building(3, 3, { "addr:city": "Mainz" }),
    building(4, 4, { "addr:city": "Budenheim" }),
  ]);

  const candidates = App.naming.localityCandidates(polygon(0, 0));
  assert.equal(candidates[0].value, "Mainz");
  assert.equal(candidates[0].count, 3);
  assert.equal(App.naming.localityFor(polygon(0, 0)), "Mainz");
});

test("a village tagged only in addr:place is not outvoted by one stray addr:city", () => {
  // The rural-Poland case, and the reason weight multiplies the count instead
  // of ordering the keys: houses are numbered against the settlement, so
  // addr:place is the only tag that carries the village name.
  const App = setup([
    ...Array.from({ length: 20 }, (_, i) =>
      building(1 + i * 0.3, 1, { "addr:place": "Wólka" }),
    ),
    building(9, 9, { "addr:city": "Warszawa" }),
  ]);

  assert.equal(App.naming.localityFor(polygon(0, 0)), "Wólka");
});

test("a suburb ranks below the city it is in", () => {
  const App = setup([
    building(1, 1, { "addr:city": "Mainz", "addr:suburb": "Gonsenheim" }),
    building(2, 2, { "addr:city": "Mainz", "addr:suburb": "Gonsenheim" }),
  ]);

  assert.deepEqual(values(App.naming.localityCandidates(polygon(0, 0))), [
    "Mainz",
    "Gonsenheim",
  ]);
});

// ── Reading osmnx's output ───────────────────────────────────────────────────

test("osmnx's placeholders do not become locality names", () => {
  // A missing tag arrives from geopandas as the string "nan" often enough to
  // be worth naming; without this guard it would be the suggestion.
  const App = setup([
    building(1, 1, { "addr:city": "nan" }),
    building(2, 2, { "addr:city": "  " }),
    building(3, 3, { "addr:city": "Mainz" }),
  ]);

  assert.deepEqual(values(App.naming.localityCandidates(polygon(0, 0))), [
    "Mainz",
  ]);
});

test("a merged way's list of names is joined rather than stringified", () => {
  const App = setup([building(1, 1, { "addr:city": ["Mainz", "Mainz"] })]);
  assert.equal(App.naming.localityFor(polygon(0, 0)), "Mainz; Mainz");
});

test("the same name written two ways is offered once", () => {
  const App = setup([
    building(1, 1, { "addr:city": "Mainz" }),
    building(2, 2, { "addr:place": "mainz" }),
  ]);

  assert.equal(App.naming.localityCandidates(polygon(0, 0)).length, 1);
});

// ── Falling back to the rest of the download ─────────────────────────────────

test("a territory with no addresses of its own is offered the ones next door", () => {
  const App = setup([building(40, 40, { "addr:city": "Wiesbaden" })]);

  const candidates = App.naming.localityCandidates(polygon(0, 0));
  assert.deepEqual(values(candidates), ["Wiesbaden"]);
  assert.equal(candidates[0].scope, "area");
});

test("the territory's own addresses stay ahead of the neighborhood's", () => {
  const App = setup([
    building(1, 1, { "addr:city": "Budenheim" }),
    ...Array.from({ length: 30 }, (_, i) =>
      building(40 + i * 0.3, 40, { "addr:city": "Mainz" }),
    ),
  ]);

  const candidates = App.naming.localityCandidates(polygon(0, 0));
  assert.equal(candidates[0].value, "Budenheim");
  assert.equal(candidates[0].scope, "territory");
  // …and the busier name is still offered, just second.
  assert.equal(candidates[1].value, "Mainz");
});

test("nothing at all is an empty list, not a throw", () => {
  const App = setup([]);
  assert.deepEqual(App.naming.localityCandidates(polygon(0, 0)), []);
  assert.equal(App.naming.localityFor(polygon(0, 0)), null);
  assert.deepEqual(App.naming.localityCandidates(null), []);
});

// ── The number field ─────────────────────────────────────────────────────────

test("the territory number is offered as written, padded and qualified", () => {
  const App = setup([]);
  const seven = polygon(0, 0);
  withLabels(App, [
    polygon(100, 100),
    polygon(101, 101),
    polygon(102, 102),
    polygon(103, 103),
    polygon(104, 104),
    polygon(105, 105),
    seven,
  ]);

  assert.deepEqual(values(App.naming.territoryCandidates(seven, "Mainz")), [
    "7",
    "07",
    "Mainz 7",
  ]);
});

test("a two-digit number is not offered padded", () => {
  const App = setup([]);
  const clusters = Array.from({ length: 12 }, (_, i) => polygon(i * 20, 0));
  withLabels(App, clusters);

  assert.deepEqual(values(App.naming.territoryCandidates(clusters[11])), ["12"]);
});

test("the name a card gave a territory is offered ahead of its number", () => {
  // The placeholder is the head of this list, so first is what decides
  // whether a congregation retypes its own numbering on every reprint.
  const App = setup([]);
  const named = polygon(0, 0);
  named.properties.label = "S-13";
  withLabels(App, [named, polygon(50, 50)]);
  App.polygons = { labelOf: (f) => (f.properties && f.properties.label) || "" };

  assert.deepEqual(values(App.naming.territoryCandidates(named, "Mainz")), [
    "S-13",
    "1",
    "01",
    "Mainz 1",
  ]);
});

test("a name that is already the number is not offered twice", () => {
  const App = setup([]);
  const named = polygon(0, 0);
  named.properties.label = "1";
  withLabels(App, [named]);
  App.polygons = { labelOf: (f) => (f.properties && f.properties.label) || "" };

  assert.deepEqual(values(App.naming.territoryCandidates(named)), ["1", "01"]);
});

test("a named shape that is no longer a territory still offers its name", () => {
  // Nothing else can supply it: the index is gone with the territory, and the
  // name is the one thing about it that was never derived from the index.
  const App = setup([]);
  const named = polygon(50, 50);
  named.properties.label = "S-13";
  withLabels(App, [polygon(0, 0)]);
  App.polygons = { labelOf: (f) => (f.properties && f.properties.label) || "" };

  assert.deepEqual(values(App.naming.territoryCandidates(named)), ["S-13"]);
});

test("a shape that is not one of the current territories has no number", () => {
  // After a cut the old feature is gone from s.clusters. Offering it the
  // number it used to have would be worse than offering nothing.
  const App = setup([]);
  withLabels(App, [polygon(0, 0)]);
  assert.deepEqual(App.naming.territoryCandidates(polygon(50, 50), "Mainz"), []);
});

// ── Reverse geocoding ────────────────────────────────────────────────────────

/**
 * Run `run` with `globalThis.fetch` replaced by `handler`, restoring it after.
 *
 * Restoration is in a `finally`, so a rejecting assertion inside `run` cannot
 * leave the stub installed for the tests that follow — which would look like a
 * failure in whichever one happened to run next.
 *
 * @returns {Promise<*>} whatever `run` resolves to
 */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
    });
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test("Nominatim's hierarchy becomes candidates", async () => {
  const App = setup([]);
  App.i18n = { n: String, current: () => "pl" };

  const calls = [];
  await withFetch(
    async (url) => {
      calls.push(url);
      return okResponse({
        name: "Wólka",
        candidates: [
          { value: "Wólka", kind: "village" },
          { value: "gmina Michałowice", kind: "municipality" },
        ],
      });
    },
    async () => {
      const extra = await App.naming.reverse(polygon(0, 0));
      assert.deepEqual(values(extra), ["Wólka", "gmina Michałowice"]);
      assert.equal(extra[0].scope, "nominatim");
      // The point asked about is inside the shape, and the interface language
      // goes with it so the answer comes back in it.
      assert.match(calls[0], /lat=5\.00000&lon=5\.00000/);
      assert.match(calls[0], /lang=pl/);
    },
  );
});

test("the same territory is only looked up once", async () => {
  const App = setup([]);
  App.i18n = { n: String, current: () => "de" };

  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return okResponse({ candidates: [{ value: "Mainz", kind: "city" }] });
    },
    async () => {
      await App.naming.reverse(polygon(0, 0));
      await App.naming.reverse(polygon(0, 0));
      assert.equal(calls, 1);
    },
  );
});

test("a failed lookup is an empty list and is not remembered", async () => {
  // This is an enrichment of a list that already works, so the caller has
  // nothing useful to do with an error — but the next card may be printed
  // after the network comes back, so the failure must not be cached.
  const App = setup([]);
  App.i18n = { n: String, current: () => "de" };

  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      throw new Error("offline");
    },
    async () => {
      assert.deepEqual(await App.naming.reverse(polygon(0, 0)), []);
      assert.deepEqual(await App.naming.reverse(polygon(0, 0)), []);
      assert.equal(calls, 2);
    },
  );
});

test("a point the server knows nothing about is an ordinary empty answer", async () => {
  const App = setup([]);
  App.i18n = { n: String, current: () => "de" };

  await withFetch(
    async () => okResponse({ name: null, display: null, candidates: [] }),
    async () => {
      assert.deepEqual(await App.naming.reverse(polygon(0, 0)), []);
    },
  );
});
