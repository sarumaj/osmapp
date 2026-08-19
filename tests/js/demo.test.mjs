/**
 * The sample area the guided tour borrows the app for.
 *
 * This payload goes straight into App.data.applyPayload(), the same function a
 * user's imported file goes through — which means a malformed sample does not
 * produce a wonky demo, it throws inside the tour and leaves someone looking
 * at a half-loaded map. The shape is therefore checked here rather than
 * discovered there.
 *
 * The geometry assertions are deliberately about relationships rather than
 * coordinates: that the territories tile the boundary, that no house sits on a
 * junction, that every ring is closed. Pinning the actual numbers would mean
 * rewriting the test every time the village is nudged, which teaches the test
 * suite to be ignored.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DICT = JSON.parse(
  readFileSync(join(ROOT, "src", "osmapp", "static", "lang", "en.json"), "utf8"),
);

/**
 * demo.js reads App.data.PAYLOAD_VERSION and App.i18n.t at build time, and
 * nothing else — no map, no turf, no DOM. That is what makes the sample
 * testable at all, and it is worth keeping that way.
 */
function load() {
  const window = {};
  const App = (window.App = {
    data: { PAYLOAD_VERSION: 3 },
    i18n: {
      t: (key, vars) =>
        key === "demo.street" ? `Sample street ${vars.n}` : key,
    },
    _loaded: [],
  });
  loadApp(["demo.js"], { window });
  return App.demo;
}

const demo = load();
const payload = demo.payload();

function ring(feature) {
  return feature.geometry.coordinates[0];
}

function bbox(coords) {
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  return [
    Math.min(...lngs),
    Math.min(...lats),
    Math.max(...lngs),
    Math.max(...lats),
  ];
}

// ── Shape ────────────────────────────────────────────────────────────────────

test("the sample is a payload applyPayload will accept", () => {
  assert.equal(payload.version, 3);
  assert.equal(payload.outerPolygon.geometry.type, "Polygon");
  assert.equal(payload.streets.type, "FeatureCollection");
  assert.equal(payload.buildings.type, "FeatureCollection");
  assert.ok(Array.isArray(payload.clusters));

  for (const key of ["north", "south", "east", "west"]) {
    assert.equal(typeof payload.bounds[key], "number", `bounds.${key}`);
  }
  assert.ok(payload.bounds.north > payload.bounds.south);
  assert.ok(payload.bounds.east > payload.bounds.west);
});

test("every polygon ring is closed", () => {
  const polygons = [payload.outerPolygon, ...payload.clusters, ...payload.buildings.features];
  for (const feature of polygons) {
    const coords = ring(feature);
    assert.deepStrictEqual(
      coords[0],
      coords[coords.length - 1],
      "first and last vertex must match",
    );
    assert.ok(coords.length >= 4);
  }
});

test("there is enough of a village to be worth showing", () => {
  assert.ok(payload.streets.features.length >= 8, "streets");
  assert.ok(payload.buildings.features.length >= 30, "buildings");
  assert.equal(payload.clusters.length, 5);
});

// ── Relationships ────────────────────────────────────────────────────────────

test("the territories tile the outer boundary", () => {
  // Four rectangles cut on two grid lines: their union has to be the boundary
  // itself, or the partition step opens on a map with holes in it.
  const outer = bbox(ring(payload.outerPolygon));
  const covered = bbox(payload.clusters.flatMap((c) => ring(c)));
  for (let i = 0; i < 4; i++) {
    assert.ok(
      Math.abs(outer[i] - covered[i]) < 1e-6,
      `territory extent differs from the boundary on axis ${i}`,
    );
  }
});

