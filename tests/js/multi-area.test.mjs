/**
 * Projects made of more than one area.
 *
 * A project used to be one boundary somebody drew. It can now also be several,
 * assembled by importing one village on top of another, and the difference
 * runs through the whole app: what "inside the boundary" means, which shape a
 * tool that can only work on one ring is given, and what happens to the areas
 * a tool did not touch.
 *
 * Three things are pinned here, and all three fail the same way when they
 * break - quietly, by keeping the biggest village and dropping the rest.
 *
 *   - **Reading a boundary.** getOuterFeature answers "which one area", and
 *     outerFeature answers "all of it". Getting them the wrong way round is
 *     invisible on a project with one area, which is every project anybody
 *     had before this existed.
 *   - **Writing one back.** A trim shrinks one area onto its buildings; the
 *     other two have to come out unchanged.
 *   - **Merging.** Importing a second project keeps what is on screen,
 *     appends what arrived, and refuses to let the two overlap - because
 *     territories not overlapping is the invariant the building counts, the
 *     gap finder and the printed marks all read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

/** A square of `size` degrees with its bottom-left corner at (x, y). */
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

/** A layer, as far as anything reading a boundary is concerned. */
function layerOf(feature) {
  return { toGeoJSON: () => feature };
}

function multi(...features) {
  return turf.multiPolygon(features.map((f) => f.geometry.coordinates));
}

const G = loadApp(["geometry.js"], { turf }).geometry;

// ── Reading a boundary ───────────────────────────────────────────────────────

test("every area of the boundary survives being read", () => {
  const parts = G.outerParts(layerOf(multi(box(0, 0, 1), box(10, 10, 2))));
  assert.equal(parts.length, 2);
  assert.ok(
    G.area(parts[0]) > G.area(parts[1]),
    "the areas come back smallest first, so `the largest` is the wrong one",
  );
});

test("the whole boundary is the whole boundary", () => {
  const whole = G.outerFeature(layerOf(multi(box(0, 0, 1), box(10, 10, 2))));
  assert.equal(whole.geometry.type, "MultiPolygon");
  assert.equal(whole.geometry.coordinates.length, 2);
});

test("one area is still one polygon, exactly as it always was", () => {
  const one = box(0, 0, 1);
  assert.equal(G.outerFeature(layerOf(one)).geometry.type, "Polygon");
  assert.equal(G.getOuterFeature(layerOf(one)).geometry.type, "Polygon");
});

test("a tool that needs one ring is given the area it is pointing at", () => {
  const layer = layerOf(multi(box(0, 0, 1), box(10, 10, 2)));
  // Inside the small one, which is not the largest - so anything that answers
  // `the largest` fails here and passes everywhere a project has one area.
  const picked = G.getOuterFeature(layer, [0.5, 0.5]);
  assert.ok(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), picked));
  assert.ok(!turf.booleanPointInPolygon(turf.point([11, 11]), picked));
});

test("pointing between two areas picks the nearer one, not the bigger one", () => {
  // The middle of the screen falls between them whenever both are on it, and
  // answering `neither` would send the tool to the largest.
  const layer = layerOf(multi(box(0, 0, 1), box(10, 10, 2)));
  const picked = G.getOuterFeature(layer, [1.5, 0.5]);
  assert.ok(turf.booleanPointInPolygon(turf.point([0.5, 0.5]), picked));
});

test("pointing at nothing in particular is the largest area", () => {
  const layer = layerOf(multi(box(0, 0, 1), box(10, 10, 2)));
  const picked = G.getOuterFeature(layer);
  assert.ok(turf.booleanPointInPolygon(turf.point([11, 11]), picked));
});

test("a boundary with a hole in it is still measurable", () => {
  // partAt measures to the outer ring only. turf.polygonToLine hands back a
  // collection as soon as a polygon has a hole, and pointToLineDistance
  // throws on a collection - which would drop the area out of the contest.
  const holed = turf.polygon([
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ],
    [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
    ],
  ]);
  const parts = [holed, box(20, 20, 1)];
  assert.equal(G.partAt(parts, [5, 5]), holed);
});

