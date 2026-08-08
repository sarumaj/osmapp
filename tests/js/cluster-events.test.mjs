/**
 * Binding a territory's pointer behavior without unbinding its tooltip.
 *
 * These two live on the same layer and speak to Leaflet's event bus through
 * the same four event names. `bindTooltip` installs its own mouseover and
 * mouseout; `off("mouseover mouseout click contextmenu")` with no handler
 * argument is a *blanket* removal and takes those with it. So for a while the
 * two binders were silently order-dependent: tooltip first meant the tooltip
 * was wiped one line later, with no error, no warning, and nothing on screen
 * to suggest which of the two was at fault.
 *
 * The fix is to remove handlers by reference rather than by type, which makes
 * the order stop mattering. These tests assert the property that actually
 * matters — the tooltip survives — rather than the call order, so a future
 * reshuffle of attachClusterEvents cannot quietly bring the bug back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const P = loadApp(["polygons.js"]).polygons;

/**
 * A layer that models the parts of Leaflet's Evented and Tooltip mixins this
 * depends on — in particular that `off(types)` without a handler is a blanket
 * removal, and that `bindTooltip` registers listeners of its own.
 */
function fakeLayer() {
  const layer = {
    handlers: [], // { type, fn, owner }
    tooltip: null,
    _owner: "app", // what the next on() call is attributed to
  };

  layer.on = (typeOrMap, fn) => {
    const map = typeof typeOrMap === "string" ? { [typeOrMap]: fn } : typeOrMap;
    for (const [type, handler] of Object.entries(map)) {
      layer.handlers.push({ type, fn: handler, owner: layer._owner });
    }
    return layer;
  };

  layer.off = (typeOrMap, fn) => {
    if (typeOrMap && typeof typeOrMap === "object") {
      // An event map: remove those exact handlers and nothing else.
      const pairs = Object.entries(typeOrMap);
      layer.handlers = layer.handlers.filter(
        (h) => !pairs.some(([type, handler]) => h.type === type && h.fn === handler),
      );
      return layer;
    }
    const types = String(typeOrMap).split(" ");
    layer.handlers = layer.handlers.filter(
      (h) => !types.includes(h.type) || (fn !== undefined && h.fn !== fn),
    );
    return layer;
  };

  layer.bindTooltip = (content) => {
    layer.tooltip = content;
    layer._owner = "tooltip";
    layer.on("mouseover", () => {});
    layer.on("mouseout", () => {});
    layer._owner = "app";
    return layer;
  };

  layer.unbindTooltip = () => {
    layer.tooltip = null;
    layer.handlers = layer.handlers.filter((h) => h.owner !== "tooltip");
    return layer;
  };

  layer.closeTooltip = () => layer;

  return layer;
}

const owned = (layer, owner) => layer.handlers.filter((h) => h.owner === owner);
const typesOf = (layer, owner) => owned(layer, owner).map((h) => h.type).sort();

const FEATURE = { type: "Feature", geometry: null, properties: {} };

// ── The regression ───────────────────────────────────────────────────────────

test("attaching cluster events leaves the tooltip bound", () => {
  const layer = fakeLayer();
  P.attachClusterEvents(layer, FEATURE);

  assert.ok(layer.tooltip, "a tooltip was bound");
  assert.deepEqual(
    typesOf(layer, "tooltip"),
    ["mouseout", "mouseover"],
    "the tooltip's own listeners are still registered",
  );
});

test("a proxy gets its own tooltip and keeps it", () => {
  const layer = fakeLayer();
  const chip = fakeLayer();
  P.attachProxyEvents(chip, layer, FEATURE, () => {});

  assert.ok(chip.tooltip, "the chip describes the territory it stands for");
  assert.deepEqual(typesOf(chip, "tooltip"), ["mouseout", "mouseover"]);
});

// ── Rebinding ────────────────────────────────────────────────────────────────

test("re-attaching does not stack a second set of handlers", () => {
  // setClusters and labels.refresh both re-attach; duplicated handlers would
  // mean a double fitBounds on click and two hover toggles per pointer move.
  const layer = fakeLayer();
  P.attachClusterEvents(layer, FEATURE);
  const after = owned(layer, "app").length;

  P.attachClusterEvents(layer, FEATURE);
  P.attachClusterEvents(layer, FEATURE);

  assert.equal(owned(layer, "app").length, after);
  assert.deepEqual(typesOf(layer, "app"), ["click", "contextmenu", "mouseout", "mouseover"]);
});

test("re-attaching still leaves exactly one tooltip", () => {
  const layer = fakeLayer();
  P.attachClusterEvents(layer, FEATURE);
  P.attachClusterEvents(layer, FEATURE);

  assert.ok(layer.tooltip);
  assert.equal(typesOf(layer, "tooltip").length, 2, "not two tooltips' worth");
});

test("rebinding the behavior never touches anything it did not bind", () => {
  // The property the fix rests on, stated directly: whatever else is
  // listening for these four events — the tooltip today, something else
  // tomorrow — is none of this binder's business.
  const layer = fakeLayer();
  layer._owner = "someone-else";
  layer.on("click", () => {});
  layer.on("mouseover", () => {});
  layer._owner = "app";

  P.attachClusterEvents(layer, FEATURE);
  P.attachClusterEvents(layer, FEATURE);

  assert.equal(owned(layer, "someone-else").length, 2);
});
