/**
 * Downloading an area larger than one Overpass request.
 *
 * The size limit used to end the conversation: a boundary over it was refused,
 * and the advice was to draw a smaller one. It is now the size of a request
 * rather than the size of a project - the server divides the boundary into
 * areas that fit, and this module fetches them one at a time and puts the
 * pieces back together.
 *
 * Three things have to hold for the assembled map to be the map, and each of
 * them fails quietly:
 *
 *   - **Every piece is fetched.** A plan of eight areas that produces seven
 *     downloads is a hole in the map, in the shape of a grid cell.
 *   - **The tiles are posted back as they arrived.** The flag on each one is
 *     what tells the server to keep the streets that cross the tile's edges;
 *     stripping it puts a gap at every seam instead.
 *   - **What arrives twice is kept once, and what only looks alike is kept.**
 *     The seams are deliberately fetched from both sides, and a street id
 *     legitimately arrives as several different segments.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

globalThis.alert = () => {};

function box(x, y, size) {
  return turf.polygon([
    [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ],
  ]);
}

/** A tile as /split_area hands it back: geometry plus the flag and the count. */
function tile(x, y, size, index, count) {
  return {
    type: "Feature",
    geometry: box(x, y, size).geometry,
    properties: { tiled: count > 1, index: index, count: count, areaKm2: 1 },
  };
}

function street(osmid, coordinates) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coordinates },
    properties: { osmid: osmid },
  };
}

function building(osmid, x) {
  return {
    type: "Feature",
    geometry: box(x, 0, 0.001).geometry,
    properties: { osmid: osmid },
  };
}

function collection(features) {
  return { type: "FeatureCollection", features: features };
}

/**
 * data.js with the network answered from a script.
 *
 * `plan` is what /split_area returns; `streets` and `buildings` are indexed by
 * the order the tiles are fetched in, so a test says what each tile returned
 * rather than which request number returned it.
 */
function setup({ plan, streets = [], buildings = [] }) {
  const noop = () => {};
  const posts = [];
  // Counted per route rather than off the post log: the two are the same until
  // a retry lands in the middle of the download, and a fixture that shifts by
  // one from then on is a test that fails for the wrong reason.
  let streetCalls = 0;
  let buildingCalls = 0;

  globalThis.fetch = (url, options) => {
    const body = JSON.parse(options.body);
    posts.push({ url: url, body: body });

    if (url === "/split_area") {
      return Promise.resolve(
        json({ tiles: collection(plan), count: plan.length }),
      );
    }
    if (url === "/fetch_streets") {
      return Promise.resolve(
        json({ streets: collection(streets[streetCalls++] || []) }),
      );
    }
    const index = buildingCalls++;
    return Promise.resolve(
      json({
        buildings: collection(buildings[index] || []),
        bounds: { west: index, south: 0, east: index + 1, north: 1 },
      }),
    );
  };

  const App = loadApp(["geometry.js", "data.js"], {
    turf,
    window: {},
    document: {},
    L: { featureGroup: () => ({ addTo: () => ({ clearLayers: noop }) }) },
  });

  // The stub spells the variables out, so a test can assert that what the
  // server said reached the person reading the alert.
  App.i18n = {
    t: (key, vars) => (vars ? key + " " + JSON.stringify(vars) : key),
    n: String,
  };
  App.ui = {
    showBusy: noop,
    setOverlayText: noop,
    setOverlayStatus: noop,
    hideOverlay: noop,
    setInfo: noop,
    setInfoLoaded: noop,
    confirm: () => Promise.resolve(true),
  };
  App.controls = { refresh: noop };
  App.session = { markDirty: noop };
  App.polygons = {
    setClusters: noop,
    renderStreets: noop,
    renderBuildings: noop,
  };
  App.state = {
    outerPolygonLayerGroup: { clearLayers: noop },
    innerPolygonsLayerGroup: { clearLayers: noop },
    cachedStreets: collection([]),
    cachedBuildings: collection([]),
    cachedBounds: null,
    leafletMap: { fitBounds: noop },
  };
  App.data.init();

  return { App, posts };
}

function json(payload) {
  return { ok: true, status: 200, json: () => Promise.resolve(payload) };
}

const PLAN_OF_TWO = [tile(0, 0, 0.01, 0, 2), tile(0.01, 0, 0.01, 1, 2)];

// ── Every piece is fetched ───────────────────────────────────────────────────

test("one request for the plan, then two per area", async () => {
  const { App, posts } = setup({ plan: PLAN_OF_TWO });

  await App.data.fetchData(box(0, 0, 0.02));

  assert.deepEqual(
    posts.map((post) => post.url),
    [
      "/split_area",
      "/fetch_streets",
      "/fetch_buildings",
      "/fetch_streets",
      "/fetch_buildings",
    ],
  );
});

