/**
 * The territory numbers.
 *
 * This module exists because the info panel's count and the shapes on the map
 * disagree, so the first thing worth pinning is the two halves of that
 * disagreement: every counted territory gets a chip (a territory with no chip
 * is the original bug wearing a new hat), and a territory drawn in more than
 * one piece gets one chip per piece, all carrying the same number.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

// ── Stubs ────────────────────────────────────────────────────────────────────

/** Enough of a DOM element for the class toggling the chips do. */
function fakeElement() {
  const chip = {
    classes: new Set(),
    classList: {
      toggle: (name, on) => (on ? chip.classes.add(name) : chip.classes.delete(name)),
      contains: (name) => chip.classes.has(name),
    },
  };
  return { firstElementChild: chip };
}

function makeGroup() {
  const group = { layers: [] };
  group.addLayer = (layer) => group.layers.push(layer);
  group.removeLayer = (layer) => {
    const at = group.layers.indexOf(layer);
    if (at >= 0) group.layers.splice(at, 1);
  };
  group.clearLayers = () => {
    group.layers.length = 0;
  };
  group.addTo = () => group;
  return group;
}

/** Squares are enough: every geometry question here is about part counts. */
function square(x, y, size = 1) {
  return [
    [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
      [x, y],
    ],
  ];
}

function polygon(x, y, size) {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: square(x, y, size) },
    properties: {},
  };
}

function multiPolygon(parts, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "MultiPolygon", coordinates: parts.map((p) => square(...p)) },
    properties,
  };
}

const L = {
  featureGroup: makeGroup,
  latLng: (lat, lng) => ({ lat, lng }),
  marker: (latlng, options) => {
    const element = fakeElement();
    return { latlng, options, getElement: () => element };
  },
  divIcon: (options) => options,
};

const turf = {
  area: (f) => {
    const rings =
      f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    return rings.reduce((sum, ring) => {
      const [[x0, y0], [x1], , [, y2]] = ring[0];
      return sum + Math.abs(x1 - x0) * Math.abs(y2 - y0) * 1e10;
    }, 0);
  },
  bbox: (f) => {
    const xs = [];
    const ys = [];
    JSON.stringify(f.geometry.coordinates, (key, value) => {
      if (Array.isArray(value) && typeof value[0] === "number") {
        xs.push(value[0]);
        ys.push(value[1]);
      }
      return value;
    });
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  },
  pointOnFeature: (f) => {
    const ring =
      f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
    return { geometry: { coordinates: ring[0] } };
  },
  polygon: (rings) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: rings },
    properties: {},
  }),
};

/**
 * @param {Array} features
 * @param {{span?: number, editMode?: boolean}} [opts] `span` is how many
 *   pixels the map claims each degree covers, which is the only thing the
 *   "too small to see" flag is derived from.
 */
/**
 * Stand labels.js up over real geometry, with Leaflet reduced to a fake map.
 *
 * `opts.span` is the on-screen size the fake map reports for every territory, in
 * pixels: it is what decides the `tiny` flag, so a test picks it to sit either
 * side of TINY_TERRITORY_PX rather than by zooming anything.
 */
function setup(features, opts = {}) {
  const span = opts.span ?? 200;
  const window = {};
  const App = loadApp(["util.js", "state.js", "geometry.js", "labels.js"], { window, L, turf });

  const s = App.state;
  s.innerPolygonsLayerGroup = makeGroup();
  s.editMode = !!opts.editMode;
  s.leafletMap = {
    on: () => {},
    latLngToContainerPoint: (ll) => ({ x: ll.lng * span, y: ll.lat * span }),
  };
  s.clusters = features.map((feature) => ({ feature, layer: {}, counts: null }));

  App.i18n = { n: String, t: (key) => key, onChange: () => {} };
  App.polygons = {
    isPrinted: (f) => !!(f.properties && f.properties.printed),
    refreshStyle: () => {},
    proxied: [],
    attachProxyEvents(marker, layer, feature, onHover) {
      App.polygons.proxied.push({ marker, layer, feature, onHover });
    },
  };
  App.dom = {};
  App.labels.init();
  App.labels.refresh();
  return App;
}

