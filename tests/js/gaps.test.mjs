/**
 * The parts of the area that belong to no territory.
 *
 * The whole feature turns on one distinction, and it is the one a naive
 * implementation gets wrong: a tessellation's internal edges coincide only to
 * floating-point precision, so subtracting a plain union of the territories
 * from the boundary returns a hairline sliver along every shared edge.
 * Hundreds of them, each a few centimeters wide, none of them a gap in any
 * sense that matters — and a map covered in dashed orange threads is worse
 * than no gap layer at all, because it trains people to ignore the one that
 * is real.
 *
 * So the assertions below are mostly about what must *not* be reported. The
 * seams, the scraps, and the case where there is nothing to say.
 *
 * Real turf, because this is a question about geometry rather than about
 * wiring: a stub that returns whatever the test wants would be asserting that
 * the test agrees with itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

// The vendored bundle, in this realm — the same one the browser runs, and the
// same trick geometry.test.mjs uses. Stubbing turf here would only assert
// that the stub agrees with the test.
const turf = loadTurf();

/** A square in degrees, small enough that turf.area is in the right ballpark. */
function box(west, south, east, north) {
  return turf.polygon([
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]);
}

function setup({ clusters = [], outer = box(0, 0, 0.02, 0.02) } = {}) {
  const noop = () => {};
  const layers = [];
  const group = {
    clearLayers: () => {
      layers.length = 0;
    },
    addLayer: (l) => layers.push(l),
  };

  // geometry.js for real, not a hand-rolled stand-in. The healing that makes
  // seams disappear is *its* grow/union/shrink, complete with the guard that
  // rejects a shrink which ate real area — reimplementing a simplified
  // version here would test the simplification instead.
  const App = loadApp(["geometry.js", "gaps.js"], {
    window: {},
    document: {},
    turf,
    L: {
      DomEvent: { stopPropagation: noop },
      geoJSON: () => ({
        getLayers: () => [
          { on: noop, bindTooltip: noop, setStyle: noop, getBounds: noop },
        ],
      }),
    },
  });

  let current = clusters.slice();

  App.i18n = { t: (k) => k, n: String };
  App.dom = {};
  App.controls = { refresh: noop };
  App.history = { push: noop };
  App.ui = { showContextMenu: noop };
  // The one thing the real module cannot do here is build a Leaflet layer.
  App.geometry.getOuterFeature = () => outer;
  App.polygons = {
    clusterFeatures: () => current,
    setClusters: (next) => {
      current = next;
    },
  };
  App.state = {
    outerPolygonLayer: {},
    gapsLayerGroup: group,
    editMode: false,
    mergeMode: false,
    trimMode: false,
    outlineMode: false,
    GAP_MIN_M2: 1000,
    leafletMap: { fitBounds: noop },
  };

  App.gaps.init();
  return { App, gaps: App.gaps, clusters: () => current, drawn: () => layers };
}

// ── What counts as a gap ─────────────────────────────────────────────────────

test("a fully covered area has no gaps", () => {
  const outer = box(0, 0, 0.02, 0.02);
  const h = setup({ outer, clusters: [outer] });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
  assert.equal(h.drawn().length, 0, "and nothing is drawn");
});

test("the strip left by growing the boundary is a gap", () => {
  // The case this feature exists for: the outline was dragged outward and the
  // new ground is in no territory, while the map looks finished.
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.015, 0.02)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1);
  assert.ok(h.gaps.totalArea() > 1000);
});

test("a deleted territory leaves a gap of exactly its own shape", () => {
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.01, 0.02)], // the right half was deleted
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1);
});

