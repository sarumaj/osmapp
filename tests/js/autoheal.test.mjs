/**
 * Repairing the faults the territory list can name.
 *
 *   • A territory drawn in separate pieces becomes one territory per piece.
 *   • A territory with no buildings is absorbed by the neighbor it shares the
 *     most boundary with.
 *   • Ground in no territory at all becomes a territory first, and is then
 *     judged by the two rules above like anything else.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

// ── Fixtures ────────────────────────────────────────────────────────────────

// Degrees, so that a unit is about 111 m and a 1×1 box is a believable
// territory rather than a continent or a doormat.
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

/** A building footprint, small enough that only its position matters. */
function building(x, y) {
  return box(x - 0.02, y - 0.02, x + 0.02, y + 0.02);
}

function feature(shape, properties = {}) {
  return {
    type: "Feature",
    geometry: shape.geometry,
    properties,
  };
}

/**
 * @param {Array<{shape: Object, buildings?: number|null, properties?: Object}>}
 *   territories in list order. `buildings` is the count polygons.js would have
 *   written onto the entry; null or omitted means it never got that far.
 * @param {Object[]} [footprints] what the download holds, or null for "nothing
 *   has been downloaded".
 * @param {Object[]} [uncovered] the shapes gaps.js is holding, in its own
 *   order — largest first. Omitted means the map is fully covered.
 */
function setup(territories, footprints = [], uncovered = []) {
  const App = loadApp(["geometry.js", "autoheal.js"], {
    window: {},
    document: {},
    turf,
  });

  let emitted = null;
  let pushes = 0;

  App.state = {
    clusters: territories.map((t) => ({
      feature: feature(t.shape, t.properties || {}),
      counts:
        t.buildings === null || t.buildings === undefined
          ? undefined
          : { buildings: t.buildings, streets: 0 },
    })),
    cachedBuildings: footprints
      ? { type: "FeatureCollection", features: footprints }
      : null,
  };
  App.history = { push: () => pushes++ };
  App.gaps = { features: () => uncovered.map((shape) => feature(shape)) };
  App.polygons = {
    setClusters: (next) => {
      emitted = next;
    },
  };

  App.autoheal.init();
  return {
    App,
    heal: App.autoheal.heal,
    healGaps: App.autoheal.healGaps,
    audit: App.autoheal.audit,
    isEmpty: App.autoheal.isEmpty,
    issueOf: App.autoheal.issueOf,
    emitted: () => emitted,
    pushes: () => pushes,
  };
}

/** Areas of what was emitted, largest first, in whole square meters. */
function areas(features) {
  return features.map((f) => Math.round(turf.area(f))).sort((a, b) => b - a);
}

function partCount(f) {
  return f.geometry.type === "MultiPolygon" ? f.geometry.coordinates.length : 1;
}

// ── Splitting ───────────────────────────────────────────────────────────────

test("a territory drawn in two pieces becomes two territories", () => {
  const h = setup([{ shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)) }], null);

  const report = h.heal();

  assert.equal(report.split, 1);
  assert.equal(report.pieces, 2);
  assert.equal(report.after, 2);
  assert.equal(h.emitted().length, 2);
  assert.ok(
    h.emitted().every((f) => partCount(f) === 1),
    "and neither of them is still a MultiPolygon",
  );
});

test("a territory in one piece is left exactly as it was", () => {
  const only = box(0, 0, 1, 1);
  const h = setup([{ shape: only, buildings: 4 }], [building(0.5, 0.5)]);

  const report = h.heal();

  assert.equal(report.changed, false);
  assert.equal(h.emitted(), null, "nothing is written back");
  assert.equal(h.pushes(), 0, "and no history entry is spent on a no-op");
});

