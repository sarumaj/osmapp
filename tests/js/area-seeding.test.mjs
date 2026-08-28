/**
 * Why "split by area" clusters the ground and not the buildings.
 *
 * ── The claim ─────────────────────────────────────────────────────────────
 *
 * K-means gives you cells of equal area only when the points it is given are
 * spread evenly over that area. Hand it the buildings of a village — three
 * dense cores and a scatter of outlying farms — and it converges on the
 * buildings instead: the cores get a centroid each few hundred metres and the
 * fields get one centroid between them, so the territories come out wildly
 * unequal in ground however the dialog labelled the run.
 *
 * So phase 0 seeds the two modes differently. Splitting by buildings clusters
 * the building centroids; splitting by area clusters a uniform sample of the
 * polygon, taken with turf.pointGrid at a spacing derived from the area, and
 * the balance pass then trims what street routing knocks out of true.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 *
 * The gap between those two seedings, measured where it shows up: the areas of
 * the clipped Voronoi cells the centroids produce, which is the skeleton every
 * later phase works from. Both halves are run through the real turf over the
 * same polygon and the same k, so the comparison is of seedings and nothing
 * else.
 *
 * The thresholds are loose — 20x and 5x against measurements of 208x and 2.6x.
 * What is pinned is that building-seeded cells are grossly uneven in area and
 * ground-seeded ones are not, which is the claim the mode split rests on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadTurf } from "./helpers/turf.mjs";

const turf = loadTurf();

const AREA = turf.polygon([
  [[13.0, 52.5], [13.05, 52.5], [13.05, 52.53], [13.0, 52.53], [13.0, 52.5]],
]);
const K = 24;
const SAMPLES_PER_TERRITORY = 25; // matches _groundSample in clustering.js

function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** phase 1's shuffle — see _shuffled in clustering.js. */
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

/** A village: three dense cores and two hundred outlying farms. */
function buildings() {
  const r = rng(3);
  const points = [];
  for (const [x, y] of [[13.005, 52.505], [13.010, 52.508], [13.008, 52.503]]) {
    for (let i = 0; i < 400; i++) {
      points.push(turf.point([x + (r() - 0.5) * 0.003, y + (r() - 0.5) * 0.002]));
    }
  }
  for (let i = 0; i < 200; i++) {
    points.push(turf.point([13.0 + r() * 0.05, 52.5 + r() * 0.03]));
  }
  return points;
}

/** _groundSample from clustering.js, spacing formula and all. */
function groundSample() {
  const spacing = Math.sqrt(turf.area(AREA) / (K * SAMPLES_PER_TERRITORY));
  return turf.pointGrid(turf.bbox(AREA), spacing, {
    units: "meters",
    mask: AREA,
  }).features;
}

/**
 * Phases 1 and 2 over a given seeding: cluster, Voronoi, clip, measure.
 *
 * The longitude scaling is phase 1's — without it a degree of longitude counts
 * as long as a degree of latitude and the cells come out stretched, which
 * would show up here as an area spread that has nothing to do with seeding.
 */
function cellAreas(seedPoints) {
  const M = 111320;
  const lat0 =
    seedPoints.reduce((sum, p) => sum + p.geometry.coordinates[1], 0) /
    seedPoints.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);

  const projected = seedPoints.map((p) => {
    const c = p.geometry.coordinates;
    return turf.point([c[0] * kx, c[1]]);
  });

  const clustered = turf.clustersKmeans(
    turf.featureCollection(shuffled(projected, 0x5eed)),
    { numberOfClusters: K },
  );

  const byCluster = new Map();
  for (const f of clustered.features) {
    if (!byCluster.has(f.properties.cluster)) {
      byCluster.set(f.properties.cluster, f.properties.centroid);
    }
  }
  const centroids = [...byCluster.values()].map((c) =>
    turf.point([c[0] / kx, c[1]]),
  );

  const box = turf.bbox(AREA);
  const pad = Math.max(box[2] - box[0], box[3] - box[1]) * 0.1;
  const cells = turf.voronoi(turf.featureCollection(centroids), {
    bbox: [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad],
  });

  const areas = [];
  for (const cell of cells.features) {
    if (!cell) continue;
    try {
      const clipped = turf.intersect(turf.featureCollection([cell, AREA]));
      if (clipped) areas.push(turf.area(clipped));
    } catch (e) {
      /* a cell turf cannot clip contributes no area */
    }
  }
  return areas.sort((a, b) => a - b);
}

test("clustering the buildings does not give territories of equal area", () => {
  // The reason the mode needed its own seeding. If this ever comes out even,
  // the village fixture has stopped being a village.
  const areas = cellAreas(buildings());
  const ratio = areas[areas.length - 1] / areas[0];

  assert.ok(
    ratio > 20,
    `building-seeded cells should be grossly uneven in area, got ${ratio.toFixed(1)}x ` +
      `(${Math.round(areas[0])} to ${Math.round(areas[areas.length - 1])} m²)`,
  );
});

test("clustering a ground sample does", () => {
  const areas = cellAreas(groundSample());
  const ratio = areas[areas.length - 1] / areas[0];

  assert.equal(areas.length, K, "every territory asked for should get ground");
  assert.ok(
    ratio < 5,
    `ground-seeded cells should be near enough equal, got ${ratio.toFixed(1)}x ` +
      `(${Math.round(areas[0])} to ${Math.round(areas[areas.length - 1])} m²)`,
  );
});

test("the ground sample scales with the territory count, not the map", () => {
  // The spacing is derived from the area so a hamlet and a city both get about
  // the same samples per territory. A fixed spacing would give a large
  // boundary a hundred-thousand-point clustering and a small one too few
  // points to form k clusters at all.
  const spacing = (k) => Math.sqrt(turf.area(AREA) / (k * SAMPLES_PER_TERRITORY));
  const count = (k) =>
    turf.pointGrid(turf.bbox(AREA), spacing(k), { units: "meters", mask: AREA })
      .features.length;

  for (const k of [8, 24, 100]) {
    const perTerritory = count(k) / k;
    assert.ok(
      perTerritory > 10 && perTerritory < 60,
      `k=${k} should sample roughly ${SAMPLES_PER_TERRITORY} points a territory, got ${perTerritory.toFixed(1)}`,
    );
  }
});
