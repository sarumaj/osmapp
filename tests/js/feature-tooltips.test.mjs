/**
 * The lifetime of a street or building tooltip.
 *
 * Territories carry their tooltip permanently; streets and buildings get one
 * on first hover and are expected to give it back. Two things go wrong with
 * that, and neither is visible from anything the module returns:
 *
 *   • A tooltip whose closing event never arrives. Leaflet closes on the
 *     shape's own mouseout, and that does not always come — the shape is taken
 *     off the map, a trim mark is dropped on top of it, the pointer leaves the
 *     window, the element is rebuilt under a cursor that has not moved. What
 *     is left is a panel describing a building nobody is pointing at.
 *   • A tooltip opened in a mode that shows none. `bindTooltip` installs
 *     Leaflet's own mouseover opener on the layer, and it knows nothing about
 *     this app's modes: closing without unbinding leaves it live, so the next
 *     hover reopens what the cut tool has just suppressed.
 *
 * Unit level, against a Leaflet fake that records the bookkeeping — which
 * handlers are on a layer, which listeners are on its element, and whether a
 * tooltip is bound and open. Nothing here renders.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/** DomEvent, recording listeners by element so a test can fire them. */
function fakeDomEvent() {
  return {
    on(el, type, fn) {
      String(type)
        .split(" ")
        .forEach((t) => {
          el.listeners.push(t);
          (el.handlers[t] = el.handlers[t] || []).push(fn);
        });
    },
    off(el, types) {
      const drop = String(types).split(" ");
      el.listeners = el.listeners.filter((t) => !drop.includes(t));
      drop.forEach((t) => delete el.handlers[t]);
    },
    stopPropagation() {},
  };
}

function element() {
  return { listeners: [], handlers: {} };
}

/**
 * A path with Leaflet's tooltip contract: bindTooltip registers an opener of
 * its own and puts focus listeners on the element, and unbindTooltip takes
 * back only the first of those — which is the behavior polygons.js works
 * around and so the behavior the fake has to reproduce.
 */
function fakeLayer(L, name) {
  const el = element();
  const layer = {
    name,
    element: el,
    tooltip: null,
    open: false,
    style: null,
    own: {}, // Leaflet's own handlers, keyed by event type
    getElement: () => el,
    setStyle(style) {
      layer.style = style;
      return layer;
    },
    on(map) {
      Object.keys(map).forEach((type) => {
        layer.own[type] = map[type];
      });
      return layer;
    },
    off() {
      return layer;
    },
    bindTooltip(content) {
      layer.tooltip = content;
      // Leaflet's half: an opener bound to the layer, listeners on the element.
      layer.on({ mouseover: () => layer.openTooltip(), mouseout: () => layer.closeTooltip() });
      L.DomEvent.on(el, "focus", () => {});
      L.DomEvent.on(el, "blur", () => {});
      return layer;
    },
    unbindTooltip() {
      layer.tooltip = null;
      layer.open = false;
      delete layer.own.mouseover;
      delete layer.own.mouseout;
      return layer;
    },
    openTooltip() {
      if (layer.tooltip) layer.open = true;
      return layer;
    },
    closeTooltip() {
      layer.open = false;
      return layer;
    },
  };
  return layer;
}

/** A feature group that keeps the delegated handlers so a test can fire them. */
function fakeGroup() {
  const handlers = {};
  const layers = [];
  const group = {
    layers,
    on(types, fn) {
      String(types)
        .split(" ")
        .forEach((t) => (handlers[t] = fn));
      return group;
    },
    eachLayer(fn) {
      layers.slice().forEach(fn);
    },
    fire(type, layer) {
      if (handlers[type]) handlers[type]({ layer, latlng: { lat: 0, lng: 0 } });
    },
  };
  return group;
}

function setup() {
  const L = { DomEvent: fakeDomEvent() };
  const App = loadApp(["util.js", "polygons.js"], {
    window: {},
    document: {},
    L,
  });
  const buildings = fakeGroup();
  const container = element();

  App.state = {
    streetsLayerGroup: fakeGroup(),
    buildingsLayerGroup: buildings,
    clusters: [],
    leafletMap: { getContainer: () => container },
  };
  App.geometry = {};
  App.i18n = { t: (k) => k };
  App.polygons.init();

  const add = (name) => {
    const layer = fakeLayer(L, name);
    buildings.layers.push(layer);
    return layer;
  };
  return {
    App,
    buildings,
    add,
    /** The pointer leaving the map container altogether. */
    leaveMap: () => (container.handlers.mouseleave || []).forEach((fn) => fn()),
  };
}

