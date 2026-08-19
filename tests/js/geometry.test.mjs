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

test("unionHealed refuses to lose a shape whose growth collapsed", () => {
  // The failure this guards against, reduced to the one fact that matters.
  //
  // turf.buffer snaps its input to jsts's precision model first, and a ring
  // carrying a segment shorter than that model can represent — which a clip, a
  // union and a round trip through unionHealed leave plenty of — does not
  // survive that snap. A real project export held an 11,637 m² territory whose
  // buffer(+0.5 m) came back as 69 m² in fourteen pieces.
  //
  // Everything downstream then works correctly on a shape that is wrong: the
  // union folds in the slivers, the shrink is measured against the whole
  // footprint and passes because the loss is a fraction of a percent of it,
  // and one territory quietly stops existing. On the map the merge looks
  // right. The ground is discovered missing by whoever was sent to walk it.
  //
  // jsts is stubbed rather than provoked, because what is under test is the
  // response to a buffer that came back smaller, not turf's arithmetic.
  const big = square(turf, 0, 50, 0.002);
  const small = square(turf, 0.002, 50, 0.0002);
  const real = turf.buffer;
  try {
    turf.buffer = (feature, distance, options) => {
      const grown = real(feature, distance, options);
      // The small one collapses; everything else, including the shrink at the
      // end, behaves.
      if (distance > 0 && turf.area(feature) < 1000) return turf.buffer0Collapsed;
      return grown;
    };
    turf.buffer0Collapsed = square(turf, 0.002, 50, 0.00001);

    const merged = G.unionHealed([big, small]);

    assert.ok(merged && merged.geometry);
    const shared = turf.intersect(turf.featureCollection([merged, small]));
    assert.ok(
      shared && turf.area(shared) > turf.area(small) * 0.99,
      "the territory that could not be grown is still in the result",
    );
  } finally {
    turf.buffer = real;
    delete turf.buffer0Collapsed;
  }
});

test("unionHealed survives a single input", () => {
  const only = square(turf, 0, 50, 0.001);
  const merged = G.unionHealed([only]);
  assert.ok(merged && merged.geometry);
  assert.ok(Math.abs(turf.area(merged) - turf.area(only)) < 60);
});

// ── despike ──────────────────────────────────────────────────────────────────

/**
 * A 2 × 2 unit square at 50°N with `tab` spliced into its southern edge.
 *
 * The assertions are on the buffer rather than on the vertex count, because
 * the buffer is what the removal is for: jsts snaps its input to a precision
 * model first, and a tab welds into a self-touching edge under that snap. A
 * shape that buffers to less than itself is the failure, and it is silent —
 * unionHealed refuses the result and quietly degrades to a plain union, so
 * every merge involving the territory stops dissolving.
 *
 * @param {number[][]} tab vertices visited between the two southern corners
 */
function withTab(...tab) {
  return turf.polygon([
    [[0, 50], ...tab, [0.002, 50], [0.002, 50.002], [0, 50.002], [0, 50]],
  ]);
}

/** turf.area of the +0.5 m buffer, or -1 where jsts gives nothing back. */
function buffered(feature) {
  try {
    const grown = turf.buffer(feature, 0.5, { units: "meters" });
    return grown && grown.geometry ? turf.area(grown) : -1;
  } catch (e) {
    return -1;
  }
}

test("despike removes a tab and leaves the ground where it was", () => {
  // The southern edge overshoots 44 m east and comes 22 m back along itself
  // before carrying on. The tab encloses nothing and is invisible on the map.
  const spiked = withTab([0.0004, 50], [0.0002, 50]);
  assert.ok(
    buffered(spiked) < turf.area(spiked),
    "the fixture reproduces the failure: its buffer is smaller than it is",
  );

  const clean = G.despike(spiked);

  assert.ok(
    buffered(clean) > turf.area(clean),
    "and buffering it works again",
  );
  assert.ok(
    Math.abs(turf.area(clean) - turf.area(spiked)) < 0.01,
    "while enclosing the same ground",
  );
});

test("despike unwinds a tab that doubles back more than once", () => {
  // Out, back, out and back again. Removing one pair exposes the next, so a
  // single scan leaves half the tab behind; the vertex before each removal has
  // to be reconsidered, which is why despike walks the ring on a stack.
  const spiked = withTab(
    [0.0004, 50],
    [0.0002, 50],
    [0.0005, 50],
    [0.0003, 50],
  );

  const clean = G.despike(spiked);

  assert.ok(buffered(clean) > turf.area(clean));
  assert.ok(Math.abs(turf.area(clean) - turf.area(spiked)) < 0.01);
});

test("despike closes a tab straddling the seam", () => {
  // The ring's first and last vertices are one corner, and a tab can sit on it
  // like any other. Walking only the interior leaves this one in place.
  const spiked = turf.polygon([
    [
      [0, 50],
      [0.002, 50],
      [0.002, 50.002],
      [0, 50.002],
      [0, 50.0004],
      [0, 50.0012],
      [0, 50],
    ],
  ]);

  const clean = G.despike(spiked);

  assert.equal(
    clean.geometry.coordinates[0].length,
    6,
    "the vertex the ring reversed at is gone",
  );
  // Five would mean the square, and it is six because the far end of the tab
  // is left behind as a point in the middle of the western edge. That is
  // correct: it lies on the outline, encloses nothing either way, and removing
  // vertices that are merely redundant is a different job with a different
  // risk. What despike owes its callers is a ring jsts can buffer.
  assert.ok(Math.abs(turf.area(clean) - turf.area(spiked)) < 0.01);
});

test("despike keeps a spur that encloses ground", () => {
  // The rule is an area, not a shape. This spur is a meter wide — a driveway,
  // a passage between two buildings — and removing it would take ground off a
  // territory somebody has been sent to walk.
  const spur = withTab(
    [0.0002, 50],
    [0.0002, 50.0005],
    [0.0002 + 1 * M, 50.0005],
    [0.0002 + 1 * M, 50],
  );

  const clean = G.despike(spur);

  assert.equal(clean, spur, "nothing to remove, so nothing is rewritten");
});

test("despike returns a clean shape untouched", () => {
  // Identity, not equality: polygons.setClusters compares it to decide whether
  // to keep the geometry it was handed, and every territory on the map goes
  // through there on every write.
  const plain = square(turf, 0, 50, 0.001);
  assert.equal(G.despike(plain), plain);
});

test("unionHealed dissolves a seam it could not reach past a tab", () => {
  // What the removal is for, end to end. The two territories share an edge but
  // not its vertices, so dissolving them needs the buffer round trip. With the
  // tab in place jsts returns a ruin, unionHealed refuses it and falls back to
  // the plain union, and the merge comes back as two polygons that touch.
  const spiked = turf.polygon([
    [
      [0, 50],
      [0.0004, 50],
      [0.0002, 50],
      [0.001, 50],
      [0.001, 50.001],
      [0, 50.001],
      [0, 50],
    ],
  ]);
  const east = turf.polygon([
    [
      [0.0010000001, 50],
      [0.002, 50],
      [0.002, 50.001],
      [0.0010000001, 50.001],
      [0.0010000001, 50],
    ],
  ]);

  const merged = G.unionHealed([spiked, east]);

  assert.equal(
    G.polygonParts(merged).length,
    1,
    "the shared edge dissolved rather than leaving two pieces",
  );
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
