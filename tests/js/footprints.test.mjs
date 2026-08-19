/**
 * Boundaries drawn through buildings, and moving them onto the wall.
 *
 * The geometry is the behavior here, so this runs against the real vendored
 * turf rather than a stub: what is being asserted is that a footprint ends up
 * whole inside one territory and that the ground all of them cover together
 * did not change, and a stub could only say that union was called.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

// ── Fixtures ────────────────────────────────────────────────────────────────

// Degrees, so a unit is about 111 m: a 1×1 box is a believable territory and
// a 0.05×0.05 one is a believable house.
const U = 0.001;

/** A rectangle in units of U, as a turf Polygon. */
function box(west, south, east, north) {
  return turf.polygon([
    [
      [west * U, south * U],
      [east * U, south * U],
      [east * U, north * U],
      [west * U, north * U],
      [west * U, south * U],
    ],
  ]);
}

/**
 * @param {Object[]} buildings footprints as the download holds them, or null
 *   for "nothing has been downloaded"
 */
function setup(buildings = []) {
  const App = loadApp(["geometry.js", "footprints.js"], {
    window: {},
    document: {},
    turf,
  });
  App.state = {
    cachedBuildings: buildings
      ? { type: "FeatureCollection", features: buildings }
      : null,
  };
  App.footprints.init();
  return App.footprints;
}

/** The same, but keeping the App so the download itself can be inspected. */
function withApp(buildings) {
  const App = loadApp(["geometry.js", "footprints.js"], {
    window: {},
    document: {},
    turf,
  });
  App.state = {
    cachedBuildings: { type: "FeatureCollection", features: buildings },
  };
  App.footprints.init();
  return App;
}

const m2 = (feature) => Math.round(turf.area(feature));
const total = (features) => features.reduce((sum, f) => sum + turf.area(f), 0);

/** How much of `building` lies inside `feature`, in square meters. */
function held(feature, building) {
  const shared = turf.intersect(turf.featureCollection([feature, building]));
  return shared ? turf.area(shared) : 0;
}

function partCount(f) {
  return f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.length : 1;
}

// ── Finding them ────────────────────────────────────────────────────────────

test("a building split between two territories is a crossing", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  // Straddling the shared edge, three quarters of it in the east.
  const house = box(0.99, 0.4, 1.03, 0.44);
  const fp = setup([house]);

  const found = fp.crossings([west, east]);

  assert.equal(found.length, 1);
  assert.equal(found[0].owner, 1, "the side holding most of it owns it");
  assert.deepEqual(
    found[0].shares.map((share) => share.claim),
    [true, true],
    "and both sides are a party to it",
  );
});

test("a building wholly inside one territory is not", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(0.4, 0.4, 0.44, 0.44)]);

  assert.deepEqual(fp.crossings([west, east]), []);
});

test("a boundary that grazes a corner is not a crossing", () => {
  // Two centimeters of a 20 m² house. The union that built these territories
  // rounds by more than that, so treating it as a fault would mean repairing
  // the map on the strength of its own arithmetic noise.
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(0.9999, 0.4, 1.04, 0.44)]);

  assert.deepEqual(fp.crossings([west, east]), []);
});

test("a boundary running along a wall is not a crossing", () => {
  // The outcome this module exists to produce must not be read back as the
  // fault it repairs, or every run would find work to do.
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(1, 0.4, 1.04, 0.44)]);

  assert.deepEqual(fp.crossings([west, east]), []);
});

test("surveying leaves the download exactly as it can be saved", () => {
  // A record carries the feature it was derived from, so caching one *on*
  // that feature is a cycle — and data.js writes s.cachedBuildings straight
  // into the saved project, where a cycle is an exception on the way to disk
  // rather than a slow save.
  const App = withApp([box(0.99, 0.4, 1.03, 0.44)]);

  App.footprints.crossings([box(0, 0, 1, 1), box(1, 0, 2, 1)]);

  assert.doesNotThrow(() => JSON.stringify(App.state.cachedBuildings));
});

test("nothing downloaded is nothing to find", () => {
  const fp = setup(null);
  assert.deepEqual(fp.crossings([box(0, 0, 1, 1), box(1, 0, 2, 1)]), []);
});

// ── Moving the boundary onto the wall ───────────────────────────────────────

test("the footprint goes whole to the side that holds most of it", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const house = box(0.99, 0.4, 1.03, 0.44);
  const fp = setup([house]);

  const result = fp.detach([west, east]);

  assert.equal(result.resolved, 1);
  assert.equal(result.unresolved, 0);
  assert.deepEqual(result.changed.sort(), [0, 1]);

  const [w, e] = result.features;
  assert.ok(
    held(e, house) > turf.area(house) * 0.999,
    "the east holds all of it",
  );
  assert.ok(held(w, house) < 0.01, "and the west holds none of it");
  assert.ok(
    w.geometry && e.geometry && partCount(w) === 1 && partCount(e) === 1,
    "neither of them came back in two pieces",
  );
});

