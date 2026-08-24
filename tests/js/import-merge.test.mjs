/**
 * Importing a project on top of the one already open.
 *
 * Import used to mean "replace", and for a project drawn in one sitting that
 * is still what it means. A wall map of a circuit is the case it does not
 * cover: the villages were surveyed on different evenings and saved as
 * different files, and there has to be a way to put them on one sheet without
 * redrawing any of them.
 *
 * What a merge has to get right is the arithmetic of two projects, and each
 * part of it fails differently:
 *
 *   - The **boundary** gains areas. Losing one is the failure this whole
 *     feature exists to avoid, and it is silent - a village simply is not
 *     there.
 *   - **Territories** are appended, minus ground the project already covers.
 *     Overlapping territories are not a drawing glitch: every building inside
 *     the overlap is counted twice and belongs to two cards.
 *   - **Streets and buildings** are appended without duplicates, because two
 *     downloads over neighboring areas both return the road along the join.
 *   - **Notes** are appended, and the ones already on screen have to survive:
 *     applyPayload clears them on a replace, which is right there and would be
 *     data loss here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

/**
 * The one browser API on the import path that Node has no version of.
 *
 * Set on the global rather than passed through loadApp's stubs, because that
 * is where data.js looks for it: `new FileReader()` is a free identifier, and
 * a module compiled with vm.compileFunction resolves those against this
 * realm's global object. readAsText over a File is all the import path uses.
 */
/**
 * The other browser global on this path, and the reason a failing import is
 * testable at all: every failure here is reported with alert() and then
 * swallowed, so without one the test sees a ReferenceError instead of the
 * recovery it is asking about.
 */
globalThis.alert = () => {};

globalThis.FileReader = class {
  readAsText(blob) {
    blob.text().then(
      (text) => this.onload && this.onload({ target: { result: text } }),
      () => this.onerror && this.onerror(),
    );
  }
};

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

function feature(geometry, properties) {
  return { type: "Feature", geometry: geometry.geometry, properties: properties || {} };
}

function street(osmid, x) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [[x, 0], [x + 1, 0]] },
    properties: { osmid: osmid },
  };
}

/**
 * data.js over stubs for everything it draws with.
 *
 * geometry.js and turf are real - the merge is geometry, and a stub would be
 * asserting that the stub was called. Everything downstream of the merge is
 * recorded rather than performed, so a test can read what the merge decided
 * instead of what Leaflet did with it.
 */
function setup({ boundary, clusters = [], streets = [], buildings = [], notes = [] }) {
  const noop = () => {};
  const seen = {
    clusters: null,
    outer: null,
    notes: null,
    pushed: false,
    cleared: false,
    undone: false,
  };

  const App = loadApp(["geometry.js", "data.js"], {
    turf,
    window: {},
    document: {},
    L: {
      geoJSON: (f) => ({ getLayers: () => [{ toGeoJSON: () => f }] }),
      featureGroup: () => ({ addTo: () => ({ clearLayers: noop }) }),
    },
  });

  App.i18n = { t: (k) => k, n: String };
  App.ui = { setInfoLoaded: noop, busy: (key, work) => Promise.resolve(work()) };
  App.controls = { refresh: noop };
  App.session = { markDirty: noop };
  App.history = {
    clear: () => (seen.cleared = true),
    push: () => (seen.pushed = true),
    undo: () => (seen.undone = true),
  };
  // The notes and the territories as the map holds them, so a second import
  // merges against what the first one left rather than against the fixture.
  let held = notes.slice();
  let current = clusters.slice();

  App.notes = {
    all: () => held.slice(),
    count: () => held.length,
    restore: (list) => {
      seen.notes = held = list || [];
    },
  };

  App.polygons = {
    OUTER_STYLE: {},
    clusterFeatures: () => current.slice(),
    setOuterLayer: (layer) => {
      seen.outer = layer.toGeoJSON();
      App.state.outerPolygonLayer = layer;
      return layer;
    },
    setClusters: (next, opts) => {
      // The silent call inside displayResults clears the map before the real
      // one lands; taking it would report an empty merge.
      if (!opts || !opts.silent) current = seen.clusters = next || [];
      return (next || []).length;
    },
    ensureDefaultCluster: noop,
    renderStreets: noop,
    renderBuildings: noop,
  };
  App.state = {
    outerPolygonLayer: { toGeoJSON: () => boundary },
    outerPolygonLayerGroup: { clearLayers: noop },
    innerPolygonsLayerGroup: { clearLayers: noop },
    streetsLayerGroup: {},
    buildingsLayerGroup: {},
    clusters: [],
    selectedClusters: [],
    cachedStreets: { type: "FeatureCollection", features: streets },
    cachedBuildings: { type: "FeatureCollection", features: buildings },
    cachedBounds: { west: 0, south: 0, east: 1, north: 1 },
    leafletMap: { fitBounds: noop },
    MIN_REMAINDER_M2: 50,
  };
  App.data.init();

  return { App, seen };
}

