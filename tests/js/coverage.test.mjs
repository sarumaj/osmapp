/**
 * The raster the trim tool builds its shape out of.
 *
 * Every failure mode here is silent and geometric. A disc that stamps one cell
 * short moves the boundary a meter closer to a house than the tool's whole
 * safety argument assumes. A tracer that fuses two components at a diagonal
 * touch turns two villages into one territory pinched to a point, which looks
 * plausible on screen and cuts badly afterwards. A ring that comes out
 * clockwise is read as a hole and thrown away, so the shape silently becomes
 * the next-largest thing on the map.
 *
 * No turf and no Leaflet: this module is arithmetic on arrays, which is
 * exactly why it can be tested at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const C = loadApp(["coverage.js"]).coverage;

/** A raster whose cells are a clean 10 m, centered on a small box near Kraków. */
function raster(opts = {}) {
  return new C.Raster([19.9, 50.0, 19.91, 50.005], {
    cell: 10,
    pad: 0,
    ...opts,
  });
}

/** Meters per cell step, for turning cell counts back into distances. */
function metersPerCellLat(r) {
  return r.dLat * C.M_PER_DEG_LAT;
}

// ── Sizing ───────────────────────────────────────────────────────────────────

test("cells are the requested size in meters on both axes", () => {
  const r = raster();
  assert.ok(Math.abs(metersPerCellLat(r) - 10) < 0.01);
  assert.ok(Math.abs(r.dLng * C.lngScale(50.0025) - 10) < 0.01);
});

test("the cell grows rather than the raster blowing the budget", () => {
  // A 40 km box at 10 m cells would be 16 million cells; the constructor is
  // supposed to coarsen instead of allocating it.
  const r = new C.Raster([19.0, 50.0, 19.5, 50.4], { cell: 10, maxCells: 50000 });
  assert.ok(r.w * r.h <= 50000, `got ${r.w * r.h} cells`);
  assert.ok(r.cell > 10);
});

test("pad widens the raster on every side", () => {
  const bare = raster();
  const padded = raster({ pad: 100 });
  assert.equal(padded.w, bare.w + 20);
  assert.equal(padded.h, bare.h + 20);
  assert.ok(padded.west < bare.west);
  assert.ok(padded.south < bare.south);
});

// ── Stamping ─────────────────────────────────────────────────────────────────

test("a disc smaller than a cell still leaves a mark", () => {
  const r = raster();
  r.stampDisc([19.905, 50.002], 1);
  assert.equal(r.marked, 1);
});

test("a disc covers everything within its radius and nothing beyond it", () => {
  // This is the property the whole safety argument rests on: the marked region
  // contains the full disc, so a stamped point is at least `radius` from the
  // boundary and the ring can then be moved onto a street without reaching it.
  const r = raster({ pad: 200 });
  const center = [19.905, 50.0025];
  const radius = 55;
  r.stampDisc(center, radius);

  const c = r.cellOf(center);
  let inside = 0;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const dx = (x - c[0]) * r.cell;
      const dy = (y - c[1]) * r.cell;
      const d = Math.sqrt(dx * dx + dy * dy);
      // Comfortably inside must be marked; comfortably outside must not be.
      // The cell-width band between them is where rounding lives.
      if (d < radius - r.cell) {
        assert.ok(r.get(x, y), `unmarked at ${d.toFixed(1)} m`);
        inside++;
      } else if (d > radius + r.cell) {
        assert.ok(!r.get(x, y), `marked at ${d.toFixed(1)} m`);
      }
    }
  }
  assert.ok(inside > 50, "the test itself should have covered a real area");
});

// ── Components ───────────────────────────────────────────────────────────────

test("separate blobs are separate components", () => {
  const r = raster({ pad: 200 });
  r.stampDisc([19.901, 50.001], 30);
  r.stampDisc([19.909, 50.004], 30);
  const { sizes } = r.components();
  assert.equal(sizes.length - 1, 2);
});

