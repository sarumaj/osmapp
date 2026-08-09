/**
 * The street graph, now that two tools share it.
 *
 * It was private to the cut tool until the trim tool needed the same answers,
 * and shared code that nothing tests is how the two would have drifted apart
 * anyway — just in one file instead of two. What is worth pinning is the part
 * both callers reason about: routing returns the *shortest* path or nothing at
 * all, "nothing at all" includes two ends in different components, and the pop
 * budget is a real ceiling rather than a suggestion.
 *
 * Leaflet is stubbed down to the two things this module uses of it: a latLng
 * with a distanceTo. Everything else is arithmetic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const M_PER_DEG_LAT = 110540;

const L = {
  latLng(lat, lng) {
    return {
      lat,
      lng,
      distanceTo(other) {
        const kx = 111320 * Math.cos(((lat + other.lat) / 2 / 180) * Math.PI);
        const dx = (lng - other.lng) * kx;
        const dy = (lat - other.lat) * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
      },
    };
  },
};

/** One street from a list of [lng, lat] pairs. */
function street(coordinates) {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  };
}

function load(features) {
  const window = {};
  const App = loadApp(["spatial.js", "network.js"], {
    window,
    L,
    document: {},
  });
  App.state = {
    cachedStreets: { type: "FeatureCollection", features },
    CUT_ROUTE_MAX_POPS: 30000,
  };
  App.network.init();
  App.network.build(true);
  return App.network;
}

/**
 * A ladder: two parallel east-west streets joined by rungs, so there is always
 * more than one way round and "shortest" means something.
 *
 *   y=0.001  ──┬───┬───┬───┬──
 *   y=0.000  ──┴───┴───┴───┴──
 */
function ladder() {
  const xs = [0, 1, 2, 3, 4].map((i) => 19.9 + i * 0.001);
  const features = [
    street(xs.map((x) => [x, 50.0])),
    street(xs.map((x) => [x, 50.001])),
  ];
  xs.forEach((x) => features.push(street([[x, 50.0], [x, 50.001]])));
  return load(features);
}

// ── Build ────────────────────────────────────────────────────────────────────

test("building indexes every segment and dedupes shared nodes", () => {
  const N = ladder();
  const { segments, nodes } = N.stats();
  assert.equal(nodes, 10, "five rungs, two ends each");
  assert.equal(segments, 8 + 5, "four spans per rail, plus five rungs");
  assert.ok(N.isReady());
});

test("an empty download leaves an empty but usable graph", () => {
  const N = load([]);
  assert.deepEqual(N.stats(), { segments: 0, nodes: 0 });
  assert.equal(N.nearestNode([19.9, 50.0], 500), null);
  assert.equal(N.nearestSegmentPoint([19.9, 50.0], 500), null);
});

test("MultiLineString geometry is indexed part by part", () => {
  const N = load([
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [[19.9, 50.0], [19.901, 50.0]],
          [[19.902, 50.0], [19.903, 50.0]],
        ],
      },
    },
  ]);
  assert.equal(N.stats().segments, 2);
  assert.equal(N.stats().nodes, 4);
});

test("invalidate forces the next build to redo the work", () => {
  const N = ladder();
  N.invalidate();
  assert.equal(N.isReady(), false);
});

// ── Queries ──────────────────────────────────────────────────────────────────

test("nearestSegmentPoint lands on the line, not on its endpoints", () => {
  const N = load([street([[19.9, 50.0], [19.91, 50.0]])]);
  const hit = N.nearestSegmentPoint([19.905, 50.0005], 200);
  assert.ok(hit);
  assert.ok(Math.abs(hit.coord[0] - 19.905) < 1e-6, "should snap sideways");
  assert.ok(hit.dist < 60);
});

test("nothing within the radius is a miss, not the nearest thing anyway", () => {
  const N = load([street([[19.9, 50.0], [19.91, 50.0]])]);
  assert.equal(N.nearestSegmentPoint([19.905, 50.02], 100), null);
  assert.equal(N.nearestNode([19.905, 50.02], 100), null);
});

test("nearestNode returns a key that routing accepts", () => {
  const N = ladder();
  const hit = N.nearestNode([19.9011, 50.0001], 200);
  assert.ok(hit);
  assert.equal(N.nodeKey(N.nodeLatLng(hit.key)), hit.key);
});

// ── Routing ──────────────────────────────────────────────────────────────────

test("a route follows the graph and takes the shorter way round", () => {
  const N = ladder();
  const from = N.nearestNode([19.9, 50.0], 50).key;
  const to = N.nearestNode([19.904, 50.0], 50).key;

  const path = N.route(from, to);
  assert.ok(path, "the two ends are connected");
  // Straight along the bottom rail: four spans, no detour up and over.
  assert.equal(path.length, 5);
  const direct = path[0].distanceTo(path[path.length - 1]);
  assert.ok(Math.abs(N.pathLength(path) - direct) < 1);
});

test("a gap in the network is reported rather than bridged", () => {
  const N = load([
    street([[19.9, 50.0], [19.901, 50.0]]),
    street([[19.95, 50.0], [19.951, 50.0]]),
  ]);
  const from = N.nearestNode([19.9, 50.0], 50).key;
  const to = N.nearestNode([19.951, 50.0], 50).key;
  assert.equal(N.route(from, to), null);
});

test("routing to where you already are is not a route", () => {
  const N = ladder();
  const key = N.nearestNode([19.9, 50.0], 50).key;
  assert.deepEqual(N.route(key, key), [N.nodeLatLng(key)]);
});

test("an unknown key routes to null instead of throwing", () => {
  const N = ladder();
  const key = N.nearestNode([19.9, 50.0], 50).key;
  assert.equal(N.route(key, "0.00000,0.00000"), null);
  assert.equal(N.route("0.00000,0.00000", key), null);
});

test("the pop budget is a ceiling", () => {
  // One pop cannot cross a five-node ladder, and the answer to "I ran out" has
  // to be no path rather than a wrong one.
  const N = ladder();
  const from = N.nearestNode([19.9, 50.0], 50).key;
  const to = N.nearestNode([19.904, 50.001], 50).key;
  assert.equal(N.route(from, to, 1), null);
  assert.ok(N.route(from, to, 30000));
});

test("pathLength adds up the legs", () => {
  const N = ladder();
  const path = N.route(
    N.nearestNode([19.9, 50.0], 50).key,
    N.nearestNode([19.902, 50.0], 50).key,
  );
  let manual = 0;
  for (let i = 0; i < path.length - 1; i++) manual += path[i].distanceTo(path[i + 1]);
  assert.ok(Math.abs(N.pathLength(path) - manual) < 1e-9);
});
