/**
 * The three parts of geometry.js that are about turf rather than about
 * bookkeeping, so they run against the real, vendored turf.
 *
 * `unionHealed` is the one that had actually broken. It grows every input by
 * half a meter so that boundaries which only nearly coincide genuinely
 * dissolve, unions, and then shrinks back — except the shrink read `G.
 * polygonParts`, and there is no `G` inside that file. The ReferenceError
 * landed in the surrounding catch, so for as long as that line existed the
 * function grew and unioned and never shrank, and every merged territory kept
 * the half meter. Nothing on screen says so: the shape looks right, it is
 * simply slightly too big, and it stays too big through export, session
 * restore and every later merge.
 *
 * So the assertion below is about the *excess area* rather than about the
 * shape, because excess area is the thing that was wrong and the thing a
 * future refactor could quietly restore.
 *
 * `interiorPoint` is the second: three modules had grown their own copy of
 * pointOnFeature-with-a-centroid-fallback, and they have to agree — the number
 * chip, the piece assignment in clustering and the reverse geocode are all
 * supposed to be about the same spot inside the same territory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf, square } from "./helpers/turf.mjs";

const turf = loadTurf();
const G = loadApp(["geometry.js"], { turf }).geometry;

/** meters, near 50°N, as a longitude/latitude delta. */
const M = 1 / 110540;

// ── unionHealed ──────────────────────────────────────────────────────────────

test("unionHealed dissolves a gap too narrow to share vertices", () => {
  // Adjacent territories rarely share exact vertices — phase 5 clips each slot
  // independently and rounds to five decimals — so a plain union leaves a
  // hairline sliver and Leaflet draws the internal outline.
  const west = square(turf, 0, 50, 0.001);
  const east = square(turf, 0.001 + 0.2 * M, 50, 0.001);

  const merged = G.unionHealed([west, east]);
  assert.ok(merged, "the merge should produce something");
  assert.equal(
    G.polygonParts(merged).length,
    1,
    "a 20 cm gap should close into a single polygon",
  );
});

test("unionHealed gives the half-meter growth back", () => {
  // The regression. Without the shrink the result carries the whole buffer,
  // which on this fixture is roughly 270 m² of territory that does not exist.
  const west = square(turf, 0, 50, 0.001);
  const east = square(turf, 0.001 + 0.2 * M, 50, 0.001);

  const merged = G.unionHealed([west, east]);
  const inputs = turf.area(west) + turf.area(east);
  const excess = turf.area(merged) - inputs;

  assert.ok(
    excess < 60,
    `the union should shrink back to its inputs, but carries ${excess.toFixed(0)} m² of buffer`,
  );
  assert.ok(excess > -60, "and it must not erode real territory either");
});

test("unionHealed keeps a courtyard but drops a union sliver", () => {
  // A ring with a genuine hole in the middle, merged with a neighbour.
  const outer = [
    [0, 50],
    [0.002, 50],
    [0.002, 50.002],
    [0, 50.002],
    [0, 50],
  ];
  const courtyard = [
    [0.0008, 50.0008],
    [0.0012, 50.0008],
    [0.0012, 50.0012],
    [0.0008, 50.0012],
    [0.0008, 50.0008],
  ];
  const ring = turf.polygon([outer, courtyard]);

  const merged = G.unionHealed([ring]);
  const parts = G.polygonParts(merged);
  assert.equal(parts.length, 1);
  assert.ok(
    parts[0].geometry.coordinates.length > 1,
    "a courtyard is a real hole and has to survive",
  );
});

test("unionHealed survives a single input", () => {
  const only = square(turf, 0, 50, 0.001);
  const merged = G.unionHealed([only]);
  assert.ok(merged && merged.geometry);
  assert.ok(Math.abs(turf.area(merged) - turf.area(only)) < 60);
});

// ── dropSmallHoles ───────────────────────────────────────────────────────────

test("dropSmallHoles removes a ring below the floor and keeps one above it", () => {
  const outer = [
    [0, 50],
    [0.002, 50],
    [0.002, 50.002],
    [0, 50.002],
    [0, 50],
  ];
  const sliver = [
    [0.001, 50.001],
    [0.001 + 0.05 * M, 50.001],
    [0.001 + 0.05 * M, 50.001 + 0.05 * M],
    [0.001, 50.001],
  ];
  const courtyard = [
    [0.0015, 50.0015],
    [0.0018, 50.0015],
    [0.0018, 50.0018],
    [0.0015, 50.0018],
    [0.0015, 50.0015],
  ];

  const cleaned = G.dropSmallHoles(turf.polygon([outer, sliver, courtyard]));
  const rings = G.polygonParts(cleaned)[0].geometry.coordinates;
  assert.equal(rings.length, 2, "the outer ring plus the courtyard, not the sliver");
});

// ── interiorPoint ────────────────────────────────────────────────────────────

test("interiorPoint lands inside a C shape, where the centroid does not", () => {
  // The case the helper exists for: a horseshoe whose vertex mean falls in the
  // gap, which is where a number chip used to be drawn.
  const c = turf.polygon([
    [
      [0, 50],
      [0.003, 50],
      [0.003, 50.001],
      [0.001, 50.001],
      [0.001, 50.002],
      [0.003, 50.002],
      [0.003, 50.003],
      [0, 50.003],
      [0, 50],
    ],
  ]);

  const centroid = turf.centroid(c);
  assert.equal(
    turf.booleanPointInPolygon(centroid, c),
    false,
    "the fixture is only interesting if the centroid really is outside",
  );

  const inside = G.interiorPoint(c);
  assert.ok(inside, "an interior point should always be findable here");
  assert.equal(turf.booleanPointInPolygon(inside, c), true);
});

test("interiorCoord returns the same point as a bare lng/lat pair", () => {
  const shape = square(turf, 0, 50, 0.001);
  assert.deepEqual(
    G.interiorCoord(shape),
    G.interiorPoint(shape).geometry.coordinates,
  );
});

test("interiorPoint accepts a bare geometry as well as a feature", () => {
  const shape = square(turf, 0, 50, 0.001);
  const fromGeometry = G.interiorPoint(shape.geometry);
  assert.ok(fromGeometry);
  assert.deepEqual(fromGeometry.geometry.coordinates, G.interiorCoord(shape));
});

test("interiorPoint returns null rather than throwing on nothing usable", () => {
  assert.equal(G.interiorPoint(null), null);
  assert.equal(G.interiorPoint({ type: "Feature", properties: {} }), null);
  assert.equal(G.interiorCoord(null), null);
});

// ── largestPolygon ───────────────────────────────────────────────────────────

test("largestPolygon picks the biggest part of a MultiPolygon", () => {
  const small = square(turf, 0, 50, 0.0005);
  const big = square(turf, 0.01, 50, 0.002);
  const both = turf.multiPolygon([
    small.geometry.coordinates,
    big.geometry.coordinates,
  ]);

  const picked = G.largestPolygon(both);
  assert.ok(Math.abs(turf.area(picked) - turf.area(big)) < 1);
});
