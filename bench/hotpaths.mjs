/**
 * hotpaths.mjs — measure the client-side loops that dominate a partition.
 *
 * Run with:  npm run bench
 *
 * Every case loads the real module through the same vm harness tests/js uses,
 * so what is timed is the shipped code rather than a paraphrase of it. The
 * fixtures are synthetic but sized from real runs: a Nominatim city boundary
 * comes back with one to four thousand vertices after simplification, a
 * partition of a small town produces a few thousand unique cell edges, and a
 * 50 km² download is five figures of buildings.
 *
 * Each case prints the current implementation next to a candidate
 * replacement, so the output is a decision rather than a number. A case whose
 * candidate does not win is worth keeping: it is the record of why the
 * obvious optimization was not made.
 */

import { performance } from "node:perf_hooks";
import { loadApp } from "../tests/js/helpers/load.mjs";
import { loadTurf } from "../tests/js/helpers/turf.mjs";

const turf = loadTurf();
const App = loadApp(["util.js", "geometry.js", "spatial.js"], { turf });
const G = App.geometry;
const SP = App.spatial;

// ── fixtures ──────────────────────────────────────────────────────────────

/** A closed ring approximating a circle, in degrees. */
function ring(n, radiusDeg = 0.05, cx = 8.24, cy = 48.0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    // A little radial noise: a perfect circle is unrealistically friendly to
    // any index that buckets by distance.
    const r = radiusDeg * (1 + 0.02 * Math.sin(a * 17));
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.67]);
  }
  out.push(out[0].slice());
  return out;
}

function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Points scattered over the ring's bounding box. */
function probes(n, r, cx = 8.24, cy = 48.0) {
  const rand = rng(12345);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([cx + (rand() * 2 - 1) * r, cy + (rand() * 2 - 1) * r * 0.67]);
  }
  return out;
}

/** k territories in a grid, each with a jagged edge. */
function slots(k, cx = 8.24, cy = 48.0, span = 0.08) {
  const cols = Math.ceil(Math.sqrt(k));
  const w = span / cols;
  const out = [];
  for (let i = 0; i < k; i++) {
    const x = cx + (i % cols) * w;
    const y = cy + Math.floor(i / cols) * w;
    // Street-routed boundaries are not rectangles. The wobble puts the vertex
    // count in the right order of magnitude, which is what the polygon
    // predicates actually cost.
    const coords = [];
    const steps = 40;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const wob = 0.06 * w * Math.sin(t * 31);
      if (t < 0.25) coords.push([x + t * 4 * w, y + wob]);
      else if (t < 0.5) coords.push([x + w + wob, y + (t - 0.25) * 4 * w]);
      else if (t < 0.75) coords.push([x + w - (t - 0.5) * 4 * w, y + w + wob]);
      else coords.push([x + wob, y + w - (t - 0.75) * 4 * w]);
    }
    coords.push(coords[0].slice());
    out.push(turf.polygon([coords]));
  }
  return out;
}

// ── timing ────────────────────────────────────────────────────────────────

function time(label, fn, iterations = 1) {
  fn(); // warm the JIT and any lazily built index
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = (performance.now() - t0) / iterations;
  console.log(`    ${label.padEnd(38)} ${ms.toFixed(1).padStart(9)} ms`);
  return ms;
}

function verdict(before, after) {
  const factor = before / after;
  console.log(
    `    ${"→".padEnd(38)} ${
      factor >= 1 ? factor.toFixed(1) + "× faster" : (1 / factor).toFixed(1) + "× SLOWER"
    }\n`,
  );
}

// ── case 1: clustering phase 4, outer-boundary classification ─────────────
//
// _phase4 calls isOnOuterBoundary three times per unique cell edge, and each
// call walks the entire outer ring. The work is |edges| × |ring| × 3, and the
// ring is whatever Nominatim handed back.

function caseOuterBoundary(ringSize, edgeCount) {
  console.log(`  outer ring ${ringSize} pts × ${edgeCount} edges (×3 probes each)`);
  const r = ring(ringSize);
  const pts = probes(edgeCount * 3, 0.055);

  const linear = () => {
    let hits = 0;
    for (const p of pts) if (G.isOnOuterBoundary(p, r)) hits++;
    return hits;
  };

  // Candidate: stamp the ring into the grid index that already ships in
  // spatial.js. The index is built inside the timed function on purpose —
  // phase 4 would build it once, so paying for it here is the honest
  // comparison and still wins at realistic ring sizes.
  const indexed = () => {
    const grid = new SP.Grid(25);
    for (let i = 0; i < r.length - 1; i++) grid.addSegment(r[i], r[i + 1], i);
    let hits = 0;
    for (const p of pts) {
      const near = grid.nearestSegment(p, 10);
      if (near && near.dist < 5.5) hits++;
    }
    return hits;
  };

  const a = time("isOnOuterBoundary (current)", linear);
  const b = time("spatial.Grid.nearestSegment", indexed);
  verdict(a, b);
}

// ── case 2: _touchingSlots adjacency ──────────────────────────────────────
//
// A full polygon intersect against every slot with no cheap rejection first,
// called once per gap fragment and once per orphan, across up to five
// connectivity passes.

