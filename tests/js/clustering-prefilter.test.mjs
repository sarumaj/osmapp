/**
 * Two loops in clustering.js search an index instead of every candidate. Each
 * has to return what the exhaustive search returns — a faster search over the
 * same candidates, not a different answer — and neither is reachable from
 * outside the module, so nothing else in this directory can notice when that
 * stops being true.
 *
 * These tests therefore assert the *equivalence* rather than the result: the
 * reference implementation and the shipped shape are both run over the same
 * fixtures and their answers compared. A future change that makes the fast
 * path disagree fails here, whichever direction the disagreement points.
 *
 * ── The boundary index (phase 4) ──────────────────────────────────────────
 *
 * _phase4 stamps the outer ring into an App.spatial grid once and measures only
 * the segments in the neighboring cells. The exhaustive form calls
 * G.isOnOuterBoundary three times per unique cell edge, and each call walks the
 * whole ring.
 *
 * The equivalence rests on a margin: a grid cell is 25 m, the tolerance is
 * 0.00005 deg — under 6 m however the axes are weighted — and one ring of
 * neighbors is therefore always a superset of the segments that could pass
 * the test. The margin is what the second test below pins down, because if
 * anyone widens the tolerance without widening the search, the failure is a
 * boundary edge silently misclassified as an interior one, which routes it
 * through the street network and puts a territory edge through open ground.
 *
 * ── The adjacency prefilter (_touchingSlots) ──────────────────────────────
 *
 * A bbox rejection now runs before G.intersect. Bounding boxes are a
 * conservative test — two boxes that do not overlap belong to two shapes that
 * cannot intersect — so the prefilter can only ever skip work, never a hit.
 * The test asserts exactly that, over slot pairs where most are disjoint and
 * a few genuinely touch.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();
const App = loadApp(["util.js", "geometry.js", "spatial.js"], { turf });
const G = App.geometry;
const SP = App.spatial;

const TOLERANCE_DEG = 0.00005;
const CELL_M = 25;

// ── fixtures ──────────────────────────────────────────────────────────────

/**
 * Deterministic 0..1 generator, seeded per fixture.
 *
 * The equivalence assertions compare two implementations over the same random
 * geometry, so the geometry has to be reproducible: with Math.random a failure
 * names a case nobody can generate a second time.
 */
function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** A closed ring with enough vertices to be worth indexing. */
function ring(n, radiusDeg = 0.05, cx = 8.24, cy = 48.0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const r = radiusDeg * (1 + 0.02 * Math.sin(a * 17));
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.67]);
  }
  out.push(out[0].slice());
  return out;
}

/** The grid-backed predicate, exactly as _phase4 builds it. */
function indexedTester(outerRing) {
  const grid = new SP.Grid(CELL_M);
  for (let i = 0; i < outerRing.length - 1; i++) {
    grid.addSegment(outerRing[i], outerRing[i + 1], i);
  }
  return (point) => {
    const near = grid.candidates(point, 1);
    for (let i = 0; i < near.length; i++) {
      const seg = grid.items[near[i]];
      if (G.pointToSegmentDist(point, seg.a, seg.b) < TOLERANCE_DEG) return true;
    }
    return false;
  };
}

// ── the boundary index ────────────────────────────────────────────────────

test("the indexed boundary test agrees with the linear one everywhere", () => {
  const r = ring(2000);
  const onOuter = indexedTester(r);
  const rand = rng(4242);

  let onRing = 0;
  for (let i = 0; i < 20000; i++) {
    const p = [8.24 + (rand() * 2 - 1) * 0.06, 48.0 + (rand() * 2 - 1) * 0.045];
    assert.equal(onOuter(p), G.isOnOuterBoundary(p, r), `disagreed at ${p}`);
  }

  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i];
    const b = r[i + 1];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const p of [a, mid]) {
      assert.equal(onOuter(p), G.isOnOuterBoundary(p, r), `disagreed on ring at ${p}`);
      if (onOuter(p)) onRing++;
    }
  }
  assert.ok(onRing > 0, "no probe landed on the ring — the fixture is wrong");
});

test("points just inside and just outside the tolerance are classified alike", () => {
  const r = ring(800);
  const onOuter = indexedTester(r);

  for (let i = 0; i < r.length - 1; i += 7) {
    const [x, y] = r[i];
    for (const d of [0, 1e-6, 1e-5, 4.9e-5, 5.1e-5, 1e-4, 5e-4]) {
      for (const p of [
        [x + d, y],
        [x, y + d],
        [x + d, y + d],
      ]) {
        assert.equal(
          onOuter(p),
          G.isOnOuterBoundary(p, r),
          `disagreed at offset ${d} from vertex ${i}`,
        );
      }
    }
  }
});

test("the grid search is wide enough for the tolerance it enforces", () => {
  const cellDeg = new SP.Grid(CELL_M).cell;
  assert.ok(
    TOLERANCE_DEG < cellDeg,
    `tolerance ${TOLERANCE_DEG} deg must stay under one cell (${cellDeg} deg), ` +
      "or candidates(point, 1) can miss a qualifying segment",
  );
});

// ── the adjacency prefilter ───────────────────────────────────────────────

test("a bbox rejection never skips a pair that actually intersects", () => {
  // A grid of adjacent squares: neighbors touch, everything else is disjoint,
  // which is the shape _touchingSlots sees.
  const polys = [];
  const w = 0.01;
  for (let i = 0; i < 36; i++) {
    const x = 8.24 + (i % 6) * w;
    const y = 48.0 + Math.floor(i / 6) * w;
    polys.push(
      turf.polygon([
        [
          [x, y],
          [x + w, y],
          [x + w, y + w],
          [x, y + w],
          [x, y],
        ],
      ]),
    );
  }

  let rejected = 0;
  let kept = 0;
  for (const a of polys) {
    const probe = turf.buffer(a, 0.5, { units: "meters" }) || a;
    const probeBox = turf.bbox(probe);
    for (const b of polys) {
      const shared = G.intersect(probe, b);
      const trulyTouches = !!shared && turf.area(shared) > 0;
      const boxesOverlap = G.bboxOverlap(probeBox, turf.bbox(b));

      if (!boxesOverlap) {
        rejected++;
        assert.equal(
          trulyTouches,
          false,
          "the bbox prefilter skipped a pair that shares area",
        );
      } else {
        kept++;
      }
    }
  }

  assert.ok(rejected > 0, "the prefilter rejected nothing — fixture too dense");
  assert.ok(kept > 0, "the prefilter kept nothing — fixture too sparse");
});