test("blobs that overlap are one component", () => {
  const r = raster({ pad: 200 });
  r.stampDisc([19.9045, 50.0025], 60);
  r.stampDisc([19.9055, 50.0025], 60);
  assert.equal(r.components().sizes.length - 1, 1);
});

test("labelAt names the component a point falls in, and 0 off it", () => {
  const r = raster({ pad: 200 });
  r.stampDisc([19.901, 50.001], 30);
  r.stampDisc([19.909, 50.004], 30);
  const a = r.labelAt([19.901, 50.001]);
  const b = r.labelAt([19.909, 50.004]);
  assert.ok(a > 0 && b > 0);
  assert.notEqual(a, b);
  assert.equal(r.labelAt([19.9055, 50.0025]), 0);
});

// ── Rings ────────────────────────────────────────────────────────────────────

test("one marked cell traces one counter-clockwise square", () => {
  const r = raster();
  r.set(4, 4);
  const { exteriors, holes } = r.ringsOf();
  assert.equal(exteriors.length, 1);
  assert.equal(holes.length, 0);
  // Four corners plus the repeated closing point.
  assert.equal(exteriors[0].length, 5);
  assert.ok(C.signedArea(exteriors[0]) > 0, "exteriors must wind CCW");
});

test("a ring around a gap yields the gap as a hole", () => {
  const r = raster();
  for (let y = 3; y <= 7; y++) {
    for (let x = 3; x <= 7; x++) {
      if (x === 5 && y === 5) continue;
      r.set(x, y);
    }
  }
  const { exteriors, holes } = r.ringsOf();
  assert.equal(exteriors.length, 1);
  assert.equal(holes.length, 1);
  assert.ok(C.signedArea(holes[0]) < 0, "holes must wind the other way");
});

test("cells touching only at a corner stay two rings", () => {
  // The case that decides whether components are 4- or 8-connected. Fused,
  // this is one boundary pinched to a single point — a shape that is not a
  // valid polygon and not a place anyone can walk around.
  const r = raster();
  r.set(4, 4);
  r.set(5, 5);
  const { exteriors } = r.ringsOf();
  assert.equal(exteriors.length, 2);
  exteriors.forEach((ring) => assert.equal(ring.length, 5));
});

test("ringsOf(label) traces one component and ignores the other", () => {
  const r = raster({ pad: 200 });
  r.stampDisc([19.901, 50.001], 30);
  r.stampDisc([19.909, 50.004], 30);
  const label = r.labelAt([19.901, 50.001]);
  const { exteriors } = r.ringsOf(label);
  assert.equal(exteriors.length, 1);
});

test("a straight run collapses to its corners", () => {
  const r = raster();
  for (let x = 2; x <= 9; x++) r.set(x, 4);
  const ring = r.ringsOf().exteriors[0];
  assert.equal(ring.length, 5, "a 1×8 bar is still a rectangle");
});

