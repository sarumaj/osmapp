/**
 * The shape the trim tool proposes.
 *
 * The interaction around it is clicks and a slider; this is the part that has
 * an opinion. Four judgments carry the feature, and every one of them fails
 * quietly — the tool would still return a polygon, still draw it in green, and
 * still let somebody apply it:
 *
 *   • Reach decides what counts as sparse. A shape that ignores the slider
 *     looks identical at every setting, which is exactly what a broken slider
 *     looks like too.
 *   • Ignored buildings must actually pull the boundary in. If they only
 *     changed a count somewhere, the whole selection gesture would be
 *     decoration.
 *   • The winner among disconnected settlements is the one with the most
 *     buildings, not the largest area — a wide empty component with three
 *     farms in it must not beat the village.
 *   • Trimming never grows. Clipping to the existing boundary is the only
 *     thing standing between "reshape the area" and "silently annex the field
 *     next door", and it is one intersect() call away from being forgotten.
 *
 * Everything runs against stubs. The geometry is axis-aligned rectangles and
 * grids of little squares, which is all the questions below need — how well a
 * ring traces and simplifies is coverage.test.mjs's question, and how the
 * street graph answers is network.test.mjs's.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG = 111320;

// ── Stubs ────────────────────────────────────────────────────────────────────

function coordsOf(feature) {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number") return void out.push(node);
    node.forEach(walk);
  };
  walk((feature.geometry || feature).coordinates);
  return out;
}

function outerRing(feature) {
  const g = feature.geometry || feature;
  return g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0];
}

/** Planar shoelace in meters², good enough for boxes a kilometre across. */
function planarArea(feature) {
  const ring = outerRing(feature);
  const lat = ring[0][1];
  const kx = M_PER_DEG_LNG * Math.cos((lat / 180) * Math.PI);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum +=
      ring[i][0] * kx * (ring[i + 1][1] * M_PER_DEG_LAT) -
      ring[i + 1][0] * kx * (ring[i][1] * M_PER_DEG_LAT);
  }
  return Math.abs(sum / 2);
}

/** Perpendicular distance from p to the segment a-b, in coordinate units. */
function pointToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const ex = p[0] - (a[0] + t * dx);
  const ey = p[1] - (a[1] + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

function douglasPeucker(points, tolerance) {
  if (!tolerance || points.length < 3) return points;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToSegment(points[i], points[0], points[points.length - 1]);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...douglasPeucker(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...douglasPeucker(points.slice(index), tolerance),
  ];
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const turf = {
  feature: (geometry) => ({ type: "Feature", geometry, properties: {} }),
  polygon: (coordinates, properties) => ({
    type: "Feature",
    properties: properties || {},
    geometry: { type: "Polygon", coordinates },
  }),
  multiPolygon: (coordinates, properties) => ({
    type: "Feature",
    properties: properties || {},
    geometry: { type: "MultiPolygon", coordinates },
  }),
  point: (coordinates) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates },
  }),
  bbox(feature) {
    const points = coordsOf(feature);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  },
  area: planarArea,
  booleanValid: () => true,
  // A real Douglas-Peucker, not an identity stub: the edge-detail slider is
  // nothing but a tolerance handed to this call, so stubbing it out would
  // leave the one control it drives untested.
  simplify: (feature, { tolerance }) => {
    const ring = outerRing(feature);
    const kept = douglasPeucker(ring.slice(0, -1), tolerance);
    if (kept.length < 3) return feature;
    return turf.polygon([[...kept, kept[0]]]);
  },
  booleanPointInPolygon: (point, poly) =>
    inRing(point.geometry.coordinates, outerRing(poly)),
  /**
   * Enough of an intersect for these fixtures: the proposal is either wholly
   * inside the boundary, in which case it survives, or it sticks out, in which
   * case it is cut back to the boundary. Both are rectangles here.
   */
  intersect(a, b) {
    const ring = outerRing(a);
    if (ring.every((p) => inRing(p, outerRing(b)))) return a;
    const [aw, as, ae, an] = turf.bbox(a);
    const [bw, bs, be, bn] = turf.bbox(b);
    const west = Math.max(aw, bw);
    const south = Math.max(as, bs);
    const east = Math.min(ae, be);
    const north = Math.min(an, bn);
    if (west >= east || south >= north) return null;
    return turf.polygon([
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ]);
  },
};