test("splitting keeps every piece — nothing is dropped for being small", () => {
  // The sliver is a scrap by any measure, and the temptation is a size floor.
  // With no buildings downloaded there is nowhere to put it, and dropping it
  // would silently un-cover ground that was covered a moment ago.
  const h = setup(
    [{ shape: pieces(box(0, 0, 1, 1), box(3, 0, 3.02, 0.02)) }],
    null,
  );

  h.heal();

  assert.equal(h.emitted().length, 2);
  const total = h.emitted().reduce((sum, f) => sum + turf.area(f), 0);
  assert.ok(
    total > turf.area(box(0, 0, 1, 1)) * 0.99,
    "the ground is all there",
  );
});

// ── Merging the empty ones away ─────────────────────────────────────────────

test("an empty territory goes to the neighbor it shares the most edge with", () => {
  // West is 1 unit of shared boundary, east is half of one. Ranking by
  // centroid distance would pick east — its middle is nearer the strip's.
  const west = box(0, 0, 1, 1);
  const east = box(1, 0, 2, 1);
  const strip = box(0, 1, 1.5, 1.2);

  const h = setup(
    [
      { shape: west, buildings: 12 },
      { shape: east, buildings: 9 },
      { shape: strip, buildings: 0 },
    ],
    [building(0.5, 0.5), building(1.5, 0.5)],
  );

  const report = h.heal();

  assert.equal(report.merged, 1);
  assert.equal(report.after, 2);

  const emitted = h.emitted();
  assert.equal(emitted.length, 2);
  // The strip's ground is inside the western territory now, and the eastern
  // one is untouched.
  const holdsStrip = emitted.filter((f) =>
    turf.booleanPointInPolygon(turf.point([0.5 * U, 1.1 * U]), f),
  );
  assert.equal(holdsStrip.length, 1, "the strip belongs to exactly one");
  assert.ok(
    turf.area(holdsStrip[0]) > turf.area(east) * 1.1,
    "and it is the one that grew",
  );
  assert.ok(
    holdsStrip.every((f) => partCount(f) === 1),
    "the merge dissolved the shared edge instead of leaving two pieces",
  );

  // Not a formality. turf's clipping throws on the buffered corners of two
  // rectangles meeting along an edge — this very shape — and geometry.unionAll
  // answers a throw by returning a *partial* union. Taken at face value that
  // is the strip silently ceasing to exist, its ground belonging to nobody,
  // found as a hole in the coverage weeks later.
  const before = turf.area(west) + turf.area(east) + turf.area(strip);
  const after = emitted.reduce((sum, f) => sum + turf.area(f), 0);
  assert.ok(after > before * 0.99, `no ground vanished: ${after} of ${before}`);
});

test("an empty territory with no populated neighbor is left alone", () => {
  // Two empties side by side and a populated territory nowhere near. Merging
  // them into each other would produce one empty territory instead of two and
  // call it a repair.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 0 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
      { shape: box(9, 9, 10, 10), buildings: 5 },
    ],
    [building(9.5, 9.5)],
  );

  const report = h.heal();

  assert.equal(report.merged, 0);
  assert.equal(report.unresolved, 2);
  assert.equal(report.changed, false);
  assert.equal(h.emitted(), null);
});

test("a chain of empties unwinds one link per pass", () => {
  // far touches near, near touches the populated one. On the first pass only
  // `near` has a legal host; the merge gives it buildings, which makes it a
  // host for `far` on the second.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 7 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
      { shape: box(2, 0, 3, 1), buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );

  const report = h.heal();

  assert.equal(report.merged, 2);
  assert.equal(report.unresolved, 0);
  assert.equal(h.emitted().length, 1);
  assert.equal(partCount(h.emitted()[0]), 1);
});

test("a partition with no buildings anywhere is not collapsed into one", () => {
  // The download holds a building, so "empty" is answerable — it just happens
  // to sit outside every territory. Nothing here has a legal host.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 0 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
      { shape: box(2, 0, 3, 1), buildings: 0 },
    ],
    [building(50, 50)],
  );

  const report = h.heal();

  assert.equal(report.merged, 0);
  assert.equal(report.after, 3);
});