const chips = (App) => App.state.innerPolygonsLayerGroup.layers;
const html = (App) => chips(App).map((m) => m.options.icon.html);

// ── One chip per counted territory ───────────────────────────────────────────

test("every counted territory gets a chip", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1), polygon(4, 0, 1)]);
  assert.equal(chips(App).length, 3);
  assert.equal(App.labels.rows().length, App.state.clusters.length);
});

test("chips are numbered from one, matching the tooltip", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  assert.ok(html(App)[0].includes(">1<"));
  assert.ok(html(App)[1].includes(">2<"));
});

test("a refresh replaces the chips rather than stacking them", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  App.labels.refresh();
  App.labels.refresh();
  assert.equal(chips(App).length, 2);
});

// ── Sharing the territories' layer group ─────────────────────────────────────

test("a refresh takes back its own markers and leaves everything else", () => {
  // The regression this exists for: the chips live in the same group as the
  // territory polygons, so a refresh that reached for clearLayers() would
  // clear the map.
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  const group = App.state.innerPolygonsLayerGroup;
  const territory = { notAChip: true };
  group.addLayer(territory);

  App.labels.refresh();

  assert.ok(group.layers.includes(territory), "the territory survived");
  assert.equal(group.layers.length, 3, "two chips and the territory");
});

test("switching the numbers off removes the chips and nothing else", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  const group = App.state.innerPolygonsLayerGroup;
  const territory = { notAChip: true };
  group.addLayer(territory);

  App.labels.setVisible(false);
  assert.deepEqual(group.layers, [territory]);
  assert.equal(App.labels.isVisible(), false);

  App.labels.setVisible(true);
  assert.equal(group.layers.length, 3);
});

// ── The chip is a handle on the shape ────────────────────────────────────────

test("a chip is wired to its territory, not to itself", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  const proxied = App.polygons.proxied;

  assert.equal(proxied.length, 2, "one wiring per chip");
  proxied.forEach((call, i) => {
    assert.equal(call.marker, chips(App)[i]);
    assert.equal(call.layer, App.state.clusters[i].layer, "acts on the shape");
    assert.equal(call.feature, App.state.clusters[i].feature);
  });
});

test("every piece of a split territory is a handle on the same shape", () => {
  const App = setup([multiPolygon([[0, 0, 1], [9, 9, 1]])]);
  const proxied = App.polygons.proxied;
  assert.equal(proxied.length, 2);
  assert.equal(proxied[0].layer, proxied[1].layer);
});

test("hovering a chip marks the chip too", () => {
  const App = setup([polygon(0, 0, 1)]);
  const { onHover, marker } = App.polygons.proxied[0];
  const chip = marker.getElement().firstElementChild;

  onHover(true);
  assert.ok(chip.classList.contains("territory-label--hover"));
  onHover(false);
  assert.ok(!chip.classList.contains("territory-label--hover"));
});

test("selecting a territory selects its chips, and only its chips", () => {
  const App = setup([polygon(0, 0, 1), multiPolygon([[5, 0, 1], [9, 9, 1]])]);
  const selected = App.state.clusters[1].layer;

  App.labels.setSelected(selected, true);
  const marked = chips(App).filter((m) =>
    m.getElement().firstElementChild.classList.contains("territory-label--selected"),
  );
  assert.equal(marked.length, 2, "both pieces of the selected territory");

  App.labels.setSelected(selected, false);
  assert.equal(
    chips(App).filter((m) =>
      m.getElement().firstElementChild.classList.contains("territory-label--selected"),
    ).length,
    0,
  );
});

test("a rebuilt chip comes back selected if its territory still is", () => {
  const App = setup([polygon(0, 0, 1)]);
  App.state.clusters[0].layer._selected = true;
  App.labels.refresh();
  assert.ok(html(App)[0].includes("territory-label--selected"));
});

// ── Cut mode ─────────────────────────────────────────────────────────────────