/** The two things App.network asks of Leaflet, and nothing else. */
const L = {
  latLng(lat, lng) {
    return {
      lat,
      lng,
      distanceTo(other) {
        const kx = M_PER_DEG_LNG * Math.cos(((lat + other.lat) / 2 / 180) * Math.PI);
        const dx = (lng - other.lng) * kx;
        const dy = (lat - other.lat) * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
      },
    };
  },
};

/**
 * @param {{streets?: Array}} [opts] street features to build the graph from.
 *   Omitted means no download happened, which is a state the tool has to
 *   survive rather than a state it can refuse.
 */
function load(opts = {}) {
  const window = {};
  const App = loadApp(
    ["geometry.js", "spatial.js", "coverage.js", "network.js", "trim.js"],
    { window, turf, document: { addEventListener() {} }, L },
  );
  App.state = {
    TRIM_REACH_M: 60,
    TRIM_CELL_M: 10,
    TRIM_MAX_CELLS: 400000,
    TRIM_SIMPLIFY_M: 6,
    TRIM_DETAIL_M: 15,
    TRIM_DETAIL_CLEARANCE_M: 15,
    TRIM_OUTLIER_NEIGHBORS: 3,
    TRIM_OUTLIER_FACTOR: 3,
    TRIM_OUTLIER_MIN_M: 120,
    TRIM_OUTLIER_LINK_FACTOR: 1.5,
    TRIM_OUTLIER_GROUP_MAX: 8,
    TRIM_OUTLIER_GROUP_SHARE: 0.05,
    TRIM_MARKER_MAX: 800,
    trimReachM: 60,
    trimDetailM: 15,
    TRIM_TIP_FACTOR: 2,
    TRIM_CORRIDOR_M: 12,
    TRIM_LINK_ROUNDS: 3,
    TRIM_LINK_MAX_GROUPS: 40,
    TRIM_SNAP_M: 25,
    TRIM_ROUTE_SLACK_M: 40,
    TRIM_ROUTE_MIN_M: 15,
    TRIM_ROUTE_BUDGET: 400,
    TRIM_ROUTE_MAX_POPS: 6000,
    CUT_ROUTE_MAX_DETOUR: 1.75,
    CUT_ROUTE_MAX_EXTRA_M: 300,
    cachedStreets: {
      type: "FeatureCollection",
      features: opts.streets || [],
    },
  };
  App.i18n = { t: (key) => key };
  App.dom = {};
  App.network.init();
  App.network.build(true);
  App.trim.init();
  return App.trim;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A rectangle in degrees, given a west/south corner and a size in meters. */
function box(west, south, widthM, heightM) {
  const kx = M_PER_DEG_LNG * Math.cos((south / 180) * Math.PI);
  const east = west + widthM / kx;
  const north = south + heightM / M_PER_DEG_LAT;
  return turf.polygon([
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]);
}

/** Meters east/north of an origin, as a [lng, lat]. */
function at(origin, x, y) {
  const kx = M_PER_DEG_LNG * Math.cos((origin[1] / 180) * Math.PI);
  return [origin[0] + x / kx, origin[1] + y / M_PER_DEG_LAT];
}

function entry(coord) {
  return { centroid: coord, key: coord.join(","), big: false };
}

const ORIGIN = [19.9, 50.0];
/** A 2 km × 2 km boundary — far bigger than the village inside it. */
const OUTER = box(ORIGIN[0], ORIGIN[1], 2000, 2000);

/** A block of houses on a 40 m grid, `cols` × `rows`, offset into the box. */
function village(originX, originY, cols, rows, spacing = 40) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push(entry(at(ORIGIN, originX + c * spacing, originY + r * spacing)));
    }
  }
  return out;
}