test("nothing downloaded is not the same as no buildings", () => {
  // The counts are missing because refreshFilteredData never ran. Reading that
  // as "empty" merges away a perfectly good territory.
  const h = setup(
    [{ shape: box(0, 0, 1, 1) }, { shape: box(1, 0, 2, 1) }],
    null,
  );

  const report = h.heal();

  assert.equal(report.merged, 0);
  assert.equal(report.after, 2);
  assert.equal(h.isEmpty(h.App.state.clusters[0]), null, "and it says so");
});

// ── The two repairs together ────────────────────────────────────────────────

test("a piece stranded on a neighbor is split off and handed over", () => {
  // The case the feature exists for. One territory is a populated block plus a
  // scrap sitting against a different territory entirely; the scrap has no
  // buildings. Split first, then merge: the scrap is judged on its own and
  // ends up where it actually touches.
  const main = box(0, 0, 1, 1);
  const scrap = box(2, 0, 2.2, 1);
  const other = box(2.2, 0, 3.2, 1);

  const h = setup(
    [
      { shape: pieces(main, scrap), buildings: 20 },
      { shape: other, buildings: 15 },
    ],
    [building(0.5, 0.5), building(2.7, 0.5)],
  );

  const report = h.heal();

  assert.equal(report.split, 1);
  assert.equal(report.merged, 1);
  assert.equal(report.after, 2);

  const emitted = h.emitted();
  const holdsScrap = emitted.filter((f) =>
    turf.booleanPointInPolygon(turf.point([2.1 * U, 0.5 * U]), f),
  );
  assert.equal(holdsScrap.length, 1);
  assert.ok(
    turf.booleanPointInPolygon(turf.point([2.7 * U, 0.5 * U]), holdsScrap[0]),
    "the scrap joined the territory it touches, not the one it came from",
  );
  assert.ok(
    emitted.every((f) => partCount(f) === 1),
    "and nothing is left in pieces",
  );
});

// ── Ground in no territory ──────────────────────────────────────────────────

test("an uncovered patch with houses on it becomes a territory of its own", () => {
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 4 }],
    [building(0.5, 0.5), building(2.5, 0.5)],
    [box(2, 0, 3, 1)],
  );

  const report = h.heal();

  assert.equal(report.adopted, 1);
  assert.equal(report.merged, 0, "it earns its own card");
  assert.equal(report.after, 2);
  assert.ok(
    h
      .emitted()
      .some((f) =>
        turf.booleanPointInPolygon(turf.point([2.5 * U, 0.5 * U]), f),
      ),
    "and the ground under the houses is now covered",
  );
});

test("an uncovered strip with nothing on it goes to the neighbor it abuts", () => {
  // The point of adopting first. The strip left by dragging a boundary
  // outward is not worth a card; making it a territory is what lets the merge
  // pass see that and hand it to the territory beside it — which is the
  // repair a person would make by hand.
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 9 }],
    [building(0.5, 0.5)],
    [box(0, 1, 1, 1.2)],
  );

  const report = h.heal();

  assert.equal(report.adopted, 1);
  assert.equal(report.merged, 1);
  assert.equal(report.after, 1, "no empty card was left behind");
  assert.equal(partCount(h.emitted()[0]), 1, "and the seam was dissolved");
  assert.ok(
    turf.booleanPointInPolygon(turf.point([0.5 * U, 1.1 * U]), h.emitted()[0]),
    "the strip's ground came with it",
  );
});

test("an uncovered piece lying in two places becomes two territories", () => {
  // Adopted before the split pass rather than after, so the fault the module
  // exists to remove is not one it creates on the way past.
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 4 }],
    [building(0.5, 0.5), building(3.5, 0.5), building(6.5, 0.5)],
    [pieces(box(3, 0, 4, 1), box(6, 0, 7, 1))],
  );

  const report = h.heal();

  assert.equal(report.adopted, 1);
  assert.equal(report.split, 1);
  assert.equal(report.after, 3);
  assert.ok(h.emitted().every((f) => partCount(f) === 1));
});

