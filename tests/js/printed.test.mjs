/**
 * The printed marks.
 *
 * Two things here fail silently and cost real work when they do.
 *
 * The mark lives in `properties.printed` and is read back out of an export or
 * a restored session, which means the reader has to survive whatever is in
 * that slot — an old file with nothing there, a hand-edited GeoJSON with
 * `true` in it, a null left behind by an un-marking. A reader that says "yes,
 * printed" for a stray value quietly hides a territory that still needs
 * walking.
 *
 * And a printed territory has to keep looking like a territory. The first cut
 * of this made it fainter than an unprinted one, which is what a deleted
 * shape looks like; the fill is now the stronger of the two, and the
 * assertions below pin that direction rather than the exact numbers.
 *
 * `properties.label` - what a card called the territory - is read the same
 * way and out of the same slot, so it is pinned here too.
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

const P = loadApp(["util.js", "polygons.js"]).polygons;

function feature(props) {
  return { type: "Feature", geometry: null, properties: props };
}

/** A path stub: refreshStyle only ever asks a layer to restyle itself. */
function fakeLayer(state) {
  const layer = Object.assign({ applied: null }, state);
  layer.setStyle = (style) => {
    layer.applied = style;
  };
  return layer;
}

// ── Reading the mark ─────────────────────────────────────────────────────────

test("a timestamp counts as printed and is handed back unchanged", () => {
  const stamp = "2026-08-08T10:15:00.000Z";
  assert.equal(P.printedAt(feature({ printed: stamp })), stamp);
  assert.equal(P.isPrinted(feature({ printed: stamp })), true);
});

test("anything that is not a non-empty string is not a mark", () => {
  for (const value of [undefined, null, "", true, 1, 0, {}, []]) {
    assert.equal(
      P.printedAt(feature({ printed: value })),
      null,
      `${JSON.stringify(value)} should not read as printed`,
    );
  }
});

test("a territory from an older export is simply unprinted", () => {
  assert.equal(P.isPrinted(feature({})), false);
  assert.equal(P.isPrinted(feature(undefined)), false);
  assert.equal(P.isPrinted(undefined), false);
});

// ── Painting it ──────────────────────────────────────────────────────────────

// ── What a card called it ────────────────────────────────────────────────────

test("a name is handed back as it was stored", () => {
  assert.equal(P.labelOf(feature({ label: "S-13" })), "S-13");
});

test("anything that is not a string is not a name", () => {
  // The same slot, the same hand-edited files, and the same reason: a name
  // read out of `true` or `7` would be drawn onto a wall map as "true".
  for (const value of [true, 7, null, undefined, {}, []]) {
    assert.equal(P.labelOf(feature({ label: value })), "", String(value));
  }
  assert.equal(P.labelOf(feature({})), "");
  assert.equal(P.labelOf(null), "");
});

test("a territory nobody has printed a card for is unnamed, not un-numbered", () => {
  // "" rather than null, because every caller falls back to the index and
  // wants one answer to test rather than two.
  assert.equal(P.labelOf(feature({ printed: "2026-01-01T00:00:00.000Z" })), "");
});

/**
 * polygons.js standing up over the little it needs to find a territory.
 *
 * `P` above is the module read without an init(), which is all the pure
 * readers require. setLabel writes into the cluster list, so it needs one.
 */
function withClusters(features) {
  const noop = () => {};
  const group = () => ({ on: noop, clearLayers: noop, addLayer: noop });
  const App = loadApp(["util.js", "polygons.js"], { window: {}, document: {} });
  App.i18n = { t: (key) => key };
  App.geometry = {};
  App.session = { markDirty: noop };
  App.state = {
    clusters: features.map((feature) => ({ feature, layer: fakeLayer({}) })),
    streetsLayerGroup: group(),
    buildingsLayerGroup: group(),
  };
  App.polygons.init();
  return App;
}

test("a name is stored trimmed, and blank takes it off again", () => {
  const territory = feature({});
  const App = withClusters([territory]);

  assert.equal(App.polygons.setLabel(territory, "  S-13  "), true);
  assert.equal(App.polygons.labelOf(territory), "S-13");

  // Removed rather than stored empty: "printed without a number" has to leave
  // the territory unnamed, or every caller's fallback to the index is dead.
  assert.equal(App.polygons.setLabel(territory, "   "), true);
  assert.equal(App.polygons.labelOf(territory), "");
  assert.equal("label" in territory.properties, false);
});

