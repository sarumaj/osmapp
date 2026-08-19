/**
 * What polygons.setClusters stores, as opposed to what it is handed.
 *
 * Every territory on the map is written through that one function, which makes
 * it the only place a defect can be kept out of the stored outlines rather
 * than worked around wherever it later surfaces. The defect is a zero-width
 * tab — see geometry.despike — and the reason it has to be caught here is that
 * it accumulates: a territory carrying one is clipped again on the next edit,
 * and the clip leaves another.
 *
 * Unit level, against the real geometry.js and a Leaflet stub that models only
 * what setClusters touches. Nothing here renders, and the layer objects carry
 * no behavior beyond the handlers attachClusterEvents installs on them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

/**
 * A layer group that collects what it is given and accepts the delegated
 * handlers polygons.init() wires onto the street and building groups.
 */
function fakeGroup() {
  const layers = [];
  const group = {
    layers,
    addLayer: (l) => layers.push(l),
    clearLayers: () => layers.splice(0, layers.length),
    getLayers: () => layers.slice(),
    on: () => group,
    off: () => group,
  };
  return group;
}

/**
 * Just enough Leaflet for G.toLayer and attachClusterEvents: a geoJSON factory
 * whose layers answer to the Evented and Tooltip calls polygons.js makes.
 */
function fakeL() {
  return {
    geoJSON(collection) {
      const layer = {
        feature: collection.features ? collection.features[0] : collection,
        on: () => layer,
        off: () => layer,
        bindTooltip: () => layer,
        unbindTooltip: () => layer,
        closeTooltip: () => layer,
        setStyle: () => layer,
        getLayers: () => [layer],
      };
      return layer;
    },
  };
}

function setup() {
  const App = loadApp(["util.js", "state.js", "geometry.js", "polygons.js"], {
    window: {},
    turf,
    L: fakeL(),
  });
  App.i18n = { t: (key) => key, n: (v) => String(v) };
  App.state.innerPolygonsLayerGroup = fakeGroup();
  App.state.streetsLayerGroup = fakeGroup();
  App.state.buildingsLayerGroup = fakeGroup();
  App.polygons.init();
  return App;
}

/** A square with a zero-width tab spliced into its southern edge. */
function spiked() {
  return {
    type: "Polygon",
    coordinates: [
      [
        [0, 50],
        [0.0004, 50],
        [0.0002, 50],
        [0.002, 50],
        [0.002, 50.002],
        [0, 50.002],
        [0, 50],
      ],
    ],
  };
}

test("a territory is stored without the tab it arrived with", () => {
  const App = setup();
  const before = spiked();

  App.polygons.setClusters([{ type: "Feature", geometry: before, properties: {} }], {
    silent: true,
  });

  const stored = App.state.clusters[0].feature;
  assert.equal(
    stored.geometry.coordinates[0].length,
    before.coordinates[0].length - 1,
    "the vertex the ring reversed at is not stored",
  );
  assert.ok(
    Math.abs(turf.area(stored) - turf.area(turf.feature(before))) < 0.01,
    "and the territory covers the same ground",
  );
});

test("a clean territory is stored exactly as it came", () => {
  // The cleaning must not be a rewrite. A territory that needs nothing done to
  // it keeps its own coordinates, so nothing downstream sees a change that did
  // not happen.
  const App = setup();
  const geometry = {
    type: "Polygon",
    coordinates: [
      [
        [0, 50],
        [0.002, 50],
        [0.002, 50.002],
        [0, 50.002],
        [0, 50],
      ],
    ],
  };

  App.polygons.setClusters([{ type: "Feature", geometry, properties: {} }], {
    silent: true,
  });

  assert.equal(App.state.clusters[0].feature.geometry, geometry);
});

test("cleaning does not cost a territory its properties", () => {
  // setClusters carries the printed mark and the name through; the geometry it
  // swaps in must not take them with it.
  const App = setup();

  App.polygons.setClusters(
    [{ type: "Feature", geometry: spiked(), properties: { printed: "2026-01-02", name: "Ost" } }],
    { silent: true },
  );

  assert.deepEqual(App.state.clusters[0].feature.properties, {
    printed: "2026-01-02",
    name: "Ost",
  });
});