// ── Writing one area back ────────────────────────────────────────────────────

/**
 * polygons.js over stubs, with the boundary held in a variable the way the
 * map holds a layer. Only the two calls replaceOuterPart makes are real:
 * reading the boundary through geometry.js and handing back the shape that
 * replaces it.
 */
function boundaryHarness(initial) {
  const noop = () => {};
  let current = initial;

  const App = loadApp(["geometry.js", "polygons.js"], {
    turf,
    window: {},
    document: {},
    L: {
      DomEvent: { stopPropagation: noop },
      // Enough of a path for setOuterLayer and setClusters to wire their
      // handlers and their tooltips onto, plus the toGeoJSON that makes the
      // shape readable again afterwards.
      geoJSON: (feature) => ({
        getLayers: () => [
          {
            ...layerOf(feature),
            on: noop,
            off: noop,
            setStyle: noop,
            bindTooltip: noop,
            unbindTooltip: noop,
            closeTooltip: noop,
            getElement: () => null,
          },
        ],
      }),
    },
  });

  App.i18n = { t: (k) => k, n: String };
  App.dom = {};
  App.controls = { refresh: noop };
  App.labels = { refresh: noop, numberOf: () => 1 };
  App.gaps = { schedule: noop };
  App.session = { markDirty: noop };
  App.ui = { setPrintedCount: noop };
  const group = () => ({ clearLayers: noop, addLayer: noop, on: noop });
  App.state = {
    outerPolygonLayer: layerOf(current),
    outerPolygonLayerGroup: group(),
    innerPolygonsLayerGroup: group(),
    streetsLayerGroup: group(),
    buildingsLayerGroup: group(),
    clusters: [],
    selectedClusters: [],
    // The middle of the screen, which is where a tool with nothing else to go
    // on takes its area from.
    leafletMap: { getCenter: () => ({ lat: 0.5, lng: 0.5 }), on: noop },
    MIN_REMAINDER_M2: 50,
  };
  App.polygons.init();

  // setOuterLayer stores whatever geometry.toLayer built, which the stub above
  // makes readable again - so the boundary after the swap is inspectable.
  return App;
}

test("trimming one area leaves the others where they were", () => {
  const before = box(0, 0, 1);
  const App = boundaryHarness(multi(before, box(10, 10, 2)));
  App.polygons.setClusters([box(0, 0, 1)]);

  // The trimmed shape: the same area, half as wide.
  const after = turf.polygon([
    [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
      [0, 0],
    ],
  ]);
  assert.ok(App.polygons.replaceOuterPart(before, after));

  const parts = App.geometry.outerParts(App.state.outerPolygonLayer);
  assert.equal(parts.length, 2, "an area went missing");
  assert.ok(
    parts.some((p) => turf.booleanPointInPolygon(turf.point([11, 11]), p)),
    "the area nobody touched was thrown away",
  );
  assert.ok(
    !parts.some((p) => turf.booleanPointInPolygon(turf.point([0.75, 0.5]), p)),
    "the trimmed area was not actually trimmed",
  );
});

test("with one area, putting it back is replacing the boundary", () => {
  const before = box(0, 0, 1);
  const App = boundaryHarness(before);
  App.polygons.setClusters([box(0, 0, 1)]);
  assert.ok(App.polygons.replaceOuterPart(before, box(0, 0, 0.5)));
  const parts = App.geometry.outerParts(App.state.outerPolygonLayer);
  assert.equal(parts.length, 1);
});

test("an empty boundary gets one territory per area, not one for all of them", () => {
  // A single territory made of three disjoint pieces prints as one card
  // sending somebody to three villages.
  const App = boundaryHarness(multi(box(0, 0, 1), box(10, 10, 2)));
  assert.ok(App.polygons.ensureDefaultCluster());
  assert.equal(App.state.clusters.length, 2);
});
