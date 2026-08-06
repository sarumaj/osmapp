/**
 * The dwelling classifier decides what cleanup is allowed to throw away.
 * A wrong answer here silently deletes somebody's street, so every branch of
 * the decision table gets a case.
 */
const test = require("node:test");
const assert = require("node:assert");
const { load, square } = require("./conftest.js");

const ctx = load(["js/spatial.js", "js/geometry.js"]);

// editing.js touches Leaflet and the DOM only inside handlers, so stubs are
// enough to get init() through and the pure logic reachable.
ctx.document = { addEventListener() {} };
ctx.App.state = { cachedBuildings: null, cachedStreets: null, clusters: [] };
ctx.App.dom = { role: () => null, text() {}, toggle() {}, toggleClass() {} };
ctx.App.i18n = { t: (key) => key };
ctx.App.ui = { showBusy() {}, hideOverlay() {}, setOverlayStatus() {} };
ctx.App.polygons = { clusterFeatures: () => [], clusterLayers: () => [], setClusters() {} };
ctx.App.history = { push() {} };

const fs = require("fs");
const path = require("path");
const vm = require("vm");
vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "..", "src", "osmapp", "static", "js", "editing.js"),
    "utf8",
  ),
  ctx,
  { filename: "js/editing.js" },
);
ctx.App.editing.init();

const { dwellingScore, isDisposable } = ctx.App.editing._test;

/** A building of `metres` a side with the given OSM tags. */
function building(tags, metres) {
  const f = square(8.7, 48.89, metres || 12);
  f.properties = tags || {};
  return f;
}

test("tagged dwellings score 1", () => {
  for (const tag of ["apartments", "house", "detached", "residential", "farm"]) {
    assert.equal(dwellingScore(building({ building: tag })), 1, tag);
  }
});

test("tagged outbuildings score 0", () => {
  for (const tag of ["barn", "garage", "silo", "greenhouse", "water_tower"]) {
    // Large on purpose: the tag must win over the footprint heuristic.
    assert.equal(dwellingScore(building({ building: tag }, 40)), 0, tag);
  }
});

test("an address outranks an outbuilding tag", () => {
  // Deliberate: for door-to-door work an address is a door. Erring this way
  // keeps land rather than discarding it.
  const converted = building({ building: "barn", "addr:housenumber": "7" }, 40);
  assert.equal(dwellingScore(converted), 1);
});

test("building:levels promotes but never demotes", () => {
  assert.equal(
    dwellingScore(building({ building: "yes", "building:levels": "3" })),
    1,
    "three storeys is a dwelling",
  );
  // One storey is not evidence against a dwelling — a 144 m2 single-storey
  // building is a bungalow. It falls through to the footprint test and stays
  // unclear rather than being demoted.
  assert.equal(
    dwellingScore(building({ building: "yes", "building:levels": "1" }, 12)),
    0.5,
    "single storey, house-sized, stays unclear",
  );
  assert.equal(
    dwellingScore(building({ building: "yes", "building:levels": "1" }, 5)),
    0,
    "single storey and tiny is an outbuilding",
  );
});

test("footprint decides when nothing else does", () => {
  assert.equal(dwellingScore(building({ building: "yes" }, 5)), 0, "5m box is a shed");
  assert.equal(dwellingScore(building({ building: "yes" }, 12)), 0.5, "12m is unclear");
  assert.equal(dwellingScore(building({}, 12)), 0.5, "no tag at all is unclear");
});

test("commercial tags stay unclear rather than excluded", () => {
  // If a retail park should never be visited, move these into
  // NON_DWELLING_TAGS — the classifier deliberately does not assume.
  assert.equal(dwellingScore(building({ building: "commercial" }, 30)), 0.5);
  assert.equal(dwellingScore(building({ building: "retail" }, 30)), 0.5);
});

test("the score is cached on the feature", () => {
  const b = building({ building: "house" });
  dwellingScore(b);
  assert.equal(b._dwelling, 1);
});

test("disposal: no buildings at all is waste", () => {
  assert.equal(isDisposable({ dwellings: 0, unsure: 0, buildings: 0, hectares: 4 }), true);
});

test("disposal: only outbuildings is waste regardless of density", () => {
  assert.equal(isDisposable({ dwellings: 0, unsure: 0, buildings: 9, hectares: 0.5 }), true);
});

test("disposal: a sparse farmstead is waste, a hamlet is not", () => {
  assert.equal(isDisposable({ dwellings: 0, unsure: 2, buildings: 2, hectares: 5 }), true);
  assert.equal(isDisposable({ dwellings: 0, unsure: 6, buildings: 6, hectares: 2 }), false);
});

test("SAFETY: a confirmed dwelling is never disposable", () => {
  for (const unsure of [0, 5, 50]) {
    for (const hectares of [0.01, 1, 100]) {
      assert.equal(
        isDisposable({ dwellings: 1, unsure, buildings: 1 + unsure, hectares }),
        false,
        `dwellings=1 unsure=${unsure} ha=${hectares}`,
      );
    }
  }
});

test("disposal: zero area with ambiguous buildings is kept", () => {
  // Guards a divide-by-zero that would otherwise read as infinitely sparse.
  assert.equal(isDisposable({ dwellings: 0, unsure: 1, buildings: 1, hectares: 0 }), false);
});
