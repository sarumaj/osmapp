/**
 * balance.js — trading blocks until the territories even out.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The dialog offers two splits and this module is what makes them different
 * things rather than one algorithm under two labels. byBuildings() evens out
 * the houses; byArea() evens out the ground.
 *
 * Neither comes free from the phases before it. K-means converges on equal
 * area-weighted variance rather than equal counts, street routing then moves
 * every boundary by up to a block, and gap filling and the connectivity repair
 * move more ground again — so on a real town the partition can promise "about
 * 20 buildings each" and hand back territories of 4 and 434. balance.js is the
 * only pass that measures the finished territories at all, which makes it the
 * only thing standing between the dialog's promise and what gets printed on
 * the cards.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 * The fixture is built the way phase 5 builds its pieces — a noded line set
 * run through turf.polygonize — rather than by writing polygons out by hand.
 * That is deliberate: _pieceAdjacency matches faces on their shared edge
 * coordinates, which only works because polygonize reuses the coordinates it
 * was given. Hand-written squares would satisfy that by construction and the
 * test would pass on a version of turf that broke it.
 *
 * Adjacency is *not* asserted directly, because it is private. It is asserted
 * through its consequence: if the module found no neighbors, no trade is
 * possible and the spread cannot narrow. The connectivity invariant is checked
 * against grid arithmetic instead of against the module's own adjacency, so a
 * bug in the adjacency cannot hide a bug in the invariant it feeds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();
const App = loadApp(["util.js", "geometry.js", "spatial.js", "balance.js"], { turf });
App.balance.init();

const X0 = 13.0;
const Y0 = 52.5;
const STEP = 0.002; // ~135 m, about a city block
const SIDE = 6; // a SIDE x SIDE grid of blocks

/**
 * The blocks phase 5 would hand over: a grid polygonized from its own edges.
 *
 * The edges are emitted one cell-side at a time and deduplicated, which is
 * what nodeLineSegments() produces for a street grid — two full-length
 * crossing lines would meet without sharing a vertex and polygonize would
 * find no faces at all.
 */
function blockGrid() {
  const seen = new Set();
  const lines = [];
  const edge = (a, b) => {
    const key = [a, b].map((c) => c.map((n) => n.toFixed(5)).join(",")).sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(turf.lineString([a, b]));
  };
  const at = (i, j) => [
    Number((X0 + i * STEP).toFixed(5)),
    Number((Y0 + j * STEP).toFixed(5)),
  ];

  for (let i = 0; i < SIDE; i++) {
    for (let j = 0; j < SIDE; j++) {
      edge(at(i, j), at(i + 1, j));
      edge(at(i + 1, j), at(i + 1, j + 1));
      edge(at(i + 1, j + 1), at(i, j + 1));
      edge(at(i, j + 1), at(i, j));
    }
  }
  return turf.polygonize(turf.featureCollection(lines)).features;
}

/** Which grid cell a block is, read back off its geometry. */
function cellOf(piece) {
  const [x, y] = turf.centroid(piece).geometry.coordinates;
  // The centroid sits mid-cell, so rounding down the half-step lands on the
  // cell's own index rather than on the next one along.
  return [Math.round((x - X0) / STEP - 0.5), Math.round((y - Y0) / STEP - 0.5)];
}

/** `count` building centroids scattered inside cell (i, j). */
function buildingsIn(i, j, count) {
  const out = [];
  for (let n = 0; n < count; n++) {
    // Spread along the diagonal so no two land on the same coordinate, and
    // keep well clear of the edges so ownership is never a tie.
    const t = 0.2 + (0.6 * (n + 1)) / (count + 1);
    out.push(turf.point([X0 + (i + t) * STEP, Y0 + (j + t) * STEP]));
  }
  return out;
}

/** Territory index -> building count, from a finished owner assignment. */
function loads(pieces, owner, counts) {
  const out = new Map();
  pieces.forEach((_, i) => {
    if (owner[i] < 0) return;
    out.set(owner[i], (out.get(owner[i]) ?? 0) + counts[i]);
  });
  return out;
}

