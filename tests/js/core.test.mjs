/**
 * The two real algorithms in the client: the planar noder in geometry.js, and
 * the grid index and heap in spatial.js.
 *
 * ── What these do in the app ──────────────────────────────────────────────
 *
 * Noding turns a pile of overlapping street lines into a graph whose lines
 * only meet at shared endpoints, which is what the partitioner routes over.
 * The grid index answers "what is near this point" without scanning
 * everything, which is what the cut tool snaps with and what the route search
 * looks nodes up in.
 *
 * ── Why they are tested this thoroughly ───────────────────────────────────
 *
 * Both fail quietly rather than loudly. A noder that misses an intersection
 * produces a territory that looks correct until somebody tries to cut it. A
 * grid that returns the second-nearest segment makes the cut tool snap
 * somewhere plausible but wrong, which reads as the tool being imprecise
 * rather than as a bug with an address.
 *
 * Neither module touches the DOM, Leaflet or turf, so both load with no stubs
 * at all and the assertions are ordinary arithmetic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const G = loadApp(["geometry.js"]).geometry;
const SP = loadApp(["spatial.js"]).spatial;

// ── nodeLineSegments ─────────────────────────────────────────────────────────

test("crossing lines are split at the intersection", () => {
  const edges = G.nodeLineSegments([
    [[0, 0.5], [1, 0.5]],
    [[0.5, 0], [0.5, 1]],
  ]);
  assert.equal(edges.length, 4);
  const atNode = edges.filter((e) => e.some((c) => G.coordsEqual(c, [0.5, 0.5], 1e-7)));
  assert.equal(atNode.length, 4, "every edge should end at the node");
});

test("a T junction is split", () => {
  const edges = G.nodeLineSegments([
    [[0, 0], [2, 0]],
    [[1, 0.5], [1, -0.5]],
  ]);
  assert.equal(edges.length, 4);
});

test("non-crossing lines are left alone", () => {
  const edges = G.nodeLineSegments([
    [[0, 0], [1, 0]],
    [[0, 1], [1, 1]],
  ]);
  assert.equal(edges.length, 2);
});

test("lines meeting end-to-end are not split at the shared endpoint", () => {
  const edges = G.nodeLineSegments([
    [[0, 0], [1, 0]],
    [[1, 0], [2, 0]],
  ]);
  assert.equal(edges.length, 2);
});

test("a line and its reverse collapse to one edge", () => {
  assert.equal(
    G.nodeLineSegments([
      [[0, 0], [1, 0], [2, 0]],
      [[2, 0], [1, 0], [0, 0]],
    ]).length,
    2,
  );
});

test("degenerate lines are dropped", () => {
  assert.deepEqual(G.nodeLineSegments([[[0, 0]]]), []);
  assert.deepEqual(G.nodeLineSegments([[[0, 0], [0, 0]]]), []);
});

test("output is rounded to five decimals", () => {
  const edges = G.nodeLineSegments([[[0.1234567, 0.7654321], [1, 1]]]);
  assert.deepEqual(edges[0][0], [0.12346, 0.76543]);
});

test("noding 400 lines stays fast", () => {
  // 200 lines against 200 lines is 40 000 genuine crossings. Testing every
  // pair against every other would be 160 000 intersection tests, which is
  // why the noder bins segments into a coarse grid first. This case is here
  // to keep that path exercised and to catch a change that makes it
  // quadratic again.
  const lines = [];
  for (let i = 0; i < 200; i++) {
    lines.push([[0, i * 0.001], [0.2, i * 0.001]]);
    lines.push([[i * 0.001, 0], [i * 0.001, 0.2]]);
  }
  const started = Date.now();
  assert.ok(G.nodeLineSegments(lines).length > 0);
  assert.ok(Date.now() - started < 5000);
});

// ── dedupCoords ──────────────────────────────────────────────────────────────

test("dedupCoords drops consecutive duplicates but keeps a closing point", () => {
  assert.deepEqual(G.dedupCoords([[0, 0], [0, 0], [1, 1], [0, 0]]), [[0, 0], [1, 1], [0, 0]]);
});

test("dedupCoords collapses near-duplicates inside the tolerance", () => {
  assert.deepEqual(G.dedupCoords([[0, 0], [1e-9, 1e-9], [1, 1]]), [[0, 0], [1, 1]]);
});

// ── the grid index ───────────────────────────────────────────────────────────

test("nearestPoint widens one ring past the first hit", () => {
  // The nearest point is not necessarily in the nearest non-empty ring of
  // cells: a point just inside the next ring out can be closer than one in
  // the far corner of the current one. A search that stops as soon as it
  // finds anything gets this case wrong, so the fixture is built to have
  // exactly that shape.
  const grid = new SP.Grid(100);
  grid.addPoint([19.9013, 50.0], "far-same-cell");
  grid.addPoint([19.9004, 50.0], "near-next-cell");
  assert.equal(grid.nearestPoint([19.9, 50.0], 500).payload, "near-next-cell");
});

test("nearestPoint respects maxMeters", () => {
  const grid = new SP.Grid(100);
  grid.addPoint([19.9, 50.0], "a");
  assert.equal(grid.nearestPoint([20.5, 50.0], 200), null);
});

test("nearestSegment measures to the segment, not to its endpoints", () => {
  const grid = new SP.Grid(100);
  grid.addSegment([19.9, 50.0], [19.91, 50.0], "street");

  const hit = grid.nearestSegment([19.905, 50.0005], 500);
  assert.equal(hit.payload, "street");
  assert.ok(hit.dist < 60, `expected the perpendicular distance, got ${hit.dist}`);
});

test("nearestSegment prefers the genuinely closer of two segments", () => {
  const grid = new SP.Grid(100);
  grid.addSegment([19.9, 50.0], [19.91, 50.0], "south");
  grid.addSegment([19.9, 50.002], [19.91, 50.002], "north");
  assert.equal(grid.nearestSegment([19.905, 50.0019], 500).payload, "north");
  assert.equal(grid.nearestSegment([19.905, 50.0001], 500).payload, "south");
});

// A degree of longitude is 62% of a degree of latitude at the latitudes this
// app is used at, so a square-in-degrees cell is much narrower than it is
// tall. A ring counted in latitude degrees therefore reaches only 74 m to the
// east for a 120 m cell, and everything between there and maxMeters was
// reported as empty ground: no street to snap to, no boundary edge crossed.
const LAT = 52; // Poland and Germany, where the territories are
const M_PER_DEG_LAT = 110540;
const east = (metres) => metres / (111320 * Math.cos((LAT * Math.PI) / 180));
const north = (metres) => metres / M_PER_DEG_LAT;

test("nearestPoint reaches maxMeters to the east, not just to the north", () => {
  // 350 m out with a 400 m radius, and swept across a cell so the result does
  // not depend on where inside its own cell the query point happens to fall.
  for (let step = 0; step < 12; step++) {
    const lng = 19.9 + east(step * 10);
    const eastward = new SP.Grid(120);
    eastward.addPoint([lng + east(350), LAT], "east");
    assert.equal(eastward.nearestPoint([lng, LAT], 400)?.payload, "east", `east, offset ${step * 10} m`);

    const northward = new SP.Grid(120);
    northward.addPoint([lng, LAT + north(350)], "north");
    assert.equal(northward.nearestPoint([lng, LAT], 400)?.payload, "north", `north, offset ${step * 10} m`);
  }
});

test("nearestSegment reaches maxMeters to the east, not just to the north", () => {
  for (let step = 0; step < 12; step++) {
    const lng = 19.9 + east(step * 10);
    // A boundary edge running north-south, 350 m due east of the query point.
    const grid = new SP.Grid(120);
    grid.addSegment([lng + east(350), LAT - north(50)], [lng + east(350), LAT + north(50)], "edge");
    const hit = grid.nearestSegment([lng, LAT], 400);
    assert.ok(hit, `an edge 350 m east must be found within 400 m, offset ${step * 10} m`);
    assert.ok(Math.abs(hit.dist - 350) < 5, `expected about 350 m, got ${hit.dist}`);
  }
});

test("nearestSegment widens past the first hit before committing", () => {
  // Rings are counted in cells, and a cell is 120 m tall but 74 m wide here,
  // so the segment 250 m to the north is reached in fewer rings than the one
  // 200 m to the east. Committing to the first ring that produces a hit
  // returns the farther of the two.
  for (let step = 0; step < 12; step++) {
    const lng = 19.9 + east(step * 10);
    const grid = new SP.Grid(120);
    grid.addSegment([lng - east(50), LAT + north(250)], [lng + east(50), LAT + north(250)], "far");
    grid.addSegment([lng + east(200), LAT - north(50)], [lng + east(200), LAT + north(50)], "near");
    assert.equal(grid.nearestSegment([lng, LAT], 400).payload, "near", `offset ${step * 10} m`);
  }
});

test("closestOnSegment clamps to the endpoints", () => {
  const a = [19.9, 50.0];
  const b = [19.91, 50.0];
  assert.ok(Math.abs(SP.closestOnSegment([19.89, 50.0], a, b).coord[0] - a[0]) < 1e-6);
  assert.ok(Math.abs(SP.closestOnSegment([19.92, 50.0], a, b).coord[0] - b[0]) < 1e-6);
});

test("closestOnSegment handles a degenerate segment", () => {
  const a = [19.9, 50.0];
  assert.deepEqual(SP.closestOnSegment([19.901, 50.0], a, a).coord, a);
});

// ── MinHeap ──────────────────────────────────────────────────────────────────

test("MinHeap pops in ascending f order", () => {
  const heap = new SP.MinHeap();
  const scores = [7, 3, 9, 1, 4, 1, 8, 2];
  scores.forEach((f) => heap.push({ f }));
  const popped = scores.map(() => heap.pop().f);
  assert.deepEqual(popped, scores.slice().sort((a, b) => a - b));
});

test("MinHeap survives interleaved push and pop", () => {
  const heap = new SP.MinHeap();
  heap.push({ f: 5 });
  heap.push({ f: 2 });
  assert.equal(heap.pop().f, 2);
  heap.push({ f: 1 });
  assert.equal(heap.pop().f, 1);
  assert.equal(heap.pop().f, 5);
  assert.equal(heap.pop(), null);
});
