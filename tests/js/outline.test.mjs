/**
 * Reshaping the outer boundary.
 *
 * Two things here are easy to get subtly wrong and hard to notice afterwards.
 *
 * The first is what a snapshot means. Leaflet.Editable reports a vertex
 * change *after* it has happened, so the ring that goes on the stack is the
 * state the change produced, not the state it replaced. That makes the entry
 * to return to the one *beneath* the top — and the ring the tool opened with
 * when there is nothing beneath it. Off by one here means the first Ctrl+Z
 * does nothing and the last one is unreachable, which reads as "undo is
 * flaky" rather than as a bug with a shape.
 *
 * The second is leaving. Editing happens in place, on the live boundary
 * layer, so a tool that exits without putting the shape back has silently
 * applied an edit the user cancelled — and the map looks exactly as it would
 * if they had meant it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

function ll(lat, lng) {
  return { lat, lng };
}

const SQUARE = [ll(0, 0), ll(0, 1), ll(1, 1), ll(1, 0)];

function setup() {
  const mapHandlers = {};
  const container = { classList: { add() {}, remove() {} } };
  const document = { addEventListener() {} };
  const L = {
    latLng: (lat, lng) => ll(lat, lng),
    DomEvent: { stopPropagation() {} },
    // The mode marks its container so the stylesheet can tell an outline
    // handle from a trim one.
    DomUtil: { addClass() {}, removeClass() {} },
  };

  let ring = SQUARE.slice();
  const layer = {
    getLatLngs: () => [ring],
    setLatLngs: (next) => {
      ring = next;
    },
    enableEdit() {},
    disableEdit() {},
    on() {},
    off() {},
  };

  const turf = {
    area: () => 100,
    bbox: () => [0, 0, 1, 1],
    booleanValid: () => true,
  };

  const App = loadApp(
    ["shortcuts.js", "vertices.js", "history.js", "outline.js"],
    {
    window: { addEventListener() {} },
    document,
    L,
    turf,
  },
  );

  const noop = () => {};
  App.i18n = { t: (k) => k, n: (v) => String(v), onChange: noop };
  App.dom = {
    mountOnMap: () => null,
    remove: () => null,
    role: () => null,
    text: noop,
    onRole: noop,
    toggleClass: noop,
  };
  App.controls = { setActive: noop, refresh: noop };
  App.polygons = {
    setTooltipMode: noop,
    clearHover: noop,
    clusterFeatures: () => [],
    setClusters: noop,
    replaceOuter: () => ({ kept: 1, dropped: 0, unmarked: 0 }),
  };
  App.ui = { closeContextMenu: noop, isDialogOpen: () => false };
  App.gaps = { schedule: noop, count: () => 0, features: () => [] };
  App.geometry = {
    // outline.js measures the ring through geometry.js, not turf directly.
    area: (feature) => (feature ? 100 : 0),
    getOuterFeature: () => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [ring.map((p) => [p.lng, p.lat])],
      },
    }),
  };
  App.state = {
    outlineMode: false,
    editMode: false,
    mergeMode: false,
    trimMode: false,
    clusters: [],
    outerPolygonLayer: layer,
    leafletMap: {
      on(type, fn) {
        mapHandlers[type] = fn;
      },
      off() {},
      getContainer: () => container,
      editTools: null,
    },
  };

  App.shortcuts.init();
  App.history.init();
  App.outline.init();

  return {
    App,
    outline: App.outline,
    history: App.history,
    ring: () => ring,
    corners: () => ring.length,
    /** Move a corner the way a drag would, then report it the way the editor does. */
    moveCorner(index, lat, lng) {
      ring = ring.slice();
      ring[index] = ll(lat, lng);
      mapHandlers["editable:vertex:dragend"]();
    },
    deleteCorner(index) {
      ring = ring.slice();
      ring.splice(index, 1);
      mapHandlers["editable:vertex:deleted"]();
    },
  };
}

// ── The stack ────────────────────────────────────────────────────────────────

test("undo walks back one corner change at a time, ending at the shape it opened with", () => {
  const h = setup();
  h.outline.toggle();
  assert.equal(h.corners(), 4);

  h.moveCorner(0, 5, 5);
  h.deleteCorner(3);
  assert.equal(h.corners(), 3);

  h.outline.undoVertex();
  assert.equal(h.corners(), 4, "the deleted corner is back");
  assert.deepEqual(h.ring()[0], ll(5, 5), "…but the move is still there");

  h.outline.undoVertex();
  assert.deepEqual(h.ring()[0], ll(0, 0), "back to the shape the tool opened with");
  assert.equal(h.history.canUndo(), false, "and there is nothing left to undo");
});

test("redo replays exactly what undo took back", () => {
  const h = setup();
  h.outline.toggle();

  h.moveCorner(0, 5, 5);
  h.deleteCorner(3);

  h.outline.undoVertex();
  h.outline.undoVertex();
  h.outline.redoVertex();
  assert.deepEqual(h.ring()[0], ll(5, 5));
  assert.equal(h.corners(), 4);

  h.outline.redoVertex();
  assert.equal(h.corners(), 3);
  assert.equal(h.history.canRedo(), false);
});

test("a new change branches off the timeline", () => {
  const h = setup();
  h.outline.toggle();

  h.moveCorner(0, 5, 5);
  h.outline.undoVertex();
  assert.equal(h.history.canRedo(), true);

  h.moveCorner(1, 9, 9);
  assert.equal(h.history.canRedo(), false, "the abandoned future is gone");
});

test("a drag that ends where it started is not a step", () => {
  const h = setup();
  h.outline.toggle();

  h.moveCorner(0, 0, 0); // dropped back on itself
  assert.equal(h.history.canUndo(), false);
});

// ── Leaving ──────────────────────────────────────────────────────────────────

test("cancelling puts the boundary back", () => {
  // The layer is edited in place, so a tool that exits without restoring has
  // applied an edit the user explicitly declined.
  const h = setup();
  h.outline.toggle();

  h.moveCorner(0, 5, 5);
  h.deleteCorner(3);
  h.outline.cancel();

  assert.equal(h.App.state.outlineMode, false);
  assert.equal(h.corners(), 4);
  assert.deepEqual(h.ring()[0], ll(0, 0));
});

test("reset returns to the opening shape without leaving the tool", () => {
  const h = setup();
  h.outline.toggle();

  h.moveCorner(0, 5, 5);
  h.outline.reset();

  assert.equal(h.App.state.outlineMode, true, "still editing");
  assert.deepEqual(h.ring()[0], ll(0, 0));
  assert.equal(h.history.canUndo(), false);
});

test("the tool owns undo while it is open and hands it back on the way out", () => {
  const h = setup();
  assert.equal(h.history.scopeId(), "clusters");

  h.outline.toggle();
  assert.equal(h.history.scopeId(), "outline");
  assert.equal(h.App.shortcuts.activeId(), "outline");

  h.outline.cancel();
  assert.equal(h.history.scopeId(), "clusters");
  assert.equal(h.App.shortcuts.activeId(), "global");
});

test("the tooltip says corners rather than changes while the tool is open", () => {
  // "Undo last change" is a lie when what will be taken back is one corner.
  const h = setup();
  h.outline.toggle();
  assert.equal(h.history.undoKey(), "toolbar.undoCorner");
  assert.equal(h.history.redoKey(), "toolbar.redoCorner");
});