/**
 * The fixture: four quadrants, one of which holds twenty times its share.
 *
 * Quadrant 0 is a 3x3 corner with 20 buildings in every block and the other
 * three have one each, so the loads start at 180 / 9 / 9 / 9 against a target
 * of 51.75. That is the shape of the real failure — a dense core clustered
 * into the same number of territories as the outskirts around it.
 */
function fixture() {
  const pieces = blockGrid();
  const owner = [];
  const perPiece = [];
  const points = [];

  pieces.forEach((piece, index) => {
    const [i, j] = cellOf(piece);
    const quadrant = (i < SIDE / 2 ? 0 : 1) + (j < SIDE / 2 ? 0 : 2);
    const count = quadrant === 0 ? 20 : 1;
    owner[index] = quadrant;
    perPiece[index] = count;
    points.push(...buildingsIn(i, j, count));
  });

  return { pieces, owner, perPiece, points };
}

test("the fixture polygonizes into one face per block", () => {
  // Guards the test itself: every assertion below is vacuous if polygonize
  // returned nothing, and it returns nothing for a line set that is not noded.
  assert.equal(blockGrid().length, SIDE * SIDE);
});

test("a lopsided partition is evened out", () => {
  const { pieces, owner, points } = fixture();

  const report = App.balance.byBuildings(pieces, owner, points);
  assert.ok(report, "a partition with buildings and four territories is balanceable");

  assert.equal(report.target, 207 / 4);
  assert.deepEqual(report.before, { min: 9, max: 180 });

  // The interesting claim. Narrowing at all proves the module found the
  // shared edges between the blocks: with no adjacency there is no legal
  // trade and both ends of the spread would be untouched.
  assert.ok(
    report.after.max < report.before.max,
    `fullest territory should shrink, got ${report.after.max}`,
  );
  assert.ok(
    report.after.min > report.before.min,
    `emptiest territory should grow, got ${report.after.min}`,
  );
  assert.ok(
    report.after.max - report.after.min < report.before.max - report.before.min,
    "the spread should narrow",
  );
});

test("balancing conserves the buildings and the territories", () => {
  const { pieces, owner, perPiece, points } = fixture();
  const before = loads(pieces, owner, perPiece);

  App.balance.byBuildings(pieces, owner, points);
  const after = loads(pieces, owner, perPiece);

  assert.equal(
    [...after.values()].reduce((a, b) => a + b, 0),
    [...before.values()].reduce((a, b) => a + b, 0),
    "trading blocks moves buildings, it does not create or lose them",
  );
  assert.deepEqual(
    [...after.keys()].sort(),
    [...before.keys()].sort(),
    "no territory may be traded out of existence",
  );
});