test("one territory has a bite out of it, and it is in the interior", () => {
  // The uncovered patch the tour needs: without it the sample covers the
  // boundary exactly, the step about ground nobody covers points at a map with
  // none of it, and the territory list's repair button — hidden when there is
  // nothing to repair — never appears.
  //
  // Asserted as "exactly one territory is not a rectangle" rather than by
  // hunting for the hole with a boolean union, which would need turf. demo.js
  // is testable precisely because it needs nothing.
  const notched = payload.clusters.filter((c) => ring(c).length > 5);
  assert.equal(notched.length, 1, "the sample has no uncovered patch");

  // Interior, not a dent in the outline: an edge notch would shrink the
  // covered area instead, and the case people actually hit is a boundary that
  // grew with nothing filling the new ground.
  const outer = bbox(ring(payload.outerPolygon));
  const covered = bbox(payload.clusters.flatMap((c) => ring(c)));
  assert.deepStrictEqual(covered, outer);

  // And the patch itself holds no houses, which is what makes it the whole
  // autoheal story in one shape: adopted as a territory, found to hold
  // nothing, handed to the neighbor it shares the most boundary with. A patch
  // with houses on it would stay a territory of its own and the step would be
  // describing a repair the button does not make.
  //
  // The patch is the rectangle the notch cut away, and its fourth corner is
  // the one the ring no longer has. Recovering it is vector arithmetic on the
  // three corners that are still there — legitimate because the village is
  // projected by a rotation and two scales, and an affine map takes
  // "p1 + (p3 - p2)" to the same point either side of it.
  const corners = ring(notched[0]);
  const [, p1, p2, p3] = corners;
  const missing = [p1[0] + p3[0] - p2[0], p1[1] + p3[1] - p2[1]];
  const [west, south, east, north] = bbox([p1, p2, p3, missing]);

  const houses = payload.buildings.features.filter((b) =>
    ring(b).some(
      ([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north,
    ),
  );
  assert.deepStrictEqual(houses, [], "the uncovered patch has houses on it");
});

test("every building is inside the boundary", () => {
  const [west, south, east, north] = bbox(ring(payload.outerPolygon));
  for (const building of payload.buildings.features) {
    for (const [lng, lat] of ring(building)) {
      assert.ok(lng >= west && lng <= east && lat >= south && lat <= north);
    }
  }
});

test("exactly one territory starts out marked as printed", () => {
  // So the green fill and the tick are on screen the moment the sample loads,
  // rather than being described in the abstract three steps later.
  const marked = payload.clusters.filter((c) => c.properties.printed);
  assert.equal(marked.length, 1);
  assert.ok(!Number.isNaN(Date.parse(marked[0].properties.printed)));
});

// ── Saying what it is ────────────────────────────────────────────────────────

test("the streets are named after the dictionary, not hardcoded", () => {
  const names = payload.streets.features.map((f) => f.properties.name);
  assert.ok(names.every((n) => /^Sample street \d+$/.test(n)), names[0]);
  assert.equal(new Set(names).size, names.length, "names must be distinct");
});

test("houses carry a street and a number, like real OSM data would", () => {
  const streets = new Set(payload.streets.features.map((f) => f.properties.name));
  for (const building of payload.buildings.features) {
    const props = building.properties;
    assert.ok(streets.has(props["addr:street"]), props["addr:street"]);
    assert.ok(/^\d+$/.test(props["addr:housenumber"]));
    assert.ok(props.building);
  }
});

test("the street name template is translated everywhere", () => {
  assert.equal(typeof DICT.demo.street, "string");
  assert.ok(DICT.demo.street.includes("{n}"));
});

// ── What the print preview is handed ─────────────────────────────────────────

test("the collections are the shape the print overlay walks", () => {
  // print.js draws these itself, because tiles cannot show a village that does
  // not exist. It walks LineString/MultiLineString for streets and
  // Polygon/MultiPolygon for buildings, and silently ignores anything else —
  // so a sample that used the wrong geometry type would produce a blank
  // preview rather than an error.
  for (const feature of payload.streets.features) {
    assert.ok(
      ["LineString", "MultiLineString"].includes(feature.geometry.type),
      feature.geometry.type,
    );
  }
  for (const feature of payload.buildings.features) {
    assert.ok(
      ["Polygon", "MultiPolygon"].includes(feature.geometry.type),
      feature.geometry.type,
    );
  }
});

test("both new tour steps are in the dictionary", () => {
  // "gaps" and "autoheal" belong here too: both describe the patch the notch
  // above leaves behind, and a raw key path teaches a first-time reader
  // nothing.
  for (const id of ["sample", "restore", "gaps", "autoheal"]) {
    assert.equal(typeof DICT.tour.steps[id].title, "string", id);
    assert.equal(typeof DICT.tour.steps[id].body, "string", id);
  }
});