function propose(trim, keep, extra = {}) {
  return trim.propose({
    outer: OUTER,
    keep,
    reach: 60,
    detail: 0,
    follow: false,
    ...extra,
  });
}

/**
 * A rectangular loop road, noded every 20 m so there is always a graph node
 * within snapping distance of wherever the traced ring happens to come out.
 * `x` and `y` are meters from ORIGIN; `size` is the side of the square.
 */
function ringRoad(x, y, size, step = 20) {
  const corners = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  const features = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const legs = Math.round(size / step);
    const line = [];
    for (let t = 0; t <= legs; t++) {
      line.push(at(ORIGIN, ax + ((bx - ax) * t) / legs, ay + ((by - ay) * t) / legs));
    }
    features.push({
      type: "Feature",
      properties: { highway: "residential" },
      geometry: { type: "LineString", coordinates: line },
    });
  }
  return features;
}

/** Fraction of a proposal's vertices sitting on a road rather than near one. */
function onRoad(result, toleranceM = 3) {
  const ring = outerRing(result.feature);
  const kx = M_PER_DEG_LNG * Math.cos((ring[0][1] / 180) * Math.PI);
  const segments = [];
  ringRoad(730, 730, 260).forEach((feature) => {
    const line = feature.geometry.coordinates;
    for (let i = 0; i < line.length - 1; i++) segments.push([line[i], line[i + 1]]);
  });

  const near = ring.slice(0, -1).filter((point) =>
    segments.some(([a, b]) => {
      const ax = a[0] * kx;
      const ay = a[1] * M_PER_DEG_LAT;
      const bx = b[0] * kx;
      const by = b[1] * M_PER_DEG_LAT;
      const px = point[0] * kx;
      const py = point[1] * M_PER_DEG_LAT;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      return Math.sqrt(ex * ex + ey * ey) <= toleranceM;
    }),
  );
  return near.length / (ring.length - 1);
}

// ── The shape ────────────────────────────────────────────────────────────────

test("the proposal is a fraction of a boundary that is mostly empty", () => {
  const trim = load();
  const result = propose(trim, village(800, 800, 6, 6));

  assert.ok(!result.error, result.error);
  assert.ok(
    result.areaAfter < result.areaBefore * 0.3,
    `kept ${Math.round((result.areaAfter / result.areaBefore) * 100)}% of a mostly empty box`,
  );
});

test("every kept building ends up inside the proposal", () => {
  const trim = load();
  const keep = village(600, 600, 8, 8);
  const result = propose(trim, keep);

  assert.equal(result.outside, 0);
  assert.equal(result.inside, keep.length);
});

test("a wider reach means a bigger shape", () => {
  const trim = load();
  const keep = village(800, 800, 5, 5);
  const tight = propose(trim, keep, { reach: 30 });
  const loose = propose(trim, keep, { reach: 120 });

  assert.ok(
    loose.areaAfter > tight.areaAfter * 1.5,
    `${Math.round(tight.areaAfter)} m² vs ${Math.round(loose.areaAfter)} m²`,
  );
});

test("ignoring a ribbon of houses pulls the boundary off it", () => {
  const trim = load();
  const core = village(300, 900, 4, 4);
  // Houses every 100 m along a lane running east. A hundred meters is inside
  // twice the 60 m reach, so this really is one settlement and the ribbon
  // really does drag the boundary a kilometre out — which is the situation
  // the tool exists for.
  const ribbon = [];
  for (let x = 500; x <= 1500; x += 100) ribbon.push(entry(at(ORIGIN, x, 960)));

  const whole = propose(trim, core.concat(ribbon));
  const trimmed = propose(trim, core, { ignored: ribbon });

  assert.equal(whole.outside, 0, "the fixture should be one connected place");
  assert.ok(
    trimmed.areaAfter < whole.areaAfter * 0.7,
    `dropping the ribbon should shrink the shape: ${Math.round(whole.areaAfter)} m² → ${Math.round(trimmed.areaAfter)} m²`,
  );
  assert.ok(
    trimmed.ignoredInside <= 1,
    "the ribbon should end up outside, bar the house nearest the village",
  );
});