/** What a second project arriving looks like, at the version in force. */
function payload(overrides) {
  return Object.assign(
    {
      version: 3,
      outerPolygon: box(10, 10, 1),
      clusters: [feature(box(10, 10, 1))],
      streets: { type: "FeatureCollection", features: [] },
      buildings: { type: "FeatureCollection", features: [] },
      notes: [],
    },
    overrides,
  );
}

// ── The boundary ─────────────────────────────────────────────────────────────

test("a merged project keeps both areas", () => {
  const { App, seen } = setup({ boundary: box(0, 0, 1) });
  App.data.applyPayload(payload(), { merge: true });
  assert.equal(App.geometry.polygonParts(seen.outer).length, 2);
});

test("without merge the arriving project replaces the one on screen", () => {
  const { App, seen } = setup({ boundary: box(0, 0, 1) });
  App.data.applyPayload(payload());
  const parts = App.geometry.polygonParts(seen.outer);
  assert.equal(parts.length, 1);
  assert.ok(turf.booleanPointInPolygon(turf.point([10.5, 10.5]), parts[0]));
});

test("areas that overlap are dissolved into one, not stacked", () => {
  const { App, seen } = setup({ boundary: box(0, 0, 2) });
  App.data.applyPayload(payload({ outerPolygon: box(1, 1, 2), clusters: [] }), {
    merge: true,
  });
  assert.equal(App.geometry.polygonParts(seen.outer).length, 1);
});

// ── The territories ──────────────────────────────────────────────────────────

test("territories from both projects end up on the map", () => {
  const { App, seen } = setup({
    boundary: box(0, 0, 1),
    clusters: [feature(box(0, 0, 1))],
  });
  App.data.applyPayload(payload(), { merge: true });
  assert.equal(seen.clusters.length, 2);
});

test("an arriving territory gives way to ground already covered", () => {
  // The same village exported twice, or a boundary redrawn one street wider.
  const { App, seen } = setup({
    boundary: box(0, 0, 2),
    clusters: [feature(box(0, 0, 2), { printed: 1 })],
  });
  App.data.applyPayload(
    payload({ outerPolygon: box(1, 0, 2), clusters: [feature(box(1, 0, 2))] }),
    { merge: true },
  );

  assert.equal(seen.clusters.length, 2);
  assert.equal(
    seen.clusters[0].properties.printed,
    1,
    "the territory already on screen was rewritten",
  );
  const overlap = App.geometry.sharedArea(seen.clusters[0], seen.clusters[1]);
  assert.ok(overlap < 1, `the two territories still share ${overlap} m2`);
});

test("a territory entirely inside one already there is dropped", () => {
  const { App, seen } = setup({
    boundary: box(0, 0, 2),
    clusters: [feature(box(0, 0, 2))],
  });
  App.data.applyPayload(
    payload({ outerPolygon: box(0, 0, 2), clusters: [feature(box(0.5, 0.5, 1))] }),
    { merge: true },
  );
  assert.equal(seen.clusters.length, 1);
});

// ── The cache and the notes ──────────────────────────────────────────────────

test("a street both downloads returned is drawn once", () => {
  const { App } = setup({ boundary: box(0, 0, 1), streets: [street(1, 0), street(2, 1)] });
  App.data.applyPayload(
    payload({
      streets: { type: "FeatureCollection", features: [street(2, 1), street(3, 2)] },
    }),
    { merge: true },
  );
  assert.deepEqual(
    App.state.cachedStreets.features.map((f) => f.properties.osmid),
    [1, 2, 3],
  );
});