function caseTouchingSlots(k, probeCount) {
  console.log(`  ${k} territories × ${probeCount} fragments`);
  const polys = slots(k);
  // An orphan or gap fragment is a sliver, not a whole territory: it touches
  // two or three slots, never forty. Shrinking a slot to a tenth of its size
  // is what makes the rejection ratio realistic — a fragment that genuinely
  // overlapped everything would make any prefilter look pointless.
  const frags = polys.slice(0, probeCount).map((p) => {
    const b = turf.bbox(p);
    const w = (b[2] - b[0]) * 0.12;
    const h = (b[3] - b[1]) * 0.12;
    return turf.polygon([
      [
        [b[0], b[1]],
        [b[0] + w, b[1]],
        [b[0] + w, b[1] + h],
        [b[0], b[1] + h],
        [b[0], b[1]],
      ],
    ]);
  });

  const current = () => {
    let hits = 0;
    for (const f of frags) {
      const probe = turf.buffer(f, 0.5, { units: "meters" }) || f;
      for (const s of polys) {
        try {
          const shared = G.intersect(probe, s);
          if (shared && turf.area(shared) > 0) hits++;
        } catch (e) {
          /* skip an unusable slot, as the real code does */
        }
      }
    }
    return hits;
  };

  const prefiltered = () => {
    const boxes = polys.map((p) => turf.bbox(p));
    let hits = 0;
    for (const f of frags) {
      const probe = turf.buffer(f, 0.5, { units: "meters" }) || f;
      const pb = turf.bbox(probe);
      for (let i = 0; i < polys.length; i++) {
        if (!G.bboxOverlap(pb, boxes[i])) continue;
        try {
          const shared = G.intersect(probe, polys[i]);
          if (shared && turf.area(shared) > 0) hits++;
        } catch (e) {
          /* skip */
        }
      }
    }
    return hits;
  };

  // The ranking needs a shared area; the rejection does not.
  // booleanIntersects answers yes/no without constructing the intersection
  // polygon, so only the two or three real neighbors are ever measured.
  const twoStage = () => {
    const boxes = polys.map((p) => turf.bbox(p));
    let hits = 0;
    for (const f of frags) {
      const probe = turf.buffer(f, 0.5, { units: "meters" }) || f;
      const pb = turf.bbox(probe);
      for (let i = 0; i < polys.length; i++) {
        if (!G.bboxOverlap(pb, boxes[i])) continue;
        try {
          if (!turf.booleanIntersects(probe, polys[i])) continue;
          const shared = G.intersect(probe, polys[i]);
          if (shared && turf.area(shared) > 0) hits++;
        } catch (e) {
          /* skip */
        }
      }
    }
    return hits;
  };

  const a = time("intersect against every slot", current);
  time("bbox reject, then intersect", prefiltered);
  const c = time("bbox + booleanIntersects, then area", twoStage);
  verdict(a, c);
}

// ── case 3: the per-primitive cost table ──────────────────────────────────
//
// The two cases above are loops. This is what one iteration of each costs,
// and it is the number that decides which predicate belongs in an inner loop.

function casePrimitives() {
  const polys = slots(80);
  const frag = turf.buffer(polys[0], -20, { units: "meters" }) || polys[0];
  const probe = turf.buffer(frag, 0.5, { units: "meters" }) || frag;

  const one = (label, fn, n) => {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    const ms = (performance.now() - t0) / n;
    console.log(`    ${label.padEnd(38)} ${ms.toFixed(3).padStart(9)} ms/call`);
  };

  one("turf.buffer(f, 0.5 m)", () => turf.buffer(frag, 0.5, { units: "meters" }), 200);
  one("G.intersect(a, b)", () => G.intersect(probe, polys[1]), 300);
  one("turf.booleanIntersects(a, b)", () => turf.booleanIntersects(probe, polys[1]), 500);
  one("turf.bbox(f)", () => turf.bbox(probe), 5000);
  one("turf.area(f)", () => turf.area(polys[0]), 5000);
  console.log("");
}

// ── case 4: the filtered view in polygons.js ──────────────────────────────
//
// Included because it was a suspect and turned out not to be one. The bbox
// rejection already there does its job; leave it alone.

function caseFilteredView(k, streetCount) {
  console.log(`  ${k} territories × ${streetCount} streets`);
  const polys = slots(k);
  const boxes = polys.map((p) => turf.bbox(p));
  const rand = rng(999);
  const streets = [];
  for (let i = 0; i < streetCount; i++) {
    const x = 8.24 + rand() * 0.08;
    const y = 48.0 + rand() * 0.08;
    streets.push(
      turf.lineString([
        [x, y],
        [x + 0.0008, y + 0.0004],
        [x + 0.0015, y + 0.0011],
      ]),
    );
  }

  time("bbox reject + booleanIntersects", () => {
    let hits = 0;
    for (const f of streets) {
      const fb = turf.bbox(f);
      for (let i = 0; i < polys.length; i++) {
        if (!G.bboxOverlap(fb, boxes[i])) continue;
        try {
          if (turf.booleanIntersects(f, polys[i])) hits++;
        } catch (e) {
          /* skip */
        }
      }
    }
    return hits;
  });
  console.log("");
}

// ── run ───────────────────────────────────────────────────────────────────

console.log("\n── per-primitive cost ──\n");
casePrimitives();

console.log("── clustering phase 4: outer-boundary classification ──\n");
caseOuterBoundary(500, 1500);
caseOuterBoundary(2000, 4000);

console.log("── clustering: _touchingSlots adjacency ──\n");
caseTouchingSlots(40, 20);
caseTouchingSlots(80, 40);

console.log("── polygons.js: applyFilteredView (control) ──\n");
caseFilteredView(40, 3000);
caseFilteredView(80, 8000);
