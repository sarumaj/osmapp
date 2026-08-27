/**
 * Why clustering.js shuffles its points before handing them to turf.
 *
 * ── The behavior being pinned ─────────────────────────────────────────────
 *
 * The vendored turf seeds skmeans with `coordAll(points).slice(0, k)` — the
 * first k features in array order. Not a sample, not k-means++, not random:
 * whichever k buildings happen to come first in the collection.
 *
 * That is fine for points in no particular order and ruinous for the order the
 * app actually receives. Buildings arrive from Overpass in OSM id order, ids
 * run in contiguous blocks per import, so the first k of them sit in one
 * corner of the map. Lloyd's iteration moves a centroid only toward points
 * already assigned to it, so it cannot walk one across a town it has no points
 * in — every centroid stays bunched where it started and one territory ends up
 * holding a whole neighborhood. clustering.js compensates by shuffling
 * deterministically in phase 1, which turns that slice back into the uniform
 * sample the algorithm assumes.
 *
 * ── Why this is a test and not a comment ──────────────────────────────────
 *
 * The shuffle is a workaround for someone else's code, so it has exactly the
 * failure mode workarounds have: the day turf changes its seeding, nothing in
 * this repository notices, and a line that looks load-bearing is either dead
 * weight or actively wrong. This test fails on that day and says which.
 *
 * The thresholds are deliberately loose — 8x and 4x against measurements of
 * 21x and 2.7x. What is being pinned is that ordered input clusters badly and
 * shuffled input does not, which is the claim phase 1 rests on. Pinning the
 * numbers themselves would make a turf patch release a red build.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

const TOTAL = 3000;
const K = 150;
const MEAN = TOTAL / K; // 20 buildings a territory, the app's default

/** Deterministic 0..1, so a failure names a case that can be generated again. */
function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * A town as Overpass hands it over: dense cores, sparse outskirts, and every
 * core's buildings contiguous in the array because they were imported together.
 */
function town() {
  const r = rng(11);
  const points = [];
  const cores = [];
  for (let i = 0; i < 6; i++) cores.push([13.0 + r() * 0.05, 52.5 + r() * 0.03]);
  for (const [x, y] of cores) {
    for (let i = 0; i < 400; i++) {
      points.push(turf.point([x + (r() - 0.5) * 0.004, y + (r() - 0.5) * 0.0025]));
    }
  }
  for (let i = 0; i < TOTAL - cores.length * 400; i++) {
    points.push(turf.point([13.0 + r() * 0.05, 52.5 + r() * 0.03]));
  }
  return points;
}

/** phase 1's shuffle, reproduced — see _shuffled in clustering.js. */
function shuffled(list, seed) {
  const out = list.slice();
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Cluster sizes, and how many of the k clusters got any points at all. */
function clusterSizes(points) {
  const result = turf.clustersKmeans(turf.featureCollection(points), {
    numberOfClusters: K,
  });
  const sizes = new Map();
  for (const f of result.features) {
    const id = f.properties.cluster;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
  }
  return [...sizes.values()];
}

test("turf still seeds k-means from the head of the input", () => {
  // The premise, shown directly rather than inferred from a skew.
  //
  // Five points a metre apart come first, then four groups of ten spread
  // across half a degree. Ask for five clusters. Seeded from the head, all
  // five centroids start inside that one metre — three of them keep a single
  // point each and the forty distant points have to share what is left, so
  // one cluster swallows most of the map. Seeded by sampling or by k-means++,
  // the distant groups would get centroids of their own and nothing would be
  // anywhere near that size.
  const points = [];
  for (let i = 0; i < 5; i++) {
    points.push(turf.point([13.0 + i * 1e-6, 52.5 + i * 1e-6]));
  }
  for (const [x, y] of [[13.1, 52.5], [13.2, 52.6], [13.3, 52.4], [13.4, 52.7]]) {
    for (let i = 0; i < 10; i++) points.push(turf.point([x + i * 1e-4, y + i * 1e-4]));
  }

  const result = turf.clustersKmeans(turf.featureCollection(points), {
    numberOfClusters: 5,
  });
  const sizes = new Map();
  for (const f of result.features) {
    const id = f.properties.cluster;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
  }

  assert.ok(
    Math.max(...sizes.values()) >= 20,
    `the seeds should all sit in the head, leaving one cluster holding half ` +
      `the map; sizes were ${[...sizes.values()].sort((a, b) => a - b)}`,
  );
});

test("input order alone wrecks the cluster sizes", () => {
  const sizes = clusterSizes(town());
  const max = Math.max(...sizes);

  assert.ok(
    max > MEAN * 8,
    `expected id-ordered input to produce a runaway cluster, largest was ${max} ` +
      `against a mean of ${MEAN} — if this is now balanced, turf fixed its ` +
      `seeding and _shuffled in clustering.js phase 1 can go`,
  );
});

test("shuffling the same points fixes it", () => {
  const sizes = clusterSizes(shuffled(town(), 0x5eed));
  const max = Math.max(...sizes);

  assert.ok(
    max < MEAN * 4,
    `expected shuffled input to cluster evenly, largest was ${max} against a ` +
      `mean of ${MEAN}`,
  );
  assert.equal(
    sizes.length,
    K,
    "every territory asked for should get buildings — duplicate seeds " +
      "collapse clusters away, and a collapsed cluster is a territory the " +
      "partition silently does not produce",
  );
});
