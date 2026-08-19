/**
 * What a refresh of the filtered view is allowed to redo.
 *
 * refreshFilteredData() runs inside every change to the map, and on a real
 * project — a hundred territories, twelve thousand buildings, eighteen hundred
 * streets — an uncached pass is a second of blocked main thread each time,
 * nearly all of it repeated work: the same streets tested against the same
 * territories, and twelve thousand Leaflet shapes destroyed and rebuilt in the
 * same places.
 *
 * Both caches key on object identity, which is only sound because the app
 * never rewrites geometry in place — a changed territory is a new object, and
 * so is a reloaded street. These tests pin that down from the outside: what a
 * refresh produces must not depend on what the previous refresh left behind.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

/** A LayerGroup with the four methods the filtered view uses. */
function fakeGroup() {
  const layers = [];
  return {
    layers: layers,
    on: () => {},
    addLayer: (l) => layers.push(l),
    removeLayer: (l) => {
      const i = layers.indexOf(l);
      if (i >= 0) layers.splice(i, 1);
    },
    getLayers: () => layers.slice(),
    clearLayers: () => layers.splice(0, layers.length),
  };
}

/** L.geoJSON, reduced to what it is used for here: one layer per feature. */
function fakeL(built) {
  return {
    geoJSON(collection, options) {
      const layers = collection.features.map((f) => {
        built.push(f);
        return { feature: f, options: options, setStyle: () => {} };
      });
      return {
        getLayers: () => layers.slice(),
        removeLayer: (l) => {
          const i = layers.indexOf(l);
          if (i >= 0) layers.splice(i, 1);
        },
      };
    },
  };
}

const square = (x, y, size) =>
  turf.polygon([
    [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ],
  ]).geometry;

/**
 * Three territories in a row, each with a street through it and two buildings
 * in it, plus one street running along every boundary — the case the counts
 * are deliberately allowed to double-count.
 */
function fixture() {
  const territories = [0, 1, 2].map((i) => ({
    type: "Feature",
    properties: {},
    geometry: square(i, 0, 1),
  }));

  const streets = [];
  for (let i = 0; i < 3; i++) {
    streets.push({
      type: "Feature",
      properties: { name: "through " + i },
      geometry: {
        type: "LineString",
        coordinates: [
          [i + 0.1, 0.5],
          [i + 0.9, 0.5],
        ],
      },
    });
  }
  streets.push({
    type: "Feature",
    properties: { name: "the boundary" },
    geometry: {
      type: "LineString",
      coordinates: [
        [1, 0.2],
        [1, 0.8],
      ],
    },
  });
  streets.push({
    type: "Feature",
    properties: { name: "far away" },
    geometry: {
      type: "LineString",
      coordinates: [
        [9, 9],
        [9.5, 9.5],
      ],
    },
  });

  const buildings = [];
  for (let i = 0; i < 3; i++) {
    buildings.push({
      type: "Feature",
      properties: { id: "b" + i + "a" },
      geometry: square(i + 0.2, 0.2, 0.1),
    });
    buildings.push({
      type: "Feature",
      properties: { id: "b" + i + "b" },
      geometry: square(i + 0.6, 0.6, 0.1),
    });
  }
  buildings.push({
    type: "Feature",
    properties: { id: "outside" },
    geometry: square(9, 9, 0.1),
  });

  return { territories: territories, streets: streets, buildings: buildings };
}

/** A loaded polygons.js with real geometry, fake Leaflet and no map. */
function setup() {
  const built = [];
  // The tests own the clock. polygons.js times a refresh through
  // window.performance, and a three-territory fixture takes less than the
  // millisecond Date.now() can see — so left to the machine, a full pass
  // measures zero, the next warm one measures one, and which of those a run
  // gets is decided by where the tick fell. `cost` says what the next refresh
  // is to be worth, and nothing here has to guess.
  let reading = 0;
  let tick = 0;
  const window = { performance: { now: () => (reading += tick) } };
  const App = loadApp(["util.js", "state.js", "geometry.js", "polygons.js"], {
    window: window,
    turf: turf,
    L: fakeL(built),
  });
  App.i18n = { t: (key) => key, n: (v) => String(v) };
  App.ui = {
    setInfoFiltered: () => {},
    setInfoLoaded: () => {},
    setPrintedCount: () => {},
  };

  const data = fixture();
  const state = App.state;
  state.streetsLayerGroup = fakeGroup();
  state.buildingsLayerGroup = fakeGroup();
  state.cachedStreets = { type: "FeatureCollection", features: data.streets };
  state.cachedBuildings = {
    type: "FeatureCollection",
    features: data.buildings,
  };
  App.polygons.init();

  // setClusters() wants Leaflet layers and a map; the filtered view only ever
  // reads the features, so the store is filled directly.
  const use = (features) => {
    state.clusters = features.map((f) => ({ feature: f, layer: {} }));
  };
  use(data.territories);

  let calls = 0;
  const real = turf.booleanIntersects;
  turf.booleanIntersects = function () {
    calls++;
    return real.apply(null, arguments);
  };

  return {
    App: App,
    state: state,
    data: data,
    built: built,
    use: use,
    calls: () => calls,
    /** What the next refresh will be timed at, in milliseconds. */
    cost: (ms) => {
      tick = ms;
    },
    restore: () => {
      turf.booleanIntersects = real;
    },
    /** What the counts and the rendered view add up to. */
    summary: () => ({
      counts: state.clusters.map((c) => ({
        streets: c.counts.streets,
        buildings: c.counts.buildings,
      })),
      streets: state.streetsLayerGroup
        .getLayers()
        .map((l) => l.feature.properties.name)
        .sort(),
      buildings: state.buildingsLayerGroup
        .getLayers()
        .map((l) => l.feature.properties.id)
        .sort(),
    }),
  };
}