test("two separate holes are two gaps, largest first", () => {
  // Reported separately because they are separate decisions — and ordered so
  // that "zoom to the gap" from the info panel goes to the one worth seeing.
  const outer = box(0, 0, 0.03, 0.01);
  const h = setup({
    outer,
    clusters: [box(0, 0, 0.005, 0.01), box(0.01, 0, 0.02, 0.01)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 2);

  const found = h.gaps.features();
  assert.ok(
    turf.area(found[0]) >= turf.area(found[1]),
    "largest first, so the info panel zooms somewhere useful",
  );
});

// ── What must not count ──────────────────────────────────────────────────────

test("the seams of a tessellation are not gaps", () => {
  // Two territories sharing an edge. Their union is the whole area, but only
  // to floating-point precision — subtract a *plain* union and a hairline
  // sliver runs the length of every shared edge. Healing is what makes this
  // return nothing, and without it the map is covered in threads.
  const outer = box(0, 0, 0.02, 0.02);
  const h = setup({
    outer,
    clusters: [box(0, 0, 0.01, 0.02), box(0.01, 0, 0.02, 0.02)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0, "a shared edge is not an uncovered strip");
});

test("a scrap below the floor is not worth reporting", () => {
  // A cut shaves off a few square meters; a reshaped corner leaves a meter of
  // drift. Below GAP_MIN_M2 the ground belongs to nobody and nobody needs to
  // be told about it.
  const outer = box(0, 0, 0.02, 0.02);
  const h = setup({
    outer,
    // ~0.000002° short of the edge: a sliver far under a thousand square meters.
    clusters: [box(0, 0, 0.019998, 0.02)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
});

test("no boundary means nothing to be uncovered by", () => {
  const h = setup();
  h.App.state.outerPolygonLayer = null;
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
});

test("an empty area is not a gap", () => {
  // Nothing covered at all is the case ensureDefaultCluster already has an
  // opinion about; reporting the whole area as one enormous gap would be
  // arguing with it.
  const h = setup({ clusters: [] });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
});

// ── Suppression ──────────────────────────────────────────────────────────────

test("a modal tool hides the gaps and does not pay to find them", () => {
  // A click that quietly turns an empty patch into a territory in the middle
  // of drawing a split line costs more than the feature is worth.
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.015, 0.02)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1);

  h.App.state.editMode = true;
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
  assert.equal(h.drawn().length, 0);

  h.App.state.editMode = false;
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1, "and they come back on the way out");
});

test("switching the layer off stops the work, switching it on redoes it", () => {
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.015, 0.02)],
  });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1);

  h.gaps.setVisible(false);
  assert.equal(h.gaps.count(), 0);
  assert.equal(h.drawn().length, 0);

  h.gaps.setVisible(true);
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 1);
});

// ── Adopting ─────────────────────────────────────────────────────────────────

test("clicking a gap makes it a territory", () => {
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.015, 0.02)],
  });
  h.gaps.recompute();

  const before = h.clusters().length;
  h.gaps.adopt(h.gaps.features()[0]);
  assert.equal(h.clusters().length, before + 1);
});

test("adopting every gap is one step, not one per gap", () => {
  // Growing the boundary along one side can leave four slivers. Adopting them
  // one at a time is four clicks and four history entries for one decision.
  const outer = box(0, 0, 0.03, 0.01);
  const h = setup({
    outer,
    clusters: [box(0, 0, 0.005, 0.01), box(0.01, 0, 0.02, 0.01)],
  });
  h.gaps.recompute();

  let pushes = 0;
  h.App.history = { push: () => pushes++ };

  const made = h.gaps.adoptAll();
  assert.equal(made, 2);
  assert.equal(h.clusters().length, 4);
  assert.equal(pushes, 1, "one undoable step for the whole decision");
});

test("adopting a gap closes it", () => {
  const h = setup({
    outer: box(0, 0, 0.02, 0.02),
    clusters: [box(0, 0, 0.015, 0.02)],
  });
  h.gaps.recompute();
  h.gaps.adopt(h.gaps.features()[0]);

  // The adopted piece came from a healed subtraction, so it can sit up to
  // half a meter short of its neighbor — which is exactly what the floor is
  // there to swallow.
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0, "the gap must not survive being filled");
});
