/**
 * Boundaries drawn through buildings, and moving them onto the wall.
 *
 * The geometry is the behavior here, so this runs against the real vendored
 * turf rather than a stub: what is being asserted is that a footprint ends up
 * whole inside one territory and that the ground all of them cover together
 * did not change, and a stub could only say that union was called.
 *
 * Two invariants recur, and every repair case checks at least one. A territory
 * may not come back in more pieces than it went in as, because that is the
 * fault autoheal exists to remove and producing it here would be a repair
 * creating work. And the areas must still add up, because a footprint handed
 * over by a difference the union then declined is ground belonging to nobody —
 * which shows up on the map as nothing at all, and on somebody's round as a
 * street they were never sent to.
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

/** One feature holding several disconnected rectangles. */
function pieces(...boxes) {
  return {
    type: "Feature",
    geometry: {
      type: "MultiPolygon",
      coordinates: boxes.map((b) => b.geometry.coordinates),
    },
    properties: {},
  };
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

test("a territory with a courtyard in it is still surveyed", () => {
  // Clipping a territory to the footprint's bounding box before measuring is
  // a shortcut, and this is the shape it is wrong for: bboxClip works one
  // ring at a time, so a courtyard clipped away from the outline it belongs
  // to stops being a hole and the territory appears to hold ground it does
  // not. The shortcut has to stand aside here, and the crossing still be
  // found.
  const west = turf.polygon([
    [
      [0, 0], [1 * U, 0], [1 * U, 1 * U], [0, 1 * U], [0, 0],
    ],
    [
      [0.2 * U, 0.2 * U], [0.2 * U, 0.5 * U],
      [0.5 * U, 0.5 * U], [0.5 * U, 0.2 * U], [0.2 * U, 0.2 * U],
    ],
  ]);
  const east = box(1, 0, 2, 1);
  const house = box(0.99, 0.4, 1.03, 0.44);
  const fp = setup([house]);

  const found = fp.crossings([west, east]);

  assert.equal(found.length, 1);
  assert.equal(found[0].owner, 1);
});

test("a territory in several pieces is surveyed as one territory", () => {
  const west = pieces(box(0, 0, 1, 0.45), box(0, 0.55, 1, 1));
  const east = box(1, 0, 2, 1);
  const house = box(0.99, 0.6, 1.03, 0.64);
  const fp = setup([house]);

  const found = fp.crossings([west, east]);

  assert.equal(found.length, 1);
  assert.deepEqual(
    found[0].shares.map((share) => share.index).sort(),
    [0, 1],
  );
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

test("a footprint that would swallow a territory is given to that territory", () => {
  // Majority is a preference, not a rule. The larger holder cannot take this
  // warehouse: the scrap beside it lies entirely underneath, and handing the
  // footprint over would not move a boundary, it would delete a territory. So
  // the scrap takes it instead — the outcome the largest holder could not
  // produce, and a better one than leaving the line through the warehouse.
  const main = box(0, 0, 1, 1);
  const scrap = box(1, 0.45, 1.1, 0.55);
  const warehouse = box(0.9, 0.4, 1.2, 0.7);
  const fp = setup([warehouse]);

  const found = fp.crossings([main, scrap]);
  assert.equal(found.length, 1, "the crossing is seen");
  assert.equal(found[0].owner, 0, "and the larger holder is the first choice");

  const result = fp.detach([main, scrap]);

  assert.equal(result.resolved, 1);
  assert.equal(result.unresolved, 0);
  assert.ok(
    m2(result.features[1]) > m2(scrap),
    "the scrap is the one that grew",
  );
  assert.ok(m2(result.features[0]) < m2(main), "and the main territory gave");
  assert.ok(
    result.features.every((f) => partCount(f) === 1),
    "neither of them was broken doing it",
  );
});

test("a footprint no side can give up keeps its flag", () => {
  // What is left when every way round has been tried. Two territories lie
  // entirely under the same warehouse, so whichever of the three is given it,
  // one of the others is deleted rather than trimmed — and deleting a
  // territory is not a repair whichever way it is arranged.
  const main = box(0, 0, 1, 1);
  const scrapA = box(1, 0.45, 1.06, 0.5);
  const scrapB = box(1, 0.55, 1.06, 0.6);
  const warehouse = box(0.9, 0.4, 1.2, 0.7);
  const fp = setup([warehouse]);

  assert.equal(fp.crossings([main, scrapA, scrapB]).length, 1);

  const result = fp.detach([main, scrapA, scrapB]);

  assert.equal(result.resolved, 0);
  assert.equal(result.unresolved, 1);
  assert.deepEqual(result.changed, []);
  assert.equal(m2(result.features[1]), m2(scrapA), "and nothing was touched");
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

// ── What the difference shaves off ──────────────────────────────────────────

/**
 * A territory east of the line x = 1, with a lobe poking west of it.
 *
 * Subtracting a footprint that covers where the lobe joins the body leaves
 * two polygons: the body, and whatever of the lobe the footprint did not
 * reach. How big that leftover is decides whether it is a fleck to be swept
 * up or a place somebody could stand — which is the whole of what _sweep
 * exists to tell apart.
 *
 * Wound counter-clockwise from the south-west corner, going out around the
 * lobe on the way back down, so the ring does not cross itself.
 *
 * @param {number} west how far the lobe reaches, in units of U
 */
function lobed(west) {
  return turf.polygon([
    [
      [1 * U, 0],
      [2 * U, 0],
      [2 * U, 1 * U],
      [1 * U, 1 * U],
      [1 * U, 0.7 * U],
      [west * U, 0.7 * U],
      [west * U, 0.6 * U],
      [1 * U, 0.6 * U],
      [1 * U, 0],
    ],
  ]);
}

/** The western square, less whatever the lobe takes out of it. */
function westOf(donor) {
  return turf.difference(turf.featureCollection([box(0, 0, 1, 1), donor]));
}

// Tall enough to sever the lobe from the body, and far enough west that most
// of it is the western territory's — so the lobed one is the side handing the
// footprint over, which is the side a difference can break.
const SEVERING = box(0.95, 0.25, 1.005, 0.85);

test("a speck left beside the footprint does not cost the repair", () => {
  // On a straight-cut partition of a real project export, fourteen of a
  // hundred and eighty-one repairs were refused because the difference left a
  // fleck: the boundary and a wall crossed at a hair's angle, and the wedge
  // between them survived as a polygon of its own — the largest 1.31 m², the
  // smallest 0.018 m². Refusing there is wrong twice over: the boundary stays
  // in the building, and the row goes on offering a repair that declines
  // itself.
  //
  // Here the fleck is the two and a half square meters of lobe sticking out
  // past the footprint, stranded because the footprint covers everything
  // joining it to the rest of its territory.
  const donor = lobed(0.948);
  const owner = westOf(donor);
  const fp = setup([SEVERING]);

  assert.equal(
    fp.crossings([owner, donor]).length,
    1,
    "the line cuts the footprint",
  );

  const result = fp.detach([owner, donor]);

  assert.equal(result.unresolved, 0, "a fleck is not a reason to refuse");
  assert.equal(result.resolved, 1);
  assert.equal(
    partCount(result.features[1]),
    1,
    "and the donor is left in one piece rather than one piece plus a fleck",
  );
  // Swept up, not swept away: the fleck went over with the footprint.
  const before = turf.area(owner) + turf.area(donor);
  const after = result.features.reduce((sum, f) => sum + turf.area(f), 0);
  assert.ok(Math.abs(after - before) < 0.5, `${after} against ${before}`);
});

test("a lobe the footprint would sever goes over with it", () => {
  // The other side of the same rule, and the reason it is a size and not a
  // count. This lobe keeps about sixty square meters past the footprint —
  // somewhere a person could stand — so it is not swept up as arithmetic. It
  // is moved on purpose, and only once the way round has been tried: the
  // repair first offers the footprint to the other side, and comes to this
  // when that does not work either.
  //
  // Moved, not lost. A piece the footprint cuts off cannot be reached from
  // the rest of its own territory any more, and the only territory it can be
  // reached from is the one taking the footprint. Leaving it where it is
  // makes the split territory autoheal exists to remove.
  const donor = lobed(0.9);
  const owner = westOf(donor);
  const fp = setup([SEVERING]);

  assert.equal(fp.crossings([owner, donor]).length, 1);

  const before = turf.area(owner) + turf.area(donor);
  const result = fp.detach([owner, donor]);

  assert.equal(result.unresolved, 0);
  assert.equal(result.resolved, 1);
  assert.ok(
    result.features.every((f) => partCount(f) === 1),
    "and both territories are still in one piece",
  );
  const after = result.features.reduce((sum, f) => sum + turf.area(f), 0);
  assert.ok(Math.abs(after - before) < 1, `${after} against ${before}`);
  // The lobe went to the side that took the footprint, not to nobody.
  const lobeSpot = turf.point([0.92 * U, 0.65 * U]);
  assert.equal(
    result.features.filter((f) => turf.booleanPointInPolygon(lobeSpot, f))
      .length,
    1,
    "the lobe belongs to exactly one territory",
  );
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