test("an area that needs no dividing is still one area, fetched once", async () => {
  const { App, posts } = setup({ plan: [tile(0, 0, 0.01, 0, 1)] });

  await App.data.fetchData(box(0, 0, 0.01));

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/split_area", "/fetch_streets", "/fetch_buildings"],
  );
  // Not a tile of anything: its edges are the ones somebody drew, and the
  // server cuts the data at them exactly as it always did.
  assert.equal(posts[1].body.properties.tiled, false);
});

// ── The tiles are posted back as they arrived ────────────────────────────────

test("a tile is posted back with the flag the server put on it", async () => {
  const { App, posts } = setup({ plan: PLAN_OF_TWO });

  await App.data.fetchData(box(0, 0, 0.02));

  for (const post of posts.slice(1)) {
    assert.equal(post.body.properties.tiled, true);
    assert.deepEqual(post.body.geometry.type, "Polygon");
  }
});

// ── Assembly ─────────────────────────────────────────────────────────────────

test("a street returned by both tiles of the seam it lies on is kept once", async () => {
  const seam = street(7, [
    [0.0099, 0],
    [0.0101, 0],
  ]);
  const { App } = setup({
    plan: PLAN_OF_TWO,
    streets: [[seam], [seam]],
  });

  await App.data.fetchData(box(0, 0, 0.02));

  assert.equal(App.state.cachedStreets.features.length, 1);
});

test("two segments of one street id are both kept", async () => {
  // osmnx cuts a way into one edge per junction, so a single id arriving
  // several times is the normal case and not a duplicate. Keyed on the id
  // alone, this map loses every segment of every street but the first.
  const { App } = setup({
    plan: PLAN_OF_TWO,
    streets: [
      [
        street(7, [
          [0, 0],
          [0.005, 0],
        ]),
      ],
      [
        street(7, [
          [0.005, 0],
          [0.01, 0],
        ]),
      ],
    ],
  });

  await App.data.fetchData(box(0, 0, 0.02));

  assert.equal(App.state.cachedStreets.features.length, 2);
});

test("a building on the seam is kept once and the rest are kept", async () => {
  const shared = building(3, 0.01);
  const { App } = setup({
    plan: PLAN_OF_TWO,
    buildings: [
      [building(1, 0.001), shared],
      [shared, building(2, 0.015)],
    ],
  });

  await App.data.fetchData(box(0, 0, 0.02));

  assert.deepEqual(
    App.state.cachedBuildings.features.map((f) => f.properties.osmid),
    [1, 3, 2],
  );
});

test("the download box holds every area, not the last one", async () => {
  const { App } = setup({ plan: PLAN_OF_TWO });

  await App.data.fetchData(box(0, 0, 0.02));

  // The stub widens the box by one degree per area fetched.
  assert.deepEqual(App.state.cachedBounds, {
    west: 0,
    south: 0,
    east: 2,
    north: 1,
  });
});

// ── The question that comes first ────────────────────────────────────────────

test("confirming a download does not ask for the plan twice", async () => {
  const { App, posts } = setup({ plan: PLAN_OF_TWO });

  await App.data.confirmAndFetch(box(0, 0, 0.02));

  assert.deepEqual(
    posts.filter((post) => post.url === "/split_area").length,
    1,
    "the dialog needs the count, and the download needs the same areas",
  );
});

test("declining leaves the network alone after the plan", async () => {
  const { App, posts } = setup({ plan: PLAN_OF_TWO });
  App.ui.confirm = () => Promise.resolve(false);

  const result = await App.data.confirmAndFetch(box(0, 0, 0.02));

  assert.equal(result.cancelled, true);
  assert.deepEqual(
    posts.map((post) => post.url),
    ["/split_area"],
  );
});

test("a busy server does not hold the question back", async () => {
  // The plan behind the dialog is asked for once and not waited out: it only
  // decorates the question with a count, and the retry ladder behind a failed
  // request is up to a minute long. The download that follows does its own
  // asking, with the retries that are worth having.
  const { App, posts } = setup({ plan: PLAN_OF_TWO });
  const answered = globalThis.fetch;
  let first = true;
  globalThis.fetch = (url, options) => {
    if (url === "/split_area" && first) {
      first = false;
      posts.push({ url: url, body: null });
      return Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: "busy", retryable: true }),
      });
    }
    return answered(url, options);
  };

  await App.data.confirmAndFetch(box(0, 0, 0.02));

  assert.equal(
    posts.filter((post) => post.url === "/split_area").length,
    2,
    "one attempt for the dialog, one for the download that followed it",
  );
  assert.equal(posts.filter((post) => post.url === "/fetch_streets").length, 2);
});

test("a plan that cannot be had is reported once, by the download", async () => {
  const { App } = setup({ plan: PLAN_OF_TWO });
  const seen = [];
  globalThis.alert = (message) => seen.push(message);
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "That area is over the limit." }),
    });

  const result = await App.data.confirmAndFetch(box(0, 0, 0.02));
  globalThis.alert = () => {};

  assert.equal(result.failed, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /over the limit/);
});