test("ring coordinates land on the raster's own grid", () => {
  const r = raster();
  r.set(4, 4);
  const ring = r.ringsOf().exteriors[0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  assert.ok(Math.abs(Math.min(...xs) - (r.west + 4 * r.dLng)) < 1e-12);
  assert.ok(Math.abs(Math.max(...ys) - (r.south + 5 * r.dLat)) < 1e-12);
});

test("an empty raster traces nothing", () => {
  assert.deepEqual(raster().ringsOf(), { exteriors: [], holes: [] });
});

// ── collapse ─────────────────────────────────────────────────────────────────

test("collapse keeps a ring closed", () => {
  const out = C.collapse([
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ]);
  assert.deepEqual(out[0], out[out.length - 1]);
  assert.equal(out.length, 5);
});

test("collapse refuses to erase a shape down to nothing", () => {
  const degenerate = [
    [0, 0],
    [1, 0],
    [0, 0],
  ];
  assert.ok(C.collapse(degenerate).length >= 3);
});

// ── Speed ────────────────────────────────────────────────────────────────────

test("a village-sized raster is built and traced in well under a second", () => {
  // 3000 buildings over 4 km², which is what the slider drags across.
  const r = new C.Raster([19.9, 50.0, 19.93, 50.018], {
    cell: 10,
    pad: 80,
    maxCells: 400000,
  });
  const started = Date.now();
  for (let i = 0; i < 3000; i++) {
    r.stampDisc([19.9 + (i % 60) * 0.0005, 50.0 + Math.floor(i / 60) * 0.00035], 60);
  }
  r.components();
  const { exteriors } = r.ringsOf(1);
  assert.ok(exteriors.length >= 1);
  assert.ok(Date.now() - started < 2000, "the preview has to keep up with a drag");
});

// ── stampPath ────────────────────────────────────────────────────────────────

test("a corridor along a path is connected end to end", () => {
  // The corridor exists to join two settlements into one component. A dotted
  // one — discs stepped further apart than they are wide — leaves the labeler
  // seeing the same two places it saw before, and the bridge silently does
  // nothing.
  const r = raster({ pad: 400 });
  r.stampDisc([19.901, 50.001], 30);
  r.stampDisc([19.9085, 50.0042], 30);
  assert.equal(r.components().sizes.length - 1, 2);

  r.stampPath([[19.901, 50.001], [19.9085, 50.0042]], 12);
  assert.equal(r.components().sizes.length - 1, 1, "the bridge must actually join them");
});

test("a corridor is never narrower than a cell", () => {
  // Asking for a two-meter corridor on a ten-meter raster cannot produce a
  // two-meter corridor; it can only produce a broken one.
  const r = raster({ pad: 400 });
  r.stampPath([[19.902, 50.002], [19.907, 50.004]], 1);
  assert.equal(r.components().sizes.length - 1, 1);
});

test("a corridor follows the bends of its path", () => {
  const r = raster({ pad: 400 });
  r.stampPath(
    [
      [19.902, 50.001],
      [19.902, 50.004],
      [19.907, 50.004],
    ],
    12,
  );
  assert.equal(r.components().sizes.length - 1, 1);
  // The inside of the corner stays empty: this is a corridor, not a hull.
  assert.equal(r.labelAt([19.9065, 50.0012]), 0);
});

test("a path of one point is just a disc", () => {
  const r = raster({ pad: 200 });
  r.stampPath([[19.905, 50.0025]], 30);
  assert.ok(r.marked > 20);
  assert.equal(r.components().sizes.length - 1, 1);
});

test("an empty path marks nothing", () => {
  const r = raster();
  r.stampPath([], 30);
  assert.equal(r.marked, 0);
});

// ── Tapered corridors ────────────────────────────────────────────────────────

/** Width of the stamped corridor, in meters, on the column through `lng`. */
function widthAt(r, lng, lat) {
  const c = r.cellOf([lng, lat]);
  let count = 0;
  for (let y = 0; y < r.h; y++) if (r.get(c[0], y)) count++;
  return count * r.cell;
}

test("a taper is a wedge: wide at the start, narrow at the end", () => {
  // The first version widened both ends and left the middle narrow, so a long
  // link came out as a wire with a trumpet soldered to each end — three shapes
  // where the ground has one. A cone from the settlement down to the building
  // it reaches is the shape a peninsula actually has.
  const r = raster({ pad: 600 });
  const a = [19.902, 50.0025];
  const b = [19.909, 50.0025];
  r.stampPath([a, b], 12, { start: 60, end: 12 });

  const near = widthAt(r, 19.9022, 50.0025);
  const middle = widthAt(r, (a[0] + b[0]) / 2, 50.0025);
  const far = widthAt(r, 19.9088, 50.0025);

  assert.ok(near > middle, `start ${near} m should beat middle ${middle} m`);
  assert.ok(middle > far, `middle ${middle} m should beat end ${far} m`);
  assert.ok(near > far * 2, "the wedge should actually taper");
});

test("the taper runs the other way round when the path does", () => {
  const r = raster({ pad: 600 });
  r.stampPath([[19.909, 50.0025], [19.902, 50.0025]], 12, { start: 60, end: 12 });
  assert.ok(widthAt(r, 19.9088, 50.0025) > widthAt(r, 19.9022, 50.0025));
});

test("a corridor is never narrower than the width asked for", () => {
  const r = raster({ pad: 600 });
  r.stampPath([[19.902, 50.0025], [19.909, 50.0025]], 20, { start: 60, end: 1 });
  // The tip asks for 1 m, which is below both the requested width and a cell.
  assert.ok(widthAt(r, 19.9088, 50.0025) >= 40, "the narrow width is a floor");
});

// ── fillPolygon ──────────────────────────────────────────────────────────────

test("filling a polygon marks its inside and not its outside", () => {
  const r = raster({ pad: 100 });
  const w = 19.902;
  const e = 19.908;
  const s0 = 50.001;
  const n = 50.004;
  r.fillPolygon([[[w, s0], [e, s0], [e, n], [w, n], [w, s0]]]);

  assert.ok(r.labelAt([19.905, 50.0025]) > 0, "the middle should be inside");
  assert.equal(r.labelAt([19.9, 50.0025]), 0, "west of it should not");
  assert.equal(r.labelAt([19.905, 50.0005]), 0, "south of it should not");
});

test("an interior ring stays unfilled", () => {
  // Even-odd, so a hole needs no special case — it is just more crossings on
  // the rows it spans. The working boundary can have one, and a corridor is
  // not allowed to run through it.
  const r = raster({ pad: 100 });
  r.fillPolygon([
    [[19.901, 50.0005], [19.909, 50.0005], [19.909, 50.0045], [19.901, 50.0045], [19.901, 50.0005]],
    [[19.904, 50.002], [19.906, 50.002], [19.906, 50.003], [19.904, 50.003], [19.904, 50.002]],
  ]);
  assert.ok(r.labelAt([19.9025, 50.0025]) > 0);
  assert.equal(r.labelAt([19.905, 50.0025]), 0, "the hole must stay empty");
});

test("a concave polygon is filled to its own shape", () => {
  // An L. The notch is the case the corridor router exists for: a straight
  // line between the two arms leaves the area entirely.
  const r = raster({ pad: 100 });
  r.fillPolygon([[
    [19.901, 50.0005],
    [19.909, 50.0005],
    [19.909, 50.002],
    [19.904, 50.002],
    [19.904, 50.0045],
    [19.901, 50.0045],
    [19.901, 50.0005],
  ]]);
  assert.ok(r.labelAt([19.9025, 50.004]) > 0, "the upright of the L");
  assert.ok(r.labelAt([19.907, 50.001]) > 0, "the foot of the L");
  assert.equal(r.labelAt([19.907, 50.004]), 0, "the notch must stay empty");
});

// ── route ────────────────────────────────────────────────────────────────────

test("routing goes around a notch rather than straight across it", () => {
  const r = raster({ pad: 100 });
  r.fillPolygon([[
    [19.901, 50.0005],
    [19.909, 50.0005],
    [19.909, 50.002],
    [19.904, 50.002],
    [19.904, 50.0045],
    [19.901, 50.0045],
    [19.901, 50.0005],
  ]]);

  const path = r.route([19.9025, 50.004], [19.907, 50.001]);
  assert.ok(path, "there is a way round, so there must be a path");
  // Every step of it stays on filled ground — which a straight line would not.
  path.forEach((point) => {
    const c = r.cellOf(point);
    assert.ok(r.get(c[0], c[1]), "the route left the area");
  });
  const straight = r.meters([19.9025, 50.004], [19.907, 50.001]);
  assert.ok(r.pathLength(path) > straight, "going round costs more than cutting across");
});

test("routing to somewhere unreachable says so", () => {
  const r = raster({ pad: 100 });
  r.fillPolygon([[[19.901, 50.001], [19.903, 50.001], [19.903, 50.003], [19.901, 50.003], [19.901, 50.001]]]);
  r.fillPolygon([[[19.907, 50.001], [19.909, 50.001], [19.909, 50.003], [19.907, 50.003], [19.907, 50.001]]]);
  assert.equal(r.route([19.902, 50.002], [19.908, 50.002]), null);
});

test("routing snaps endpoints that fall just off the filled area", () => {
  const r = raster({ pad: 100 });
  r.fillPolygon([[[19.902, 50.001], [19.908, 50.001], [19.908, 50.004], [19.902, 50.004], [19.902, 50.001]]]);
  // A building whose center lands a meter outside the fill is still a building
  // inside the area, and refusing to route from it would be pedantry.
  assert.ok(r.route([19.90199, 50.0025], [19.9075, 50.0035]));
});

// ── visible / simplifyPath ───────────────────────────────────────────────────

test("visible answers over the whole segment, not just its ends", () => {
  // The case the corridor router exists for: both ends of the line are
  // comfortably inside an L-shaped area and the middle of it is not. Testing
  // endpoints — which is what the first version did — says yes and is wrong.
  const r = raster({ pad: 100 });
  r.fillPolygon([[
    [19.901, 50.0005],
    [19.909, 50.0005],
    [19.909, 50.002],
    [19.904, 50.002],
    [19.904, 50.0045],
    [19.901, 50.0045],
    [19.901, 50.0005],
  ]]);

  const upright = [19.9025, 50.004];
  const foot = [19.907, 50.001];
  assert.ok(r.get(...r.cellOf(upright)), "both ends are inside");
  assert.ok(r.get(...r.cellOf(foot)));
  assert.equal(r.visible(upright, foot), false, "but the line between them is not");
  assert.equal(r.visible(upright, [19.9025, 50.001]), true, "straight down the upright");
});

test("simplifyPath pulls a staircase into a couple of legs", () => {
  // A grid route is one cell per step and every turn a right angle. Stamped as
  // a corridor that is a visibly synthetic shape, so it gets string-pulled
  // back to the few straight legs a person would have described.
  const r = raster({ pad: 100 });
  r.fillPolygon([[[19.901, 50.0005], [19.909, 50.0005], [19.909, 50.0045], [19.901, 50.0045], [19.901, 50.0005]]]);

  const route = r.route([19.902, 50.001], [19.908, 50.004]);
  assert.ok(route.length > 20, `the raw route should be a staircase, got ${route.length}`);

  const legs = r.simplifyPath(route);
  assert.ok(legs.length < 6, `expected a handful of legs, got ${legs.length}`);
  assert.deepEqual(legs[0], route[0], "the endpoints are kept");
  assert.deepEqual(legs[legs.length - 1], route[route.length - 1]);
  // And every leg still stays on filled ground, which is the whole point of
  // not simplifying with Douglas-Peucker instead.
  for (let i = 0; i < legs.length - 1; i++) {
    assert.ok(r.visible(legs[i], legs[i + 1]), `leg ${i} left the area`);
  }
});

test("simplifyPath keeps the corner it was routed around", () => {
  const r = raster({ pad: 100 });
  r.fillPolygon([[
    [19.901, 50.0005],
    [19.909, 50.0005],
    [19.909, 50.002],
    [19.904, 50.002],
    [19.904, 50.0045],
    [19.901, 50.0045],
    [19.901, 50.0005],
  ]]);

  const legs = r.simplifyPath(r.route([19.9025, 50.004], [19.907, 50.001]));
  assert.ok(legs.length >= 3, "a straight line would have left the area");
  for (let i = 0; i < legs.length - 1; i++) {
    assert.ok(r.visible(legs[i], legs[i + 1]));
  }
});

test("simplifyPath leaves a path with nothing to pull alone", () => {
  const r = raster({ pad: 100 });
  assert.deepEqual(r.simplifyPath([[19.902, 50.002]]), [[19.902, 50.002]]);
  assert.deepEqual(r.simplifyPath([]), []);
});
