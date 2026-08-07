/**
 * The two pieces of real algorithm in the client: the planar noder in
 * geometry.js and the grid index plus heap in spatial.js.
 *
 * Both fail quietly. A noder that drops an intersection produces a territory
 * that looks fine until it is cut; a grid that returns the wrong nearest
 * segment makes the cut tool snap somewhere plausible but wrong.
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
  // 40 000 real crossings. Unbinned this is 160 000 pair tests, which is what
  // makes the grid worth having inside phase 5.
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
  // A point just inside the next cell can beat one in the same cell — exactly
  // what a naive "stop at the first non-empty ring" search gets wrong.
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
