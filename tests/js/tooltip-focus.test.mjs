/**
 * The focus listener Leaflet leaves behind when a tooltip is unbound.
 *
 * `bindTooltip` does two separate things: it registers an event map on the
 * layer, and — for keyboard users — it calls `DomEvent.on(element, "focus")`
 * with a handler that reads `this._tooltip._source`. `unbindTooltip` undoes
 * only the first. The element keeps a live listener pointing at a tooltip
 * that is now null, and the next focus on that path throws
 *
 *     Uncaught TypeError: Cannot set properties of null (setting '_source')
 *
 * out of Leaflet, with a stack that names no file of ours.
 *
 * Cut and outline mode are what reach that state: both call
 * setTooltipMode("off"), whose mode has no options, so every territory is
 * unbound and nothing is bound in its place.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/** Records what DomEvent.on/off did, the way Leaflet's does it for real. */
function fakeL() {
  const calls = [];
  return {
    calls,
    DomEvent: {
      on(el, type) {
        String(type)
          .split(" ")
          .forEach((t) => el.listeners.push(t));
      },
      off(el, types) {
        const drop = String(types).split(" ");
        el.listeners = el.listeners.filter((t) => !drop.includes(t));
        calls.push(["off", types]);
      },
      stopPropagation() {},
    },
  };
}

/**
 * A layer whose bindTooltip has Leaflet's second half: listeners on the
 * element, which unbindTooltip does not take back off.
 */
function fakeLayer(L) {
  const el = { listeners: [] };
  const layer = {
    element: el,
    tooltip: null,
    getElement: () => el,
    on: () => layer,
    off: () => layer,
    closeTooltip: () => layer,
    bindTooltip(content) {
      layer.tooltip = content;
      L.DomEvent.on(el, "focus", () => {});
      L.DomEvent.on(el, "blur", () => {});
      return layer;
    },
    unbindTooltip() {
      layer.tooltip = null; // and the element listeners stay put
      return layer;
    },
  };
  return layer;
}

/**
 * Stand polygons.js up over a Leaflet fake that records handler bookkeeping.
 *
 * The fake layer counts what is bound and what is removed, because the property
 * under test is that a rebind neither stacks handlers nor strips the tooltip's
 * own — neither of which is visible from anything the module returns.
 */
function setup() {
  const L = fakeL();
  const App = loadApp(["util.js", "polygons.js"], { window: {}, document: {}, L });
  const group = { on: () => group, eachLayer: () => {} };
  const layer = fakeLayer(L);

  App.state = {
    streetsLayerGroup: group,
    buildingsLayerGroup: group,
    clusters: [{ feature: { type: "Feature", properties: {} }, layer: layer }],
  };
  App.geometry = {};
  App.i18n = { t: (k) => k };
  App.polygons.init();

  return { App, L, layer };
}

test("switching tooltips off leaves no listener pointing at a null tooltip", () => {
  const { App, layer } = setup();
  App.polygons.attachClusterEvents(layer, App.state.clusters[0].feature);
  assert.deepEqual(layer.element.listeners, ["focus", "blur"], "bound, as Leaflet does");

  App.polygons.setTooltipMode("off");

  assert.equal(layer.tooltip, null, "no tooltip is bound in cut mode");
  assert.deepEqual(
    layer.element.listeners,
    [],
    "and nothing is left on the element to dereference it",
  );
});

test("switching back on restores the listeners exactly once", () => {
  const { App, layer } = setup();
  App.polygons.attachClusterEvents(layer, App.state.clusters[0].feature);

  App.polygons.setTooltipMode("off");
  App.polygons.setTooltipMode("full");

  assert.ok(layer.tooltip, "the tooltip is back");
  assert.deepEqual(layer.element.listeners, ["focus", "blur"]);
});

test("repeated mode switches do not stack listeners on the element", () => {
  // Each rebind clears Leaflet's _tooltipHandlersAdded, so without the
  // removal every switch added another pair to the same path — and every
  // extra pair is another chance to fire against a null tooltip.
  const { App, layer } = setup();
  App.polygons.attachClusterEvents(layer, App.state.clusters[0].feature);

  for (const mode of ["anchored", "full", "anchored", "full"]) {
    App.polygons.setTooltipMode(mode);
  }

  assert.deepEqual(layer.element.listeners, ["focus", "blur"]);
});
