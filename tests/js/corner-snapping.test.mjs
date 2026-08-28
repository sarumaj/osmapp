/**
 * Pulling the cell corners onto the street network, and what it rests on.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * Phase 4 routes each Voronoi cell edge along the streets, but a Voronoi
 * vertex falls wherever three cells happen to meet, which is generally the
 * middle of a block. Routing from the vertex meant emitting the straight line
 * from it to the first street node as part of the boundary — so a territory
 * edge ran along a road and then cut between two houses to reach a corner in
 * somebody's garden. On a 100 m street grid that was 16 m at each end of every
 * edge; on the sparser fixture below it is most of the off-street length.
 *
 * Phase 4 now moves the corner onto the network first, within a cap, and
 * routes between corners that are already street nodes.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 * The anchoring lives inside _phase4 and is not reachable from here, so what
 * these tests pin is what it rests on: the two properties of App.spatial.Grid
 * it would silently stop being correct without, and the size of the win, over
 * a reference anchoring run against the real Grid.
 *
 * The consistency property is the one that would fail loudly and confusingly.
 * Three cells meet at a corner and each contributes its own copy of it. If
 * they do not all agree on where that corner went, their rings stop closing,
 * turf.polygonize returns fewer faces than there are territories, and the
 * partition comes out with holes in it — a failure that looks nothing like
 * its cause.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();
const App = loadApp(["util.js", "geometry.js", "spatial.js"], { turf });
const SP = App.spatial;

const X0 = 13.0;
const Y0 = 52.5;
const M_PER_DEG_LAT = 111320;
const KX = Math.cos((Y0 * Math.PI) / 180);
const lng = (metres) => metres / (M_PER_DEG_LAT * KX);
const lat = (metres) => metres / M_PER_DEG_LAT;

const SNAP_CAP_M = 60; // VERTEX_SNAP_MAX_M in clustering.js
const PRECISION = 5; // coordKey in _phase4

function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * A street network with gaps in it: 150 m blocks, a fifth of the links
 * missing, shape points every 40 m. Sparse on purpose — on a perfect grid
 * every corner is within the cap and the cap is never tested.
 */
function streets(span = 2000) {
  const r = rng(5);
  const grid = new SP.Grid(150);
  let count = 0;
  for (let i = 0; i * 150 <= span; i++) {
    for (let t = 0; t * 40 <= span; t++) {
      if (r() > 0.2) grid.addPoint([X0 + lng(i * 150), Y0 + lat(t * 40)], count++);
      if (r() > 0.2) grid.addPoint([X0 + lng(t * 40), Y0 + lat(i * 150)], count++);
    }
  }
  return grid;
}

/** The corners phase 4 would route between, over the same ground. */
function cellCorners(span = 2000) {
  const r = rng(17);
  const seeds = [];
  for (let i = 0; i < 40; i++) {
    seeds.push(turf.point([X0 + lng(r() * span), Y0 + lat(r() * span)]));
  }
  const box = [X0, Y0, X0 + lng(span), Y0 + lat(span)];
  const corners = [];
  for (const cell of turf.voronoi(turf.featureCollection(seeds), { bbox: box }).features) {
    if (!cell) continue;
    for (const c of cell.geometry.coordinates[0]) {
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) continue;
      corners.push(c);
    }
  }
  return corners;
}

/** _phase4's anchor(), as a reference: memoized on the corner at 5 decimals. */
function anchoring(grid) {
  const seen = new Map();
  return (point) => {
    const key = point.map((n) => n.toFixed(PRECISION)).join(",");
    if (seen.has(key)) return seen.get(key);
    const hit = grid.nearestPoint(point, SNAP_CAP_M);
    const anchor = hit ? hit.coord : point;
    seen.set(key, anchor);
    return anchor;
  };
}

test("the snap cap is a cap", () => {
  // The corner is allowed to move about half a block, no further. Without the
  // limit being honoured, ROUTE_SNAP_MAX_M's 500 m would let a corner be
  // teleported past the street beside it and across several blocks, which
  // deforms the territory far more than the straight line it was fixing.
  const grid = new SP.Grid(150);
  grid.addPoint([X0, Y0], "near");
  grid.addPoint([X0 + lng(400), Y0], "far");

  assert.equal(grid.nearestPoint([X0 + lng(30), Y0], SNAP_CAP_M).payload, "near");
  assert.equal(
    grid.nearestPoint([X0 + lng(250), Y0], SNAP_CAP_M),
    null,
    "a corner with no street within the cap must be left where it is",
  );
});

test("corners that agree to a metre get the same anchor", () => {
  // The invariant the whole thing rests on. Clipping a cell to the outer
  // polygon rebuilds its ring, so the three cells meeting at a corner can each
  // carry a slightly different float for it. Keying the memo at five decimals
  // — about a metre — is what makes them agree; keying on the raw pair would
  // let them disagree by a node and leave the rings open.
  const grid = streets();
  const anchor = anchoring(grid);

  for (const corner of cellCorners().slice(0, 40)) {
    const jittered = [corner[0] + 1e-9, corner[1] - 1e-9];
    assert.deepEqual(
      anchor(jittered),
      anchor(corner),
      "two copies of one corner were anchored to different places",
    );
  }
});

test("the same corner anchors the same way every time", () => {
  // Not obvious from the outside: Grid.candidates() returns its hits in
  // bucket order and nearestPoint picks among them by distance, so a tie
  // between two equidistant nodes has to break the same way twice or the memo
  // would be hiding a coin flip rather than a lookup.
  const grid = streets();
  const corners = cellCorners().slice(0, 40);
  const first = corners.map((c) => grid.nearestPoint(c, SNAP_CAP_M));
  const again = corners.map((c) => grid.nearestPoint(c, SNAP_CAP_M));

  assert.deepEqual(
    again.map((hit) => hit && hit.payload),
    first.map((hit) => hit && hit.payload),
  );
});

test("anchoring removes almost all of the off-street boundary", () => {
  // The point of the change, measured the way the complaint was made: how
  // much straight line the boundary lays across blocks to reach its corners.
  const grid = streets();
  const corners = cellCorners();

  let before = 0;
  let after = 0;
  let pulled = 0;

  for (const corner of corners) {
    // Today: routing reaches up to ROUTE_SNAP_MAX_M for a node and the gap
    // between the corner and that node is emitted as boundary.
    const reached = grid.nearestPoint(corner, 500);
    before += reached ? reached.dist : 0;

    const near = grid.nearestPoint(corner, SNAP_CAP_M);
    if (near) pulled++;
    else after += reached ? reached.dist : 0;
  }

  assert.ok(
    pulled / corners.length > 0.85,
    `most corners should reach a street within the cap, got ${pulled}/${corners.length}`,
  );
  assert.ok(
    after < before * 0.25,
    `off-street boundary should mostly go away, ${Math.round(before)} m -> ${Math.round(after)} m`,
  );
});