// ── The ordinary round trip ─────────────────────────────────────────────────

test("hovering a building opens its tooltip and leaving closes it", () => {
  const h = setup();
  const a = h.add("a");

  h.buildings.fire("mouseover", a);
  assert.ok(a.tooltip, "bound on first hover");
  assert.equal(a.open, true);

  h.buildings.fire("mouseout", a);
  assert.equal(a.open, false);
});

// ── When the closing event never comes ──────────────────────────────────────

test("hovering another building closes one whose mouseout never arrived", () => {
  // The failure this guards. A building taken off the map, covered by a trim
  // mark, or rebuilt under a stationary cursor never reports the pointer
  // leaving, and Leaflet has nothing else that would close it. Holding the
  // open one means the next hover does.
  const h = setup();
  const a = h.add("a");
  const b = h.add("b");

  h.buildings.fire("mouseover", a);
  assert.equal(a.open, true);

  h.buildings.fire("mouseover", b);

  assert.equal(a.open, false, "the one nobody is pointing at is closed");
  assert.equal(b.open, true);
});

test("the pointer leaving the map closes what is open", () => {
  // The other half of the same problem: there is no next hover. Moving onto
  // the info panel, onto a dialog, or out of the window leaves the panel over
  // the map with nothing under the cursor at all.
  const h = setup();
  const a = h.add("a");

  h.buildings.fire("mouseover", a);
  assert.equal(a.open, true);

  h.leaveMap();

  assert.equal(a.open, false);
});

test("only one feature tooltip is ever open", () => {
  const h = setup();
  const layers = ["a", "b", "c", "d"].map(h.add);

  layers.forEach((layer) => h.buildings.fire("mouseover", layer));

  assert.deepEqual(
    layers.filter((layer) => layer.open).map((layer) => layer.name),
    ["d"],
  );
});

// ── When tooltips are switched off ──────────────────────────────────────────

test("switching tooltips off takes the binding, not just the panel", () => {
  // Closing alone leaves Leaflet's own opener on the layer, and it knows
  // nothing about cut mode: the next hover puts a panel back over the street
  // the pointer is drawing along.
  const h = setup();
  const a = h.add("a");
  h.buildings.fire("mouseover", a);

  h.App.polygons.setTooltipMode("off");

  assert.equal(a.tooltip, null, "nothing left bound");
  assert.equal(a.open, false);
  assert.equal(a.own.mouseover, undefined, "and nothing left to fire");
  assert.deepEqual(
    a.element.listeners,
    [],
    "including the focus listeners unbindTooltip does not take back",
  );
});

test("hovering while tooltips are off opens nothing", () => {
  const h = setup();
  const a = h.add("a");

  h.App.polygons.setTooltipMode("off");
  h.buildings.fire("mouseover", a);

  assert.equal(a.open, false);
  assert.equal(a.tooltip, null);
});

test("a mode change under the cursor closes the panel already showing", () => {
  // The pointer does not move, so no mouseout is coming for the shape it is
  // sitting on. Whatever suppressed the tooltips has to take that one too.
  const h = setup();
  const a = h.add("a");
  h.buildings.fire("mouseover", a);
  assert.equal(a.open, true);

  h.App.polygons.clearHover();

  assert.equal(a.open, false);
});

test("switching back on binds again on the next hover", () => {
  const h = setup();
  const a = h.add("a");

  h.App.polygons.setTooltipMode("off");
  h.buildings.fire("mouseover", a);
  h.App.polygons.setTooltipMode("full");
  h.buildings.fire("mouseover", a);

  assert.ok(a.tooltip, "bound again");
  assert.equal(a.open, true);
  assert.deepEqual(
    a.element.listeners,
    ["focus", "blur"],
    "and the focus listeners are back exactly once",
  );
});