test("the filtered view is what the data says it is", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const view = ctx.summary();

    assert.deepEqual(view.buildings, [
      "b0a",
      "b0b",
      "b1a",
      "b1b",
      "b2a",
      "b2b",
    ]);
    assert.deepEqual(view.streets, [
      "the boundary",
      "through 0",
      "through 1",
      "through 2",
    ]);
    assert.deepEqual(
      view.counts.map((c) => c.buildings),
      [2, 2, 2],
    );
    // The boundary street is counted by both of the territories it separates,
    // which is the point: someone walking either one will meet it.
    assert.deepEqual(
      view.counts.map((c) => c.streets),
      [2, 2, 1],
    );
  } finally {
    ctx.restore();
  }
});

test("a refresh that changed nothing re-tests no street", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const first = ctx.calls();
    assert.ok(first > 0, "the first pass has to do the work");

    ctx.App.polygons.refreshFilteredData();
    assert.equal(ctx.calls(), first, "the second pass repeated it");
  } finally {
    ctx.restore();
  }
});

test("only the territory that changed is measured again", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const first = ctx.calls();

    const next = ctx.data.territories.slice();
    next[1] = {
      type: "Feature",
      properties: {},
      geometry: square(1, 0, 0.6),
    };
    ctx.use(next);
    ctx.App.polygons.refreshFilteredData();

    const again = ctx.calls() - first;
    assert.ok(again > 0, "the changed territory has to be re-measured");
    assert.ok(again < first, "the unchanged ones must not be");

    assert.equal(ctx.state.clusters[1].counts.buildings, 1);
  } finally {
    ctx.restore();
  }
});

test("a rebuilt territory of the same shape is measured again", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const before = ctx.summary();
    const first = ctx.calls();

    ctx.use(
      ctx.data.territories.map((f) => ({
        type: "Feature",
        properties: {},
        geometry: JSON.parse(JSON.stringify(f.geometry)),
      })),
    );
    ctx.App.polygons.refreshFilteredData();

    assert.equal(ctx.calls() - first, first, "nothing could be reused");
    assert.deepEqual(ctx.summary(), before, "and the answer did not move");
  } finally {
    ctx.restore();
  }
});

test("shapes already on the map are left where they are", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const layers = ctx.state.buildingsLayerGroup.getLayers();
    const madeOnce = ctx.built.length;

    ctx.App.polygons.refreshFilteredData();
    assert.equal(ctx.built.length, madeOnce, "shapes were rebuilt");
    assert.deepEqual(
      ctx.state.buildingsLayerGroup.getLayers(),
      layers,
      "the same layer objects have to still be the ones on the map",
    );
  } finally {
    ctx.restore();
  }
});

test("a territory going away takes only its own shapes with it", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const kept = ctx.state.buildingsLayerGroup
      .getLayers()
      .filter((l) => !l.feature.properties.id.startsWith("b2"));
    const madeOnce = ctx.built.length;

    ctx.use(ctx.data.territories.slice(0, 2));
    ctx.App.polygons.refreshFilteredData();

    assert.equal(ctx.built.length, madeOnce, "nothing had to be built");
    assert.deepEqual(ctx.state.buildingsLayerGroup.getLayers(), kept);
  } finally {
    ctx.restore();
  }
});

test("a group emptied from outside is filled again", () => {
  const ctx = setup();
  try {
    ctx.App.polygons.refreshFilteredData();
    const view = ctx.summary();

    ctx.state.buildingsLayerGroup.clearLayers();
    ctx.state.streetsLayerGroup.clearLayers();
    ctx.App.polygons.refreshFilteredData();

    assert.deepEqual(ctx.summary(), view);
  } finally {
    ctx.restore();
  }
});

test("the cost estimate keeps describing a full pass", () => {
  const ctx = setup();
  const fresh = () =>
    ctx.data.territories.map((f) => ({
      type: "Feature",
      properties: {},
      geometry: JSON.parse(JSON.stringify(f.geometry)),
    }));
  try {
    ctx.cost(50);
    ctx.App.polygons.refreshFilteredData();
    assert.equal(ctx.App.polygons.refreshCostMs(), 50);

    ctx.cost(1);
    ctx.App.polygons.refreshFilteredData();
    assert.equal(
      ctx.App.polygons.refreshCostMs(),
      50,
      "a refresh answered from cache says nothing about the next one",
    );

    ctx.use(fresh());
    ctx.cost(20);
    ctx.App.polygons.refreshFilteredData();
    assert.equal(ctx.App.polygons.refreshCostMs(), 20);
    ctx.cost(300);
    ctx.App.polygons.refreshFilteredData();
    assert.equal(ctx.App.polygons.refreshCostMs(), 300);
  } finally {
    ctx.restore();
  }
});