test("healing one territory leaves the uncovered ground where it is", () => {
  // The wand on a row is about that row. A run that quietly adopted every gap
  // on the map would be a different button than the one that was clicked.
  const h = setup(
    [{ shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)) }],
    null,
    [box(6, 0, 7, 1)],
  );

  const report = h.heal(0);

  assert.equal(report.adopted, 0);
  assert.equal(report.split, 1);
  assert.equal(h.emitted().length, 2);
});

test("healGaps takes in the one piece it was pointed at", () => {
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 4 }],
    [building(0.5, 0.5), building(3.5, 0.5), building(6.5, 0.5)],
    [box(3, 0, 4, 1), box(6, 0, 7, 1)],
  );

  const report = h.healGaps(1);

  assert.equal(report.adopted, 1);
  assert.equal(report.after, 2);
  assert.ok(
    h
      .emitted()
      .some((f) =>
        turf.booleanPointInPolygon(turf.point([6.5 * U, 0.5 * U]), f),
      ),
    "the second one, which is the one that was asked for",
  );
});

test("an index no longer in the list is dropped rather than thrown", () => {
  // The recount lands two hundred milliseconds after whatever changed the
  // coverage, so a row can outlive the piece of ground it names. The answer
  // is a repair that did nothing, not a crash and not a territory built from
  // whatever happens to be at that index now.
  const h = setup([{ shape: box(0, 0, 1, 1), buildings: 4 }], [], []);

  const report = h.healGaps(3);

  assert.equal(report.adopted, 0);
  assert.equal(report.changed, false);
  assert.equal(h.emitted(), null);
  assert.equal(h.pushes(), 0);
});

test("the audit says how much ground belongs to nobody", () => {
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 4 }],
    [building(0.5, 0.5)],
    [box(3, 0, 4, 1), box(6, 0, 7, 1)],
  );

  const audit = h.audit();

  assert.equal(audit.uncovered, 2);
  assert.equal(audit.fixable, 0, "which is a fault of no territory in it");
});

// ── Scope ───────────────────────────────────────────────────────────────────

test("healing one row leaves the other faults alone", () => {
  const h = setup(
    [
      { shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)) },
      { shape: pieces(box(6, 0, 7, 1), box(9, 0, 10, 1)) },
    ],
    null,
  );

  const report = h.heal(0);

  assert.equal(report.split, 1);
  assert.equal(h.emitted().length, 3);
  assert.equal(
    h.emitted().filter((f) => partCount(f) === 2).length,
    1,
    "the row that was not asked about is still in two pieces",
  );
});

// ── The printed mark ────────────────────────────────────────────────────────

test("a shape the heal changed loses its printed mark", () => {
  const stamp = "2024-05-01T10:00:00.000Z";
  const h = setup(
    [
      {
        shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)),
        properties: { printed: stamp, keepme: true },
      },
    ],
    null,
  );

  h.heal();

  assert.ok(
    h.emitted().every((f) => !f.properties.printed),
    "the card in somebody's hand is a picture of an outline that has moved",
  );
  assert.ok(
    h.emitted().every((f) => f.properties.keepme === true),
    "everything else about the territory survives",
  );
});

test("a territory the heal did not touch keeps its printed mark", () => {
  const stamp = "2024-05-01T10:00:00.000Z";
  const h = setup(
    [
      { shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)) },
      { shape: box(9, 9, 10, 10), properties: { printed: stamp } },
    ],
    null,
  );

  h.heal();

  const printed = h.emitted().filter((f) => f.properties.printed === stamp);
  assert.equal(printed.length, 1);
});

// ── One undo ────────────────────────────────────────────────────────────────