// ── Components ───────────────────────────────────────────────────────────────

test("a kept farm is joined by a corridor rather than dropped", () => {
  // The version before this dropped it: it formed its own raster component,
  // the vote went to the village, and the proposal came back unchanged. Which
  // made un-excluding a building a no-op — you clicked, the count went up, and
  // the boundary did not move. The user's model is the simple one, and the
  // simple one is right: what I keep, I keep.
  const trim = load();
  const houses = village(300, 900, 5, 5);
  const farm = entry(at(ORIGIN, 1700, 300));

  const without = propose(trim, houses);
  const with_ = propose(trim, houses.concat([farm]));

  assert.equal(with_.outside, 0, "a kept building must end up inside");
  assert.equal(with_.inside, houses.length + 1);
  assert.ok(
    with_.areaAfter > without.areaAfter,
    "the corridor out to it has to cost something",
  );
});

test("excluding the farm again takes the corridor with it", () => {
  const trim = load();
  const houses = village(300, 900, 5, 5);
  const farm = entry(at(ORIGIN, 1700, 300));

  const joined = propose(trim, houses.concat([farm]));
  const dropped = propose(trim, houses, { ignored: [farm] });

  assert.ok(
    dropped.areaAfter < joined.areaAfter * 0.8,
    `excluding it should undo the corridor: ${Math.round(joined.areaAfter)} m² → ${Math.round(dropped.areaAfter)} m²`,
  );
  assert.equal(dropped.ignoredInside, 0);
});

test("the biggest settlement seeds the shape and the rest are linked to it", () => {
  const trim = load();
  // Three farms strung out over 400 m cover more ground than nine houses
  // packed onto a 40 m grid. The nine houses are the place the shape starts
  // from — but the farms are kept, so they are reached, not abandoned.
  const spread = [
    entry(at(ORIGIN, 200, 200)),
    entry(at(ORIGIN, 200, 400)),
    entry(at(ORIGIN, 200, 600)),
  ];
  const dense = village(1400, 1400, 3, 3);
  const result = propose(trim, spread.concat(dense));

  assert.equal(result.outside, 0);
  assert.equal(result.inside, spread.length + dense.length);
});

test("a scattering too wide to bridge is reported rather than drawn as a starfish", () => {
  const trim = load();
  const dense = village(900, 900, 4, 4);
  const scattered = [];
  for (let i = 0; i < 60; i++) {
    scattered.push(entry(at(ORIGIN, 60 + (i % 10) * 190, 60 + Math.floor(i / 10) * 300)));
  }
  const result = propose(trim, dense.concat(scattered), { corridor: 12 });

  assert.ok(!result.error, result.error);
  // Whatever it decides, the count it reports is the count it measured.
  assert.equal(result.inside + result.outside, dense.length + scattered.length);
});

// ── Corridors ────────────────────────────────────────────────────────────────

/**
 * How much wider the proposal is than the two blobs it joins, as a rough
 * stand-in for "how much ground did the link cover".
 */
function linkCost(joined, apart) {
  return joined.areaAfter - apart;
}

test("a corridor goes straight rather than round by road", () => {
  // A road that loops the long way round is exactly what the first version
  // followed, and the arm it drew went with it. The link is not a route
  // anybody walks — it is the ground between two parts of one territory — so
  // the straight line is both the right answer and the cheapest one.
  const houses = village(300, 900, 5, 5);
  const farm = entry(at(ORIGIN, 1500, 900));

  const plain = load();
  const withRoads = load({ streets: ringRoad(200, 200, 1600, 100) });

  const a = propose(plain, houses.concat([farm]));
  const b = propose(withRoads, houses.concat([farm]));

  assert.equal(a.outside, 0);
  assert.equal(b.outside, 0);
  // Same shape either way: the street network is not consulted for links.
  assert.ok(
    Math.abs(a.areaAfter - b.areaAfter) < a.areaAfter * 0.02,
    `roads should not change the link: ${Math.round(a.areaAfter)} m² vs ${Math.round(b.areaAfter)} m²`,
  );
});