test("a feature with no id is kept, since there is nothing to compare it on", () => {
  const bare = { type: "Feature", geometry: null, properties: {} };
  const { App } = setup({ boundary: box(0, 0, 1), buildings: [bare] });
  App.data.applyPayload(
    payload({ buildings: { type: "FeatureCollection", features: [bare] } }),
    { merge: true },
  );
  assert.equal(App.state.cachedBuildings.features.length, 2);
});

test("notes already on the map survive a merge", () => {
  const mine = { kind: "note", points: [[0, 0]], text: "gate is round the back" };
  const theirs = { kind: "note", points: [[10, 10]], text: "dogs" };
  const { App, seen } = setup({ boundary: box(0, 0, 1), notes: [mine] });
  App.data.applyPayload(payload({ notes: [theirs] }), { merge: true });
  assert.deepEqual(seen.notes, [mine, theirs]);
});

test("without merge they do not, which is what replacing a project means", () => {
  const mine = { kind: "note", points: [[0, 0]], text: "gate is round the back" };
  const { App, seen } = setup({ boundary: box(0, 0, 1), notes: [mine] });
  App.data.applyPayload(payload());
  assert.deepEqual(seen.notes, []);
});

test("the download box grows to hold both projects", () => {
  const { App } = setup({ boundary: box(0, 0, 1) });
  App.data.applyPayload(
    payload({ bounds: { west: 10, south: 10, east: 11, north: 11 } }),
    { merge: true },
  );
  assert.deepEqual(App.state.cachedBounds, {
    west: 0,
    south: 0,
    east: 11,
    north: 11,
  });
});

// ── Taking it back ───────────────────────────────────────────────────────────

/** A project as it arrives from a file picker. */
function file(body, name) {
  return new File([JSON.stringify(body)], name || "project.json", {
    type: "application/json",
  });
}

test("a merge goes on the undo stack, and a replace clears it", async () => {
  // Without an entry, Ctrl+Z lands on the state before the last *recorded*
  // action - which is also before the merge - and Ctrl+Y cannot get back to
  // it, so the added village is gone for good.
  const merged = setup({ boundary: box(0, 0, 1) });
  assert.equal(await merged.App.data.importData(file(payload()), { merge: true }), true);
  assert.equal(merged.seen.pushed, true, "the merge cannot be taken back");
  assert.equal(merged.seen.cleared, false);

  const replaced = setup({ boundary: box(0, 0, 1) });
  assert.equal(await replaced.App.data.importData(file(payload())), true);
  assert.equal(replaced.seen.pushed, false);
  assert.equal(
    replaced.seen.cleared,
    true,
    "steps taken in a project that is gone are not steps anybody can repeat",
  );
});

test("importing several files puts every one of them on the map", async () => {
  // The point of taking more than one file at a time: the villages of a
  // circuit, each saved on the evening it was surveyed.
  const { App, seen } = setup({ boundary: box(0, 0, 1) });
  for (const at of [10, 20]) {
    await App.data.importData(
      file(payload({ outerPolygon: box(at, at, 1), clusters: [feature(box(at, at, 1))] })),
      { merge: true },
    );
  }
  assert.equal(App.geometry.polygonParts(seen.outer).length, 3);
  assert.equal(seen.clusters.length, 2, "the arriving territories are not there");
});

// ── The version gate ─────────────────────────────────────────────────────────

test("a project from an incompatible version is refused, merge or not", () => {
  const { App } = setup({ boundary: box(0, 0, 1) });
  assert.throws(
    () => App.data.applyPayload(payload({ version: 99 }), { merge: true }),
    /unsupported export version/,
  );
});

test("a merge that fails leaves no step that undoes nothing", async () => {
  // The entry goes on before the merge, because a snapshot has to be taken
  // before the thing it is a snapshot of changes. A failure therefore has to
  // take it off again, or the first Ctrl+Z afterwards does nothing at all.
  const { App, seen } = setup({ boundary: box(0, 0, 1) });
  assert.equal(
    await App.data.importData(file(payload({ version: 99 })), { merge: true }),
    false,
  );
  assert.equal(seen.pushed, true, "nothing was recorded to take back");
  assert.equal(seen.undone, true, "the failed merge left its step behind");
});