test("a whole heal is one history entry", () => {
  const h = setup(
    [
      { shape: pieces(box(0, 0, 1, 1), box(3, 0, 4, 1)), buildings: 3 },
      { shape: box(4, 0, 5, 1), buildings: 0 },
      { shape: box(5, 0, 6, 1), buildings: 8 },
    ],
    [building(0.5, 0.5), building(5.5, 0.5)],
  );

  h.heal();

  assert.equal(h.pushes(), 1);
});

// ── What the list asks it ───────────────────────────────────────────────────

test("the audit names the fault and whether it can be fixed", () => {
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 4 },
      { shape: pieces(box(3, 0, 4, 1), box(6, 0, 7, 1)), buildings: 2 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
      { shape: box(20, 20, 21, 21), buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );

  const audit = h.audit();

  assert.equal(audit.split, 1);
  assert.equal(audit.empty, 2);
  assert.deepEqual(
    audit.rows.map((r) => r.fixable),
    [false, true, true, false],
    "the split one and the empty one beside a populated neighbor",
  );
  assert.equal(audit.fixable, 2);
});

test("an empty territory with nowhere to go is flagged but not offered", () => {
  // The flag is the honest outcome. A button that runs and changes nothing
  // teaches people to distrust the one that works.
  const h = setup(
    [{ shape: box(0, 0, 1, 1), buildings: 0 }],
    [building(50, 50)],
  );

  const issue = h.issueOf(0);

  assert.equal(issue.empty, true);
  assert.equal(issue.fixable, false);
});

// ── The offer and the repair are one thing ──────────────────────────────────