test("naming a territory the same thing twice changes nothing", () => {
  const territory = feature({ label: "S-13" });
  const App = withClusters([territory]);
  assert.equal(App.polygons.setLabel(territory, "S-13"), false);
});

test("a territory that is no longer on the map is not named", () => {
  // print.js holds a feature across an async composition, and it can be cut,
  // merged or deleted in the meantime. Writing onto the orphan would put the
  // name somewhere nothing will ever read it.
  const gone = feature({});
  const App = withClusters([feature({})]);
  assert.equal(App.polygons.setLabel(gone, "S-13"), false);
  assert.equal(App.polygons.labelOf(gone), "");
});

test("a name outlives the printed mark it was typed beside", () => {
  // Clearing the marks starts a new round. It says nothing about what the
  // territories are called.
  const territory = feature({});
  const App = withClusters([territory]);
  App.polygons.setLabel(territory, "S-13");
  App.polygons.markPrinted(territory, true);
  App.polygons.markPrinted(territory, false);
  assert.equal(App.polygons.labelOf(territory), "S-13");
});

test("a printed territory is drawn green", () => {
  const layer = fakeLayer({ _printed: true });
  P.refreshStyle(layer);
  assert.equal(layer.applied.color, P.CLUSTER_STYLE_PRINTED.color);
});

test("printed is more present than unprinted, not less", () => {
  // The regression this exists for: a printed territory that is fainter and
  // thinner than an unprinted one reads as deleted rather than as done.
  const printed = fakeLayer({ _printed: true });
  const plain = fakeLayer({ _printed: false });
  P.refreshStyle(printed);
  P.refreshStyle(plain);

  assert.ok(
    printed.applied.fillOpacity > plain.applied.fillOpacity,
    "printed should be the stronger fill",
  );
  assert.ok(
    printed.applied.weight >= plain.applied.weight,
    "printed should not have a thinner outline",
  );
});

test("no style leaves a dash behind", () => {
  // setStyle merges rather than replaces, so a dash set on one state would
  // survive into every other one. Nothing sets a dash any more; this keeps it
  // that way.
  for (const state of [
    { _printed: true },
    { _printed: false },
    { _printed: true, _hover: true },
    { _printed: true, _selected: true },
  ]) {
    const layer = fakeLayer(state);
    P.refreshStyle(layer);
    assert.ok(!layer.applied.dashArray, JSON.stringify(state));
  }
});

test("hover brightens a printed territory without losing the color", () => {
  const layer = fakeLayer({ _printed: true, _hover: true });
  P.refreshStyle(layer);
  assert.equal(layer.applied.fillOpacity, P.CLUSTER_STYLE_PRINTED_HOVER.fillOpacity);
  assert.equal(layer.applied.color, P.CLUSTER_STYLE_PRINTED_HOVER.color);
});

test("selection wins over the printed color while it lasts", () => {
  const layer = fakeLayer({ _printed: true, _selected: true });
  P.refreshStyle(layer);
  assert.equal(layer.applied.color, P.CLUSTER_STYLE_SELECTED.color);
});

// ── Saying it ────────────────────────────────────────────────────────────────

test("every string the feature needs is in the dictionary", () => {
  const dig = (key) =>
    key.split(".").reduce((node, part) => (node ? node[part] : undefined), DICT);

  for (const key of [
    "menu.markPrinted",
    "menu.unmarkPrinted",
    "info.printed",
    "tooltip.printed",
    "toolbar.clearPrinted",
    "toolbar.labelClearPrinted",
    "toolbar.needsPrinted",
    "confirm.clearPrintedTitle",
    "confirm.clearPrinted",
  ]) {
    assert.equal(typeof dig(key), "string", `${key} is missing`);
  }

  // Inflects on {count}, so it is a category map rather than one string.
  assert.equal(typeof dig("alert.clearPrintedConfirm"), "object");
});