test("the corridor is a wedge, not a constant-width strip", () => {
  // A 12 m corridor tapering up to a 60 m reach over 1200 m covers roughly
  // half of what a 60 m-wide band would. The check is deliberately loose —
  // what matters is that it is nowhere near the band.
  const trim = load();
  const houses = village(300, 900, 5, 5);
  const farm = entry(at(ORIGIN, 1500, 900));

  const apart = propose(trim, houses).areaAfter + propose(trim, [farm]).areaAfter;
  const joined = propose(trim, houses.concat([farm]));
  const band = 1200 * 2 * 60;

  assert.ok(linkCost(joined, apart) < band * 0.7,
    `the link cost ${Math.round(linkCost(joined, apart))} m², a full-width band would be ~${band}`);
  assert.ok(linkCost(joined, apart) > 0, "and it did cost something");
});

// ── Holes ────────────────────────────────────────────────────────────────────

test("the proposal is a single ring, whatever the buildings do", () => {
  // Houses around the edge of a big empty field. The reach closes around the
  // outside and leaves the middle unmarked, which is a hole — and a territory
  // boundary with a hole in it is one somebody has to explain. On a printed
  // card the walker cannot tell an intentional exclusion from an artefact, and
  // this is an artefact.
  const trim = load();
  const ring = [];
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    ring.push(entry(at(ORIGIN, 1000 + Math.cos(angle) * 400, 1000 + Math.sin(angle) * 400)));
  }
  const result = propose(trim, ring);

  assert.ok(!result.error, result.error);
  assert.equal(result.feature.geometry.coordinates.length, 1, "no interior rings");
  assert.equal(result.outside, 0);
});

test("a corridor to a kept farm leaves no ring behind it either", () => {
  const trim = load();
  const houses = village(300, 900, 5, 5);
  const farm = entry(at(ORIGIN, 1700, 300));
  const result = propose(trim, houses.concat([farm]));
  assert.equal(result.feature.geometry.coordinates.length, 1);
});

// ── Limits ───────────────────────────────────────────────────────────────────

test("the proposal never reaches outside the existing boundary", () => {
  const trim = load();
  // Houses pressed against the eastern edge, with a reach that would spill
  // over it. Trimming removes area; it must never add any.
  const keep = village(1900, 900, 3, 3);
  const result = propose(trim, keep, { reach: 150 });

  const bounds = turf.bbox(OUTER);
  turf.bbox(result.feature).forEach((value, i) => {
    if (i < 2) assert.ok(value >= bounds[i] - 1e-9, "spilled south or west");
    else assert.ok(value <= bounds[i] + 1e-9, "spilled north or east");
  });
  assert.ok(result.areaAfter <= result.areaBefore);
});

test("ignoring everything is refused rather than answered with an empty shape", () => {
  const trim = load();
  assert.deepEqual(propose(trim, []), { error: "noKeep" });
});

test("a single building still produces a usable shape around it", () => {
  const trim = load();
  const one = entry(at(ORIGIN, 1000, 1000));
  const result = propose(trim, [one]);

  assert.ok(!result.error, result.error);
  assert.equal(result.inside, 1);
  // A 60 m reach is roughly 11 000 m² of disc; the staircase approximates it
  // from outside, so anything in the same order of magnitude is right.
  assert.ok(result.areaAfter > 8000 && result.areaAfter < 20000,
    `${Math.round(result.areaAfter)} m² around one house`);
});

// ── Following the streets ────────────────────────────────────────────────────