test("a wand is offered exactly when the repair would change something", () => {
  // The invariant the whole `fixable` flag exists to hold. Predicting it —
  // "does a populated neighbor touch me?" — answers a different question from
  // "can that neighbor take me?", and the gap between the two is a row offering
  // a button that runs and changes nothing.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 6 },
      { shape: pieces(box(3, 0, 4, 1), box(6, 0, 7, 1)), buildings: 2 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
      { shape: box(20, 20, 21, 21), buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );

  for (const issue of h.audit().rows) {
    const report = h.heal(issue.index);
    assert.equal(
      issue.fixable,
      report.changed,
      `territory ${issue.index}: offered ${issue.fixable}, did ${report.changed}`,
    );
  }
});

test("an empty territory whose neighbor cannot take it is not offered", () => {
  // Whether two outlines can be unioned into one usable polygon is a question
  // about arithmetic, not about geography, and the answer is not knowable
  // without trying. Here every union is refused, so the touching populated
  // neighbor is no help and the row must not claim otherwise.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 9 },
      { shape: box(1, 0, 2, 1), buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );
  h.App.geometry.union = () => null;
  h.App.geometry.unionHealed = () => null;

  assert.equal(h.issueOf(1).empty, true, "still flagged, because it still is");
  assert.equal(h.issueOf(1).fixable, false);
  assert.equal(h.heal(1).changed, false, "and the two agree");
});

test("a neighbor that cannot take it hands the job to the next one", () => {
  // west shares the most boundary and so is asked first. When that union comes
  // back unusable the strip is not stranded: east is still a neighbor, and a
  // second-best home beats no home at all.
  const west = box(0, 0, 1, 1);
  // Deliberately not the same size as west, so the stub below can tell the two
  // apart by area — which is the one handle that survives _absorb quantizing
  // its inputs into fresh objects on the way to its last attempt.
  const east = box(1, 0, 2.4, 1);
  const strip = box(0, 1, 1.5, 1.2);

  const h = setup(
    [
      { shape: west, buildings: 12 },
      { shape: east, buildings: 9 },
      { shape: strip, buildings: 0 },
    ],
    [building(0.5, 0.5), building(1.5, 0.5)],
  );

  const realUnion = h.App.geometry.union;
  const realHealed = h.App.geometry.unionHealed;
  const isWest = (f) => Math.abs(turf.area(f) - turf.area(west)) < 1;
  h.App.geometry.union = (a, b) => (isWest(a) ? null : realUnion(a, b));
  h.App.geometry.unionHealed = (fs, eps) =>
    isWest(fs[0]) ? null : realHealed(fs, eps);

  const report = h.heal();

  assert.equal(report.merged, 1);
  assert.equal(report.after, 2);
  const holdsStrip = h
    .emitted()
    .filter((f) =>
      turf.booleanPointInPolygon(turf.point([0.5 * U, 1.1 * U]), f),
    );
  assert.equal(holdsStrip.length, 1);
  assert.ok(
    turf.booleanPointInPolygon(turf.point([1.5 * U, 0.5 * U]), holdsStrip[0]),
    "the runner-up took it",
  );
});

test("a sliver lying inside its neighbor is absorbed, not refused", () => {
  // Straight from a real partition: territory 36, thirty square metres, no
  // buildings, and 87% of it already inside territory 37. The union is perfect
  // and loses nothing, yet it does not make the host thirty metres bigger,
  // because twenty-six of those metres are already the host's. An
  // acceptance test written as "host plus nine tenths of the victim" assumes
  // neighbors never overlap, and territories overlap all the time: a merge
  // that keeps unionHealed's grown result leaves half a metre along the seam,
  // and a hand-drawn territory can sit on another one outright.
  const host = box(0, 0, 1, 1);
  const sliver = box(0.9, 0.4, 1.02, 0.5); // mostly inside `host`

  const overlap = turf.area(
    turf.intersect(turf.featureCollection([host, sliver])),
  );
  assert.ok(
    overlap > turf.area(sliver) * 0.8,
    "the fixture has to be mostly-inside for this to be the case under test",
  );

  const h = setup(
    [
      { shape: host, buildings: 40 },
      { shape: sliver, buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );

  assert.equal(h.issueOf(1).fixable, true, "the row must offer the repair");

  const report = h.heal();
  assert.equal(report.merged, 1);
  assert.equal(report.after, 1);
  assert.ok(
    turf.booleanPointInPolygon(
      turf.point([1.01 * U, 0.45 * U]),
      h.emitted()[0],
    ),
    "and the part of it that was outside is now inside the host",
  );
});

test("a union that really did drop the victim is still refused", () => {
  // The guard the case above relaxes. With no overlap at all the expected gain
  // is the whole victim, so a candidate that comes back as the host alone —
  // which is what geometry.unionAll returns when clipping throws — is caught.
  const host = box(0, 0, 1, 1);
  const strip = box(0, 1, 1, 1.3);

  const h = setup(
    [
      { shape: host, buildings: 40 },
      { shape: strip, buildings: 0 },
    ],
    [building(0.5, 0.5)],
  );
  const onlyTheHost = () => h.App.state.clusters[0].feature;
  h.App.geometry.unionHealed = onlyTheHost;
  h.App.geometry.union = onlyTheHost;

  assert.equal(h.issueOf(1).fixable, false);
  assert.equal(h.heal().changed, false, "the strip keeps its ground");
});

test("the repair believes the count the row is showing", () => {
  // refreshFilteredData gives a building on a shared boundary to the first
  // territory that claims it; counting each territory on its own gives it to
  // both. The flag is drawn from the first number, so the repair has to work
  // from the same one — otherwise the row says "empty", the run says
  // "populated", and the wand does nothing.
  const h = setup(
    [
      { shape: box(0, 0, 1, 1), buildings: 4 },
      // Says zero, yet a building footprint falls inside it.
      { shape: box(1, 0, 2, 1), buildings: 0 },
    ],
    [building(0.5, 0.5), building(1.5, 0.5)],
  );

  const report = h.heal();

  assert.equal(
    report.merged,
    1,
    "the row said empty, so it was treated as empty",
  );
  assert.equal(report.after, 1);
});

test("issueOf on a territory that is not there says so", () => {
  const h = setup([{ shape: box(0, 0, 1, 1), buildings: 1 }], []);
  assert.equal(h.issueOf(7), null);
});