test("no territory is left in two pieces", () => {
  const { pieces, owner, points } = fixture();
  App.balance.byBuildings(pieces, owner, points);

  // Adjacency from grid arithmetic rather than from the module's own edge
  // matching: checking the invariant with the machinery that enforces it
  // would pass however wrong that machinery is.
  const cells = pieces.map(cellOf);
  const key = ([i, j]) => `${i},${j}`;
  const byCell = new Map(cells.map((c, index) => [key(c), index]));

  const territories = new Map();
  owner.forEach((slot, index) => {
    if (slot < 0) return;
    if (!territories.has(slot)) territories.set(slot, new Set());
    territories.get(slot).add(index);
  });

  for (const [slot, members] of territories) {
    const start = members.values().next().value;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const [i, j] = cells[queue.pop()];
      for (const step of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = byCell.get(key([i + step[0], j + step[1]]));
        if (next === undefined || seen.has(next) || !members.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    assert.equal(
      seen.size,
      members.size,
      `territory ${slot} came apart into more than one piece`,
    );
  }
});

test("the same input balances the same way twice", () => {
  // The partition is reproducible by design — an undo and a re-run have to
  // land on the same map — and this pass must not be what breaks that.
  const first = fixture();
  const second = fixture();
  App.balance.byBuildings(first.pieces, first.owner, first.points);
  App.balance.byBuildings(second.pieces, second.owner, second.points);
  assert.deepEqual(first.owner, second.owner);
});

/**
 * The same grid, split into four territories of very unequal size.
 *
 * Three full columns against one each, so the loads start at 18 / 6 / 6 / 6
 * blocks against a target of 9. Every territory is a set of whole columns and
 * therefore already connected, which leaves the connectivity invariant free to
 * be what stops a trade rather than what the fixture starts out violating.
 */
function columns() {
  const pieces = blockGrid();
  const owner = pieces.map((piece) => {
    const [i] = cellOf(piece);
    return i < 3 ? 0 : i - 2;
  });
  return { pieces, owner };
}

test("splitting by area evens out the ground, with no buildings involved", () => {
  // The whole point of the mode: area mode is for boundaries where the
  // buildings are a poor guide to the walking, so it must not need them.
  const { pieces, owner } = columns();
  const areaOf = (index) =>
    pieces.reduce((sum, p, n) => (owner[n] === index ? sum + turf.area(p) : sum), 0);
  const beforeMax = Math.max(...[0, 1, 2, 3].map(areaOf));

  const report = App.balance.byArea(pieces, owner);
  assert.ok(report, "four territories of unequal size are balanceable");

  const after = [0, 1, 2, 3].map(areaOf);
  assert.ok(
    Math.max(...after) < beforeMax,
    `the largest territory should shrink, got ${Math.round(Math.max(...after))} m²`,
  );
  assert.ok(
    Math.max(...after) - Math.min(...after) < report.before.max - report.before.min,
    "the spread should narrow",
  );

  const total = pieces.reduce((sum, p) => sum + turf.area(p), 0);
  assert.ok(
    Math.abs(after.reduce((a, b) => a + b, 0) - total) < 1,
    "trading blocks moves ground, it does not create or lose it",
  );
});

test("splitting by area ignores where the buildings are", () => {
  // Two runs over identical geometry: one with the buildings piled into a
  // single block, one with none at all. Area mode must produce the same map,
  // or it is quietly still a building split.
  const a = columns();
  const b = columns();
  App.balance.byArea(a.pieces, a.owner);
  App.balance.byArea(b.pieces, b.owner, buildingsIn(0, 0, 500));
  assert.deepEqual(a.owner, b.owner);
});

test("counts() reports the buildings standing in each shape", () => {
  // Public because three places have to agree on it: the balance pass, the
  // spread the partition reports when it finishes, and the emptiness test that
  // decides whether a stranded orphan may be dropped. A shape holding a house
  // that this counts as empty is ground the partition throws away.
  const pieces = blockGrid();
  const points = [...buildingsIn(0, 0, 3), ...buildingsIn(2, 1, 5)];
  const counted = App.balance.counts(pieces, points);

  assert.equal(counted.length, pieces.length, "one count per shape, in order");
  assert.equal(
    counted.reduce((a, b) => a + b, 0),
    points.length,
    "every building lands in exactly one shape — none lost, none double-counted",
  );

  const at = (i, j) => counted[pieces.findIndex((p) => String(cellOf(p)) === String([i, j]))];
  assert.equal(at(0, 0), 3);
  assert.equal(at(2, 1), 5);
  assert.equal(at(4, 4), 0, "an empty block counts zero rather than going missing");
});

test("counts() survives being asked about nothing", () => {
  const pieces = blockGrid();
  assert.deepEqual(App.balance.counts([], buildingsIn(0, 0, 2)), []);
  assert.deepEqual(
    App.balance.counts(pieces.slice(0, 2), null),
    [0, 0],
    "no buildings downloaded is an answer, not a crash",
  );
});

test("nothing to balance is left alone", () => {
  const { pieces, owner } = fixture();
  const untouched = owner.slice();

  assert.equal(App.balance.byBuildings(pieces, owner, []), null);
  assert.equal(App.balance.byBuildings(pieces, owner, null), null);
  assert.deepEqual(owner, untouched, "a download with no buildings must not move blocks");

  const single = pieces.map(() => 7);
  assert.equal(
    App.balance.byBuildings(pieces, single, buildingsIn(0, 0, 3)),
    null,
    "one territory has nobody to trade with",
  );
});