test("with follow on, the boundary sits on the road instead of behind the houses", () => {
  // A village with a ring road round it, ten meters outside where a 60 m reach
  // would otherwise put the edge. The whole point of the feature is that the
  // boundary jumps that last ten meters onto the road: an edge that runs along
  // a street is one somebody can stand on and see, and a staircase through the
  // back gardens is not.
  const trim = load({ streets: ringRoad(730, 730, 260) });
  const keep = village(800, 800, 4, 4);

  const behind = propose(trim, keep, { follow: false });
  const along = propose(trim, keep, { follow: true });

  assert.ok(!along.error, along.error);
  assert.ok(onRoad(along) > 0.8, `only ${Math.round(onRoad(along) * 100)}% of the edge landed on a road`);
  assert.ok(
    onRoad(along) > onRoad(behind) + 0.5,
    "following streets should move far more of the edge onto them",
  );
  assert.equal(along.outside, 0, "and it must not leave a house behind");
});

test("following streets still never reaches outside the boundary", () => {
  const trim = load({ streets: ringRoad(730, 730, 260) });
  const result = propose(trim, village(800, 800, 4, 4), { follow: true });
  const bounds = turf.bbox(OUTER);
  turf.bbox(result.feature).forEach((value, i) => {
    if (i < 2) assert.ok(value >= bounds[i] - 1e-9);
    else assert.ok(value <= bounds[i] + 1e-9);
  });
});

test("with no streets downloaded, the shape falls back to the raster ring", () => {
  const trim = load({ streets: [] });
  const result = propose(trim, village(800, 800, 4, 4), { follow: true });
  assert.ok(!result.error, result.error);
  assert.equal(result.outside, 0);
});

test("the areas reported are the shapes actually measured", () => {
  const trim = load();
  const result = propose(trim, village(800, 800, 5, 5));
  assert.ok(Math.abs(result.areaBefore - planarArea(OUTER)) < 1);
  assert.ok(Math.abs(result.areaAfter - planarArea(result.feature)) < 1);
});

// ── Edge detail ──────────────────────────────────────────────────────────────

/** Corners in a proposal, which is what the detail slider is spending. */
function corners(result) {
  return outerRing(result.feature).length - 1;
}

test("more detail tolerance means a simpler edge", () => {
  const trim = load();
  // A ragged edge on purpose: houses on alternating offsets, so the raster
  // traces a bay between every pair and there is something to straighten.
  const keep = [];
  for (let i = 0; i < 14; i++) {
    keep.push(entry(at(ORIGIN, 700 + i * 45, 900 + (i % 2) * 90)));
  }

  const exact = propose(trim, keep, { detail: 0 });
  const smooth = propose(trim, keep, { detail: 40 });

  assert.ok(corners(exact) > 12, `the fixture should be ragged, got ${corners(exact)} corners`);
  assert.ok(
    corners(smooth) < corners(exact) * 0.7,
    `straightening should cost corners: ${corners(exact)} → ${corners(smooth)}`,
  );
  assert.equal(smooth.outside, 0, "and must not straighten a house out of the area");
});

test("the corner count is reported so the slider has a readout", () => {
  const trim = load();
  const result = propose(trim, village(800, 800, 5, 5));
  assert.equal(result.vertices, corners(result));
});

test("detail is capped so simplification cannot reach the buildings", () => {
  // Simplification moves the edge inward by up to its own tolerance, and the
  // raster only promises `reach` meters of clearance. 15 of those meters are
  // held back, so the cap is what keeps the safety argument true at every
  // slider position rather than only at the default one.
  const trim = load();
  assert.equal(trim.detailM(60, 200), 45, "asking for more does not buy more");
  assert.equal(trim.detailM(60, 10), 10, "asking for less is honoured");
  assert.equal(trim.detailM(20, 40), 5, "a narrow reach pulls the ceiling down");
  assert.equal(trim.detailM(10, 40), 0, "and can close it entirely");
});

// ── Outliers ─────────────────────────────────────────────────────────────────