test("no ground is created or lost by the move", () => {
  // The failure this guards against is not a wrong owner but a missing
  // square meter: a difference that succeeds beside a union that quietly did
  // not is a hole in the coverage, found weeks later by whoever is standing
  // in it.
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(0.99, 0.4, 1.03, 0.44)]);

  const before = total([west, east]);
  const result = fp.detach([west, east]);

  assert.ok(
    Math.abs(total(result.features) - before) < 1,
    `${m2(result.features[0])} + ${m2(result.features[1])} against ${Math.round(before)}`,
  );
});

test("the boundary outside the footprint does not move", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(0.99, 0.4, 1.03, 0.44)]);

  const [w] = fp.detach([west, east]).features;

  // A point on the shared edge well away from the house is still the west's,
  // and one just past it is still not.
  assert.ok(turf.booleanPointInPolygon(turf.point([0.999 * U, 0.9 * U]), w));
  assert.ok(!turf.booleanPointInPolygon(turf.point([1.001 * U, 0.9 * U]), w));
});

test("the survey and the shapes handed in are left as they were", () => {
  // detach is what autoheal rehearses to decide whether to offer its wand, so
  // a run whose result is thrown away has to leave nothing behind.
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const before = JSON.stringify([west, east]);
  const input = [west, east];
  const fp = setup([box(0.99, 0.4, 1.03, 0.44)]);

  fp.detach(input);

  assert.equal(JSON.stringify([west, east]), before);
  assert.equal(input.length, 2);
  assert.equal(input[0], west, "and the array itself was not rewritten");
});

test("a territory the footprint would swallow keeps its ground and its flag", () => {
  // The repair is a boundary moved onto a wall, not a territory deleted. A
  // scrap lying entirely under one warehouse has nothing left to give.
  const main = box(0, 0, 1, 1);
  const scrap = box(1, 0.45, 1.1, 0.55);
  const warehouse = box(0.9, 0.4, 1.2, 0.7);
  const fp = setup([warehouse]);

  const found = fp.crossings([main, scrap]);
  assert.equal(found.length, 1, "the crossing is seen");
  assert.equal(found[0].owner, 0);

  const result = fp.detach([main, scrap]);
  assert.equal(result.resolved, 0);
  assert.equal(result.unresolved, 1);
  assert.deepEqual(result.changed, []);
  assert.equal(m2(result.features[1]), m2(scrap), "the scrap is untouched");
});

test("a neighbor overlapping the owner still gives the roof up", () => {
  // Found on the sample village. Territories are not always edge to edge:
  // autoheal closes a merge with a healed union, which leaves half a meter of
  // one territory lying inside the next, and that half meter was enough for
  // two of them to claim a slice of the same house. The owner gains no ground
  // by taking it — it already covers every bit of it — so a repair measured
  // by how much the owner grew refuses one that has in fact lost nothing.
  const owner = box(0, 0, 1, 1);
  const house = box(0.8, 0.4, 0.9, 0.5);
  const overlapping = box(0.88, 0.3, 1.6, 0.7);
  const fp = setup([house]);

  const found = fp.crossings([owner, overlapping]);
  assert.equal(found.length, 1);
  assert.equal(found[0].owner, 0);

  const result = fp.detach([owner, overlapping]);

  assert.equal(result.resolved, 1);
  assert.deepEqual(result.changed, [1], "only the side giving it up moves");
  assert.equal(held(result.features[1], house), 0, "and it holds none of it");
  assert.ok(held(result.features[0], house) > turf.area(house) * 0.999);
});

test("three territories meeting on one roof all give it up", () => {
  const west = box(0, 0, 1, 1);
  const northEast = box(1, 0.42, 2, 1);
  const southEast = box(1, 0, 2, 0.42);
  const house = box(0.98, 0.4, 1.06, 0.46);
  const fp = setup([house]);

  const found = fp.crossings([west, northEast, southEast]);
  assert.equal(found.length, 1);
  assert.equal(found[0].shares.length, 3);

  const result = fp.detach([west, northEast, southEast]);
  assert.equal(result.resolved, 1);

  const holders = result.features.filter(
    (f) => held(f, house) > turf.area(house) * 0.01,
  );
  assert.equal(holders.length, 1, "exactly one territory holds the house");
  assert.ok(held(holders[0], house) > turf.area(house) * 0.999);
});

// ── Scope ───────────────────────────────────────────────────────────────────

test("a scoped run repairs the crossings on its own outline", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const fp = setup([box(0.99, 0.4, 1.03, 0.44)]);

  // The wand on the western row moves the eastern boundary too, because it is
  // the same line: there is no taking it off the building for one side only.
  const result = fp.detach([west, east], { only: [0] });

  assert.equal(result.resolved, 1);
  assert.deepEqual(result.changed.sort(), [0, 1]);
});

test("a scoped run leaves a crossing it is not about", () => {
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const elsewhere = box(5, 0, 6, 1);
  const fp = setup([box(0.99, 0.4, 1.03, 0.44)]);

  const result = fp.detach([west, east, elsewhere], { only: [2] });

  assert.equal(result.resolved, 0);
  assert.equal(result.unresolved, 0);
  assert.deepEqual(result.changed, []);
});