test("in cut mode the chips are visible but inert", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)], { editMode: true });
  assert.equal(chips(App).length, 2, "still readable");
  assert.equal(App.polygons.proxied.length, 0, "nothing to click");
  chips(App).forEach((m) => {
    assert.equal(m.options.interactive, false);
    assert.ok(m.options.icon.html.includes("territory-label--static"));
  });
});

test("leaving cut mode gives the chips back their handlers", () => {
  const App = setup([polygon(0, 0, 1)], { editMode: true });
  App.state.editMode = false;
  App.labels.refresh();
  assert.equal(App.polygons.proxied.length, 1);
  assert.equal(chips(App)[0].options.interactive, true);
});

// ── The multi-part case ──────────────────────────────────────────────────────

test("a territory in two pieces gets two chips carrying the same number", () => {
  const App = setup([polygon(0, 0, 1), multiPolygon([[2, 0, 1], [9, 9, 1]])]);

  // Three shapes on the map, two territories in the count — which is exactly
  // the discrepancy the chips have to explain rather than reproduce.
  assert.equal(chips(App).length, 3);
  assert.equal(App.labels.rows().length, 2);
  assert.equal(html(App).filter((h) => h.includes(">2<")).length, 2);
  assert.equal(App.labels.warnings().split, 1);
});

test("the largest piece keeps the plain chip and the scraps are marked", () => {
  const App = setup([multiPolygon([[0, 0, 1], [5, 5, 4]])]);
  assert.ok(!html(App)[0].includes("territory-label--part"), "largest piece first");
  assert.ok(html(App)[1].includes("territory-label--part"));
});

// ── The invisible case ───────────────────────────────────────────────────────

test("a chip smaller than the territory it labels says so on the map", () => {
  // One pixel per degree: a 1° square is a single pixel on screen.
  const App = setup([polygon(0, 0, 1)], { span: 1 });
  assert.ok(html(App)[0].includes("territory-label--tiny"));
});

test("a chip that fits its territory is drawn plainly", () => {
  const App = setup([polygon(0, 0, 1)], { span: 200 });
  assert.ok(!html(App)[0].includes("territory-label--tiny"));
});

test("being too small to see is not something the list warns about", () => {
  // It describes the viewport rather than the territory — zoom in and it is
  // gone — and autoheal could never repair it, so it sat among two flags that
  // are real faults and made them look like housekeeping.
  const App = setup([polygon(0, 0, 1)], { span: 1 });
  assert.deepEqual(App.labels.warnings(), {
    split: 0,
    empty: 0,
    crossed: 0,
    uncovered: 0,
    total: 0,
  });
});

test("nothing to warn about is nothing to say", () => {
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  assert.deepEqual(App.labels.warnings(), {
    split: 0,
    empty: 0,
    crossed: 0,
    uncovered: 0,
    total: 0,
  });
});

// ── The case that is not a territory at all ──────────────────────────────────

test("ground in no territory is counted here, since the panel no longer counts it", () => {
  // Uncovered ground has no row of its own in the info panel: one mark on one
  // count, and the list says which of the faults it is. That makes this module
  // the only route the number has to the panel, so a miss here loses it.
  const App = setup([polygon(0, 0, 1)]);
  App.gaps = { features: () => [polygon(4, 0, 1), polygon(6, 0, 1)] };

  const warn = App.labels.warnings();
  assert.equal(warn.uncovered, 2);
  assert.equal(warn.total, 2, "and it marks the count like any other fault");
});

test("a gap layer that is switched off is fully covered ground", () => {
  // gaps.js stops computing when its layer is off, and answering "unknown"
  // with a warning would put a permanent mark on the panel of anyone who
  // turned the layer off.
  const App = setup([polygon(0, 0, 1)]);
  App.gaps = { features: () => [] };
  assert.equal(App.labels.warnings().uncovered, 0);

  delete App.gaps;
  assert.equal(App.labels.warnings().uncovered, 0);
});

// ── The case that looks fine on the map ──────────────────────────────────────