test("nothing is marked in a village that is merely spread out", () => {
  // Plots 80 m apart, which the first version of this called isolated and
  // marked wholesale — on exactly the rural areas these cards are printed
  // for. Uniform spacing means nothing here is unusual.
  const trim = load();
  assert.deepEqual(trim.outliersIn(village(600, 600, 8, 8, 80)), []);
});

test("the farm at the end of the track is marked, and only it", () => {
  const trim = load();
  const houses = village(600, 600, 6, 6, 40);
  const farm = entry(at(ORIGIN, 1700, 1700));

  const marked = trim.outliersIn(houses.concat([farm]));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].key, farm.key);
});

test("the decision does not depend on what is already excluded", () => {
  // The first version excluded as it went and let later buildings see the
  // thinned-out result, so marks cascaded outward from the first sparse
  // corner and a second press marked a different, larger set than the first.
  // Answering over the whole set is what makes the button idempotent.
  const trim = load();
  const all = village(600, 600, 6, 6, 40).concat([
    entry(at(ORIGIN, 1700, 1700)),
    entry(at(ORIGIN, 200, 1700)),
  ]);

  const first = trim.outliersIn(all);
  assert.equal(first.length, 2);
  assert.deepEqual(trim.outliersIn(all).map((e) => e.key), first.map((e) => e.key));
});

test("a hamlet far from the village is marked, all of it", () => {
  // The case the per-building rule could not see. Five houses sitting together
  // have each other, so every one of them looked perfectly well connected —
  // and the boundary went on reaching a kilometre and a half to collect them.
  const trim = load();
  const houses = village(400, 400, 6, 6, 40);
  const hamlet = [];
  for (let i = 0; i < 5; i++) hamlet.push(entry(at(ORIGIN, 1700 + (i % 3) * 35, 1600 + Math.floor(i / 3) * 35)));

  const marked = trim.outliersIn(houses.concat(hamlet));
  assert.equal(marked.length, hamlet.length, `expected the whole hamlet, got ${marked.length}`);
  const keys = new Set(marked.map((e) => e.key));
  hamlet.forEach((e) => assert.ok(keys.has(e.key), "every house in it goes together"));
});

test("half a hamlet is never marked without the other half", () => {
  // Whatever the answer is, it is the same for every building in one place. A
  // boundary drawn around three houses of five is not a shape anybody meant.
  const trim = load();
  const houses = village(400, 400, 6, 6, 40);
  const hamlet = [];
  for (let i = 0; i < 4; i++) hamlet.push(entry(at(ORIGIN, 1500 + i * 30, 1500)));

  const marked = new Set(trim.outliersIn(houses.concat(hamlet)).map((e) => e.key));
  const inside = hamlet.filter((e) => marked.has(e.key)).length;
  assert.ok(inside === 0 || inside === hamlet.length, `${inside} of ${hamlet.length} is not an answer`);
});

test("two hamlets near each other but far from the village both go", () => {
  // Measured against the settlement rather than against whatever happens to
  // be nearest: two hamlets three hundred metres apart and two kilometres out
  // would otherwise vouch for each other and both stay.
  const trim = load();
  const houses = village(300, 300, 6, 6, 40);
  const a = [0, 1, 2].map((i) => entry(at(ORIGIN, 1600 + i * 30, 1500)));
  const b = [0, 1, 2].map((i) => entry(at(ORIGIN, 1900 + i * 30, 1500)));

  const marked = trim.outliersIn(houses.concat(a, b));
  assert.equal(marked.length, a.length + b.length);
});

test("a second village too big to be an accident is left alone", () => {
  // Fifty houses two kilometres away is a place, not an outlier. Dropping it
  // automatically would be the tool making a decision that costs somebody a
  // hundred addresses; the box-drag is right there for saying so by hand.
  const trim = load();
  const houses = village(200, 200, 6, 6, 40);
  const other = village(1400, 1400, 7, 7, 40);

  assert.deepEqual(trim.outliersIn(houses.concat(other)), []);
});

