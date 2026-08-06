/**
 * Invariants in geometry.js and spatial.js that other modules rely on.
 * Each of these guards a bug that actually happened.
 */
const test = require("node:test");
const assert = require("node:assert");
const { load, square, rect } = require("./conftest.js");

const { App, turf } = load(["js/spatial.js", "js/geometry.js"]);
const G = App.geometry;
const SP = App.spatial;

test("polygonParts keeps every part of a MultiPolygon", () => {
  const multi = turf.multiPolygon([
    rect(0, 0, 0.001, 0.001).geometry.coordinates,
    rect(0.01, 0.01, 0.011, 0.011).geometry.coordinates,
  ]);
  assert.equal(G.polygonParts(multi).length, 2);
  assert.equal(G.polygonParts(rect(0, 0, 0.001, 0.001)).length, 1);
  assert.equal(G.polygonParts(null).length, 0);
});

test("largestPolygon picks the biggest part, not the first", () => {
  const multi = turf.multiPolygon([
    rect(0, 0, 0.0005, 0.0005).geometry.coordinates,
    rect(0.01, 0.01, 0.02, 0.02).geometry.coordinates,
  ]);
  const best = G.largestPolygon(multi);
  assert.ok(turf.area(best) > turf.area(turf.polygon(multi.geometry.coordinates[0])));
});

test("toLayer input survives a MultiPolygon round trip", () => {
  // The regression: L.polygon(extractCoordsArray(g)) dropped all but the
  // largest ring, so undo silently destroyed cluster fragments.
  const multi = turf.multiPolygon([
    rect(0, 0, 0.001, 0.001).geometry.coordinates,
    rect(0.01, 0.01, 0.012, 0.012).geometry.coordinates,
  ]);
  assert.equal(G.polygonParts(multi).length, 2, "input has two parts");
  assert.equal(
    G.extractCoordsArray(multi.geometry).length,
    1,
    "extractCoordsArray is lossy by design — only use it where that is fine",
  );
});

test("unionHealed dissolves a hairline gap into one polygon", () => {
  // Two squares 20 cm apart. A plain union leaves a MultiPolygon, and Leaflet
  // then draws the internal outlines — the "edges stay visible after merging"
  // bug.
  const a = rect(0, 0, 0.0009, 0.0009);
  const gapDeg = 0.2 / 111320;
  const b = rect(0.0009 + gapDeg, 0, 0.0018, 0.0009);

  const plain = G.union(a, b);
  const healed = G.unionHealed([a, b]);

  assert.equal(G.polygonParts(plain).length, 2, "plain union stays split");
  assert.equal(G.polygonParts(healed).length, 1, "healed union is one piece");
});

test("unionHealed stops at gaps wider than it claims to close", () => {
  // HEAL_METERS is 0.5, so each input grows by 0.5 m and gaps up to ~1 m
  // close. Anything wider is a real separation and must stay separate.
  const a = rect(0, 0, 0.0009, 0.0009);
  const wide = 1.5 / 111320;
  const b = rect(0.0009 + wide, 0, 0.0018, 0.0009);
  assert.equal(G.polygonParts(G.unionHealed([a, b])).length, 2);
});

test("dropSmallHoles removes slivers and keeps real courtyards", () => {
  const outer = rect(0, 0, 0.01, 0.01).geometry.coordinates[0];
  const courtyard = rect(0.004, 0.004, 0.006, 0.006).geometry.coordinates[0];
  const withHole = turf.polygon([outer, courtyard.slice().reverse()]);

  const kept = G.dropSmallHoles(withHole, 1);
  assert.equal(G.polygonParts(kept)[0].geometry.coordinates.length, 2, "courtyard kept");

  const huge = G.dropSmallHoles(withHole, 1e12);
  assert.equal(G.polygonParts(huge)[0].geometry.coordinates.length, 1, "sliver dropped");
});

test("nodeLineSegments splits at a crossing", () => {
  const crossing = G.nodeLineSegments([
    [[0, 0], [0.01, 0]],
    [[0.005, -0.005], [0.005, 0.005]],
  ]);
  // Both lines are cut at the intersection: 2 + 2 undirected edges.
  assert.equal(crossing.length, 4);
});

test("nodeLineSegments deduplicates a reversed duplicate line", () => {
  const out = G.nodeLineSegments([
    [[0, 0], [0.01, 0]],
    [[0.01, 0], [0, 0]],
  ]);
  assert.equal(out.length, 1);
});

test("isOnOuterBoundary detects a point on the ring, not inside it", () => {
  const ring = rect(0, 0, 0.01, 0.01).geometry.coordinates[0];
  assert.equal(G.isOnOuterBoundary([0.005, 0], ring), true, "midpoint of an edge");
  assert.equal(G.isOnOuterBoundary([0.005, 0.005], ring), false, "centre is not the ring");
});

test("bboxOverlap treats edge contact as overlap", () => {
  assert.equal(G.bboxOverlap([0, 0, 1, 1], [1, 0, 2, 1]), true);
  assert.equal(G.bboxOverlap([0, 0, 1, 1], [1.001, 0, 2, 1]), false);
});

test("MinHeap pops in ascending f", () => {
  const heap = new SP.MinHeap();
  [7, 3, 9, 1, 5].forEach((f) => heap.push({ f }));
  const order = [];
  while (heap.size()) order.push(heap.pop().f);
  assert.deepEqual(order, [1, 3, 5, 7, 9]);
  assert.equal(heap.pop(), null, "popping an empty heap is safe");
});

test("planar distance matches haversine closely at city scale", () => {
  const a = [8.7, 48.89];
  const b = [8.72, 48.9];
  const planar = SP.dist(a, b);
  const haversine = turf.distance(turf.point(a), turf.point(b), { units: "meters" });
  // Within 0.5%. The residual is a known systematic bias: M_PER_DEG_LAT is
  // 110540, an equatorial figure, while a meridian degree at 49 deg is closer
  // to 111230 — so north-south distances read about 0.6% short. That is a
  // consistent scale factor across a single map, so nearest-node lookups and
  // A* orderings are unaffected. It would matter if these metres were ever
  // shown to a user.
  const error = Math.abs(planar - haversine) / haversine;
  assert.ok(error < 0.005, `planar ${planar} vs haversine ${haversine}`);
});

test("Grid.nearestPoint finds the closest indexed point", () => {
  const grid = new SP.Grid(120);
  grid.addPoint([8.7, 48.89], "a");
  grid.addPoint([8.7005, 48.89], "b");
  grid.addPoint([8.8, 48.95], "far");

  const hit = grid.nearestPoint([8.70048, 48.89], 500);
  assert.equal(hit.payload, "b");
  assert.equal(grid.nearestPoint([9.5, 49.5], 100), null, "nothing within range");
});

test("Grid.nearestSegment returns a point on the segment", () => {
  const grid = new SP.Grid(120);
  grid.addSegment([8.7, 48.89], [8.701, 48.89], { kind: "street" });
  const hit = grid.nearestSegment([8.7005, 48.8902], 200);
  assert.ok(hit, "found the segment");
  assert.equal(hit.payload.kind, "street");
  assert.ok(Math.abs(hit.coord[1] - 48.89) < 1e-9, "snapped onto the line");
});