test("a territory with no buildings is counted as a warning", () => {
  // Unlike tiny and split, this one does not explain a discrepancy between the
  // count and the picture. Nothing about it looks wrong until somebody is
  // handed the card, which is why it has to be said out loud.
  const App = setup([polygon(0, 0, 1), polygon(2, 0, 1)]);
  App.autoheal = { isEmpty: (entry) => entry === App.state.clusters[1] };

  const warn = App.labels.warnings();
  assert.equal(warn.empty, 1);
  assert.equal(warn.total, 1);
});

test("a territory nobody has counted yet is not called empty", () => {
  // isEmpty answers null before the buildings are downloaded, and reading that
  // as "no buildings" would flag every territory on a fresh map.
  const App = setup([polygon(0, 0, 1)]);
  App.autoheal = { isEmpty: () => null };
  assert.equal(App.labels.warnings().empty, 0);
});

// ── The number the print dialog borrows ──────────────────────────────────────

test("numberOf answers with what the chip on the shape says", () => {
  const features = [polygon(0, 0, 1), polygon(2, 0, 1), polygon(4, 0, 1)];
  const App = setup(features);
  assert.equal(App.labels.numberOf(features[0]), 1);
  assert.equal(App.labels.numberOf(features[2]), 3);
});

test("a feature that is no longer a territory has no number", () => {
  // print.js holds a feature across an async composition, and it can be cut,
  // merged or deleted in the meantime. A stale suggestion would be worse than
  // an empty field.
  const App = setup([polygon(0, 0, 1)]);
  assert.equal(App.labels.numberOf(polygon(0, 0, 1)), null, "identity, not shape");
  assert.equal(App.labels.numberOf(null), null);
});

test("numbering follows the shape, not the geometry, after a reorder", () => {
  const features = [polygon(0, 0, 1), polygon(2, 0, 1)];
  const App = setup(features);
  App.state.clusters.reverse();
  assert.equal(App.labels.numberOf(features[0]), 2);
});

// ── Printed state ────────────────────────────────────────────────────────────

test("a printed territory carries the done color on its chip", () => {
  const printed = polygon(0, 0, 1);
  printed.properties.printed = "2026-08-08T10:00:00.000Z";
  const App = setup([printed, polygon(2, 0, 1)]);
  assert.ok(html(App)[0].includes("territory-label--printed"));
  assert.ok(!html(App)[1].includes("territory-label--printed"));
});

test("the check rides on the chip, not on a marker of its own", () => {
  // This replaced polygons.js's separate badge. Color cannot carry "done"
  // alone — a green wash and a purple one are the same wash in greyscale and
  // to a red-green color blind reader — so if the check ever stops being
  // emitted, the state goes with it and nothing says so.
  const printed = polygon(0, 0, 1);
  printed.properties.printed = "2026-08-08T10:00:00.000Z";
  const App = setup([printed, polygon(2, 0, 1)]);

  assert.equal(chips(App).length, 2, "no second marker per printed territory");
  assert.ok(html(App)[0].includes("territory-label__check"));
  assert.ok(!html(App)[1].includes("territory-label__check"));
});

test("a printed territory too small to see keeps the check when it loses the green", () => {
  // The case that makes the merge worth more than the code it saves: the
  // chip is red here, so the check is the only thing left saying "done".
  const printed = polygon(0, 0, 1);
  printed.properties.printed = "2026-08-08T10:00:00.000Z";
  const App = setup([printed], { span: 1 });

  assert.ok(html(App)[0].includes("territory-label--tiny"));
  assert.ok(html(App)[0].includes("territory-label__check"));
});

test("the number is still readable next to the check", () => {
  const printed = polygon(0, 0, 1);
  printed.properties.printed = "2026-08-08T10:00:00.000Z";
  const App = setup([polygon(4, 0, 1), printed]);
  assert.ok(html(App)[1].includes(">2</span>"), html(App)[1]);
});

// ── Degenerate input ─────────────────────────────────────────────────────────

test("a cluster with no usable geometry costs a chip, not an exception", () => {
  const broken = { type: "Feature", geometry: null, properties: {} };
  const App = setup([polygon(0, 0, 1), broken, polygon(4, 0, 1)]);
  assert.equal(App.labels.rows().length, 3, "it is still a counted territory");
  assert.equal(chips(App).length, 2);
});
