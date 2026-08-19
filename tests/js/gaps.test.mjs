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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

// The vendored bundle, in this realm — the same one the browser runs, and the
// same trick geometry.test.mjs uses. Stubbing turf here would only assert
// that the stub agrees with the test.
const turf = loadTurf();

/**
 * The tuning constants as shipped, not as retyped here.
 *
 * These were copied into the harness, which meant the floor test asserted
 * that the harness agreed with itself: raising GAP_MIN_M2 in state.js to a
 * value that hides real gaps would have left every test green.
 */
const STATE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "..", "src", "osmapp", "static", "js", "state.js",
  ),
  "utf8",
);

function tuning(name) {
  const found = STATE.match(new RegExp(`\\b${name}:\\s*([\\d.]+)`));
  assert.ok(found, `${name} is not declared in state.js`);
  return Number(found[1]);
}

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

/**
 * Stand gaps.js up over a real geometry.js and stubs for everything else.
 *
 * The subtraction is the thing under test, so geometry.js and turf are the real
 * ones; App.dom, App.ui, App.controls and App.history are inert, and the layer
 * group only records what was added to it. `outer` is what
 * geometry.getOuterFeature returns, since the boundary is one of the two inputs.
 */
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
  // busy() runs its work inline here. In the browser it decides whether the
  // job is heavy enough to put a spinner in front of and defer a tick for;
  // what these tests are about is what the work does, not when.
  App.ui = { showContextMenu: noop, busy: (key, work) => work() };
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
    GAP_MIN_M2: tuning("GAP_MIN_M2"),
    GAP_OPEN_M: tuning("GAP_OPEN_M"),
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

// ── Gaps that were being lost ────────────────────────────────────────────────
//
// Reported as "sometimes an empty space is not offered". Three separate
// causes, all of them silent — the area simply was not there, with nothing on
// screen to say anything had been found and discarded.

/** Meters to degrees, near enough at the equator for fixtures this size. */
const M = 1 / 111320;

function ring(coords) {
  return turf.polygon([coords.concat([coords[0]])]);
}

test("both halves of a gap pinched in the middle are offered", () => {
  // A barbell: two open areas joined by a strip narrower than a meter, which
  // is what a lane between two territories looks like. Opening erodes the
  // neck away and the region falls into two lobes — and the old code kept
  // G.largestPolygon of them, throwing the other half away.
  const outer = ring([
    [0, 0],
    [100 * M, 0],
    [100 * M, 100 * M],
    [0, 100 * M],
  ]);
  // Two territories that between them leave a barbell uncovered.
  const left = ring([
    [40 * M, 0],
    [60 * M, 0],
    [60 * M, 49.7 * M],
    [40 * M, 49.7 * M],
  ]);
  const right = ring([
    [40 * M, 50.3 * M],
    [60 * M, 50.3 * M],
    [60 * M, 100 * M],
    [40 * M, 100 * M],
  ]);

  const h = setup({ outer, clusters: [left, right] });
  h.gaps.recompute();

  assert.equal(h.gaps.count(), 2, "both open areas must be offered");
  const areas = h.gaps.features().map((f) => turf.area(f));
  assert.ok(
    Math.min(...areas) > 1000,
    "the smaller half is a real area, not a sliver",
  );
});

test("a plot-sized gap is offered", () => {
  // 30 × 30 m — a house plot between two territories, and 900 m² is the size
  // that decides where GAP_MIN_M2 belongs. A floor at 1000 would find this,
  // measure it, and drop it for being small, which is precisely the ground
  // somebody still has to walk.
  const outer = ring([
    [0, 0],
    [100 * M, 0],
    [100 * M, 100 * M],
    [0, 100 * M],
  ]);
  const covering = ring([
    [30 * M, 0],
    [100 * M, 0],
    [100 * M, 100 * M],
    [0, 100 * M],
    [0, 30 * M],
    [30 * M, 30 * M],
  ]);

  const h = setup({ outer, clusters: [covering] });
  h.gaps.recompute();

  assert.equal(h.gaps.count(), 1);
  assert.ok(turf.area(h.gaps.features()[0]) > 800);
});

test("one unusable territory does not put a gap over a good one", () => {
  // G.unionAll drops a feature it cannot fold in and keeps going. For merging
  // that is right; here it means a territory disappears from the covered set
  // and its own ground is announced as uncovered — click it and you build a
  // second territory on top of the first.
  const outer = ring([
    [0, 0],
    [200 * M, 0],
    [200 * M, 200 * M],
    [0, 200 * M],
  ]);
  const good = ring([
    [0, 0],
    [100 * M, 0],
    [100 * M, 200 * M],
    [0, 200 * M],
  ]);
  // A bow-tie: self-intersecting, the shape a bad cut or a dragged corner
  // can leave behind.
  const bowtie = turf.polygon([
    [
      [100 * M, 0],
      [200 * M, 200 * M],
      [200 * M, 0],
      [100 * M, 200 * M],
      [100 * M, 0],
    ],
  ]);

  const h = setup({ outer, clusters: [good, bowtie] });
  h.gaps.recompute();

  // Whatever is offered must not overlap a territory that is really there.
  for (const gap of h.gaps.features()) {
    let overlap = null;
    try {
      overlap = turf.intersect(gap, good);
    } catch (e) {
      overlap = null;
    }
    const area = overlap ? turf.area(overlap) : 0;
    assert.ok(
      area < 1,
      `a gap was offered over an existing territory (${Math.round(area)} m²)`,
    );
  }
});

// ── Suppression ──────────────────────────────────────────────────────────────

test("a boundary covered by an awkward set of territories still reports nothing", () => {
  // The slow path has to agree with the fast one about the healthy case.
  const outer = ring([
    [0, 0],
    [100 * M, 0],
    [100 * M, 100 * M],
    [0, 100 * M],
  ]);
  const halves = [
    ring([
      [0, 0],
      [50 * M, 0],
      [50 * M, 100 * M],
      [0, 100 * M],
    ]),
    ring([
      [50 * M, 0],
      [100 * M, 0],
      [100 * M, 100 * M],
      [50 * M, 100 * M],
    ]),
  ];

  const h = setup({ outer, clusters: halves });
  h.gaps.recompute();
  assert.equal(h.gaps.count(), 0);
});

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
