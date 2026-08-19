/**
 * The parts of geometry.js that are about turf rather than about bookkeeping,
 * run against the real vendored turf rather than a stub.
 *
 * See helpers/turf.mjs for why these particular tests use the real library
 * when most tests in this directory do not.
 *
 * ── unionHealed ───────────────────────────────────────────────────────────
 *
 * Merging two territories has to leave one shape with no line drawn through
 * the middle of it. Adjacent territories almost never share exact vertices, so
 * unionHealed grows each input by half a meter, unions, and shrinks the result
 * back by the same amount.
 *
 * The assertions here are about *excess area* rather than about the outline,
 * and that is deliberate. A failure of the shrink step is invisible on screen:
 * the merged shape looks exactly right and is half a meter too big all the way
 * round. Nothing reports it, and the error persists through export,
 * session restore and every later merge. Area is the only symptom that can be
 * asserted on, so a change that skips or breaks the shrink fails here rather
 * than reaching a printed card.
 *
 * ── interiorPoint ─────────────────────────────────────────────────────────
 *
 * Three features ask where the inside of a territory is: labels.js anchors the
 * number chip there, clustering.js assigns loose pieces by it, and naming.js
 * reverse-geocodes it to suggest a name. They have to agree, or the chip sits
 * in one place and the looked-up name describes another. The test covers the
 * shapes where a naive answer — the centroid — falls outside the polygon
 * altogether.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf, square } from "./helpers/turf.mjs";

const turf = loadTurf();
const G = loadApp(["geometry.js"], { turf }).geometry;

/**
 * Convert meters to a rough degree delta near 50°N, the latitude the app is
 * mostly used at. Fixtures are written in meters because the thresholds under
 * test are, and a degree offset in the source would be unreadable.
 */
const M = 1 / 110540;

// ── unionHealed ──────────────────────────────────────────────────────────────

test("unionHealed dissolves a gap too narrow to share vertices", () => {
  // Two squares placed a hairline apart, which is the situation a real merge
  // faces: the partitioner clips each territory to the boundary
  // independently and coordinates are rounded to five decimals, so a shared
  // edge differs in the last digit. A plain turf.union of these leaves a
  // sliver between them, and Leaflet then draws the internal outline.
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
  // The heart of the file. If the shrink step is skipped, the result keeps
  // the entire half-meter buffer, which on this fixture is roughly 270 m² of
  // territory that does not exist on the ground.
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
  // A ring with a real hole in it — a courtyard or a quarry — merged with a
  // neighbor. The hole has to survive, since only union artefacts are meant
  // to be filled in.
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
  // The shape the helper exists for. A horseshoe's vertex mean, which is what
  // a centroid is, lands in the gap between the arms — outside the polygon,
  // and frequently inside a neighboring territory.
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

// ── unionAll ─────────────────────────────────────────────────────────────────
//
// unionAll takes the whole collection to turf in one call and only folds pair
// by pair when that fails. The fold is three to four times slower — it re-walks
// the accumulated shape on every step — and it is the reason the gap layer
// could block the main thread for seconds after every edit. What has to stay
// true through that change is the contract the callers were written against:
// the same answer, and a partial answer rather than none when one member is
// unusable.

test("unionAll dissolves the shared edges of adjacent squares", () => {
  const a = square(turf, 0, 50, 0.001);
  const b = square(turf, 0.001, 50, 0.001);
  const c = square(turf, 0.002, 50, 0.001);

  const merged = G.unionAll([a, b, c]);

  assert.equal(merged.geometry.type, "Polygon", "one shape, not three");
  const expected = turf.area(a) + turf.area(b) + turf.area(c);
  assert.ok(Math.abs(turf.area(merged) - expected) / expected < 1e-6);
});

test("unionAll agrees with folding pair by pair", () => {
  const parts = [0, 1, 2, 3].map((i) => square(turf, i * 0.001, 50, 0.001));

  let folded = parts[0];
  for (let i = 1; i < parts.length; i++) {
    folded = turf.union(turf.featureCollection([folded, parts[i]]));
  }

  const once = G.unionAll(parts);
  assert.ok(Math.abs(turf.area(once) - turf.area(folded)) < 1e-6);
});

test("one unusable member costs its own contribution, not the whole answer", () => {
  // A non-numeric coordinate fails the collection as a whole — turf rejects
  // the input before it clips anything — so this is the case the fold exists
  // to salvage. gaps.js depends on it: a covered set that loses a territory
  // announces that territory's ground as uncovered.
  const a = square(turf, 0, 50, 0.001);
  const b = square(turf, 0.001, 50, 0.001);
  const broken = {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[["x", 50], [0.01, 50], [0.01, 50.01], [0.009, 50.01], ["x", 50]]] },
  };

  const merged = G.unionAll([a, b, broken]);

  assert.ok(merged, "the good shapes still come back");
  const expected = turf.area(a) + turf.area(b);
  assert.ok(Math.abs(turf.area(merged) - expected) / expected < 1e-6);
});

test("unionAll handles the trivial lists without calling turf at all", () => {
  const a = square(turf, 0, 50, 0.001);
  assert.equal(G.unionAll([]), null);
  assert.equal(turf.area(G.unionAll([a])), turf.area(a));
});
