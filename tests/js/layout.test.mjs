/**
 * The bottom edge of the map, read as a set rather than one bar at a time.
 *
 * Four mode bars, a hint banner and the info panel all anchor themselves to
 * the bottom of the same map, and each one was added by looking at the mode
 * it belonged to. The results were only visible side by side:
 *
 *   • The merge bar kept the bottom: 30px it had before merge grew a hint
 *     banner, so the banner — mounted after it, and a level higher — landed
 *     straight on top of the buttons that leave the mode. Cut, trim and
 *     outline had all moved to 76px; merge was the one nobody revisited.
 *   • The info panel sat on a hand-written z-index: 1200, above every token
 *     in the file, so a context menu opened near the bottom-right corner
 *     was both hidden by it and unclickable underneath it.
 *
 * Both are the same failure: a number chosen against whatever happened to be
 * on screen at the time. So the assertions here are about the arrangement,
 * not about any one component — the levels are ordered, the bars share an
 * offset, and the selector dom.js watches still names all of them.
 *
 * Read off the stylesheet rather than off a rendered page on purpose: the
 * question is whether the rules agree with each other, which no screenshot
 * answers and no headless browser is needed for.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(
  join(ROOT, "src", "osmapp", "static", "css", "style.css"),
  "utf8",
);
const DOM = readFileSync(
  join(ROOT, "src", "osmapp", "static", "js", "dom.js"),
  "utf8",
);

/** Strip comments once: every scan below would otherwise read the prose. */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Every declaration that applies to `selector`, joined. A rule per component
 * would be easier to read off, but the bars deliberately share one: the four
 * of them take their box from a grouped rule and add only their own offset
 * and accent afterwards.
 */
function block(selector) {
  const wanted = new RegExp(selector.replace(/[.#]/g, "\\$&") + "(?![\\w-])");
  const declarations = [];

  for (const [, head, body] of BARE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (wanted.test(head)) declarations.push(body);
  }

  assert.ok(declarations.length, `no rule for ${selector}`);
  return declarations.join("\n");
}

/** The numeric value of a --z-* custom property. */
function level(name) {
  const found = BARE.match(new RegExp("--" + name + ":\\s*(\\d+)"));
  assert.ok(found, `--${name} is not defined`);
  return Number(found[1]);
}

const MODE_BARS = [
  ".cut-toolbar",
  ".merge-toolbar",
  ".trim-toolbar",
  ".outline-toolbar",
];

test("only the stack is anchored to the bottom edge", () => {
  // The offset used to live on each bar, which is how one of the four kept a
  // number the other three had moved on from, and how all four kept a number
  // that was only right while the banner stayed on one line. A bar that
  // positions itself has opted back out of the stack.
  for (const selector of MODE_BARS.concat(".draw-hint")) {
    assert.doesNotMatch(
      block(selector),
      /position:\s*absolute|(^|;|\s)bottom:/,
      `${selector} anchors itself instead of sitting in the stack`,
    );
  }

  const stack = block(".map-bottom-stack");
  assert.match(stack, /position:\s*absolute/);
  assert.match(stack, /bottom:\s*\d+px/);
  assert.match(stack, /flex-direction:\s*column/);
  assert.match(stack, /gap:\s*\d+px/, "the gap is what replaced the offset");
});

test("the banner is the bottom item of the stack", () => {
  // Both orders of mounting happen — merge builds its bar first, cut its
  // banner first — so source order cannot be what decides which is on top.
  assert.match(block(".draw-hint"), /(^|[;\s])order:\s*\d+/m);
  for (const bar of MODE_BARS) {
    assert.doesNotMatch(
      block(bar),
      /(^|[;\s])order:\s*\d/m,
      `${bar} sets an order, so the banner is no longer reliably last`,
    );
  }
});

test("readouts, bars, menus and dialogs are ordered", () => {
  const order = [
    "z-map-ui",
    "z-status",
    "z-mode-bar",
    "z-menu",
    "z-dialog",
    "z-overlay",
    "z-tour",
  ];
  const levels = order.map(level);

  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(
      levels[i] > levels[i - 1],
      `--${order[i]} (${levels[i]}) does not sit above ` +
        `--${order[i - 1]} (${levels[i - 1]})`,
    );
  }
});

test("nothing on the map picks its own stacking level", () => {
  // Small numbers are local: a rule inside an element that already made a
  // stacking context of its own. Anything up in token territory is a rule
  // that has opted out of the scale, which is how the info panel ended up
  // over the context menu.
  for (const [, value] of BARE.matchAll(/z-index:\s*(\d+)/g)) {
    assert.ok(
      Number(value) < level("z-map-ui"),
      `hand-written z-index: ${value} — use one of the --z-* levels`,
    );
  }
});

test("the readouts stay below anything clickable", () => {
  // The banner no longer carries a level of its own: inside the stack it
  // cannot overlap the bar, so the only readout left to place is the panel.
  assert.match(
    block("#info-panel"),
    /z-index:\s*var\(--z-status\)/,
    "#info-panel is a readout and belongs on --z-status",
  );
  assert.match(
    block(".map-bottom-stack"),
    /z-index:\s*var\(--z-mode-bar\)/,
    "the stack holds the mode bars and takes their level",
  );
});

test("dom.js watches for every bar that owns the bottom edge", () => {
  const watched = DOM.match(/BOTTOM_BARS\s*=\s*([\s\S]*?);/);
  assert.ok(watched, "dom.js no longer declares BOTTOM_BARS");

  for (const selector of MODE_BARS.concat(".draw-hint")) {
    assert.ok(
      watched[1].includes(selector),
      `${selector} is missing from BOTTOM_BARS — the info panel will ` +
        "not know it is there",
    );
  }
});