test("a hamlet just outside the village is close enough to keep", () => {
  // Small is only half the test. A cluster of four a couple of plots beyond
  // the last street is the edge of the village, and marking it would be the
  // tool trimming the thing it was pointed at.
  const trim = load();
  const houses = village(400, 400, 6, 6, 40);
  const edge = [0, 1, 2, 3].map((i) => entry(at(ORIGIN, 700 + (i % 2) * 30, 400 + Math.floor(i / 2) * 30)));

  assert.deepEqual(trim.outliersIn(houses.concat(edge)), []);
});

test("a dense terrace has no outliers, however tight the spacing", () => {
  // Median spacing of 8 m; three times that is still the house next door, so
  // a purely relative rule would start marking corner plots. The absolute
  // floor is what stops it.
  const trim = load();
  const terrace = [];
  for (let i = 0; i < 30; i++) terrace.push(entry(at(ORIGIN, 800 + i * 8, 900)));
  assert.deepEqual(trim.outliersIn(terrace), []);
});

test("two buildings are never enough to call one of them unusual", () => {
  const trim = load();
  assert.deepEqual(trim.outliersIn([entry(at(ORIGIN, 100, 100))]), []);
  assert.deepEqual(
    trim.outliersIn([entry(at(ORIGIN, 100, 100)), entry(at(ORIGIN, 1800, 1800))]),
    [],
  );
});

// ── The sample the tour runs on ──────────────────────────────────────────────

test("the demo village has something for the trim step to actually trim", () => {
  // The tour opens this tool on the sample, and before the outfield existed
  // the sample was a tidy grid with the boundary pulled tight around it —
  // nothing to exclude, nothing to remove, a tool visibly doing nothing on the
  // one screen where somebody is learning what it is for.
  //
  // The farms are found by the outlier pass's own rule, not by anything rigged
  // here, which is what makes the step honest: if the rule is retuned and they
  // stop being outliers, this fails rather than the walkthrough quietly going
  // inert again.
  const window = {};
  const App = loadApp(["spatial.js", "coverage.js", "demo.js"], {
    window,
    document: {},
    turf,
    L,
  });
  App.i18n = { t: (key) => key };
  App.data = { PAYLOAD_VERSION: 3 };
  App.state = {};

  const buildings = App.demo.payload().buildings.features;
  const farms = buildings.filter((f) => f.properties.building === "farm");
  assert.equal(farms.length, 3, "the outfield should be in the sample");

  const trim = load();
  const entries = buildings.map((f) => {
    const ring = f.geometry.coordinates[0];
    const lng = (ring[0][0] + ring[2][0]) / 2;
    const lat = (ring[0][1] + ring[2][1]) / 2;
    return { centroid: [lng, lat], key: f.properties["addr:housenumber"] + "/" + f.properties["addr:street"], feature: f, big: false };
  });

  const marked = trim.outliersIn(entries);
  assert.equal(marked.length, 3, `expected the three farms, got ${marked.length}`);
  marked.forEach((entry) => {
    assert.equal(entry.feature.properties.building, "farm", "only the farms");
  });
});

test("the demo boundary is wide enough that trimming it is worth doing", () => {
  const window = {};
  const App = loadApp(["spatial.js", "coverage.js", "demo.js"], {
    window,
    document: {},
    turf,
    L,
  });
  App.i18n = { t: (key) => key };
  App.data = { PAYLOAD_VERSION: 3 };
  App.state = {};

  const payload = App.demo.payload();
  const ring = payload.outerPolygon.geometry.coordinates[0];
  const east = Math.max(...ring.map((c) => c[0]));
  const farms = payload.buildings.features.filter((f) => f.properties.building === "farm");
  farms.forEach((f) => {
    f.geometry.coordinates[0].forEach((c) => {
      assert.ok(c[0] <= east, "a farm outside the boundary would be filtered out of the pool");
    });
  });
  // And there is a track out to them, or they sit in a field with no way in.
  assert.ok(payload.streets.features.length > 9, "the track should be there too");
});
