/**
 * The bottom edge of the map, and the stacking order of what sits there.
 *
 * ── What shares that edge ─────────────────────────────────────────────────
 *
 * Four modal tool bars, a hint banner and the info panel all anchor themselves
 * to the bottom of the same map. The bars and the banner are laid out by
 * dom.js into a flex column (see BOTTOM_BARS there); the panel is positioned
 * independently and only has to stay out of the way.
 *
 * ── Why the assertions are about the set ──────────────────────────────────
 *
 * The failure this file guards against is a number chosen by looking at
 * whichever component was on screen at the time. Nothing is wrong with such a
 * number in isolation, which is why it survives review — it is only wrong
 * beside the other five, and only in the mode that puts two of them up at
 * once.
 *
 * So nothing here asserts that a particular bar sits at a particular offset.
 * The assertions are relational: the z-index tokens are in order, the bars all
 * take their offset from the same shared rule rather than each carrying its
 * own, no rule opts out of the token scale, and the selector dom.js watches
 * still names every bar that exists.
 *
 * ── Why it reads the stylesheet ───────────────────────────────────────────
 *
 * The question is whether the CSS rules agree with each other, which is a
 * property of the text and not of any particular rendering. No headless
 * browser is needed, and no screenshot would answer it.
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

/**
 * The stylesheet with its comments removed, done once. Every scan below
 * searches the text for declarations, and comment prose containing something
 * like `z-index` would otherwise be read as a rule.
 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Collect every declaration that applies to `selector`, from all rules,
 * joined into one string.
 *
 * A single rule per component would be simpler to read off, but the bars share
 * one on purpose: all four take their box from a grouped rule and then add
 * only their own accent color. So a component's effective style is spread
 * across several rules and has to be gathered before it can be asserted on.
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

/**
 * Read the numeric value of one `--z-*` custom property from :root.
 *
 * These tokens are the whole stacking scale. Every element that overlaps
 * another is supposed to take its z-index from one of them, so their relative
 * order is what the tests below check.
 */
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
  // No bar may position itself against the bottom of the map. They are laid
  // out as a flex column, and a bar carrying its own offset has opted out of
  // that — which puts it back in the situation where its position is correct
  // only for the combination of components that happened to be on screen when
  // the number was chosen.
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
  // Both mounting orders occur in practice: merge builds its bar before its
  // banner, cut does the reverse. So the arrangement cannot depend on the
  // order nodes are appended in, and has to be settled by the stylesheet.
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
  // Small z-index values are fine: they order children inside an element that
  // already establishes its own stacking context, and cannot affect anything
  // outside it. A large literal is different — it competes with the token
  // scale while being invisible to it, which is exactly how a component ends
  // up above a context menu that is supposed to be on top of everything.
  for (const [, value] of BARE.matchAll(/z-index:\s*(\d+)/g)) {
    assert.ok(
      Number(value) < level("z-map-ui"),
      `hand-written z-index: ${value} — use one of the --z-* levels`,
    );
  }
});

test("the readouts stay below anything clickable", () => {
  // The banner carries no level of its own. Inside the flex column it cannot
  // overlap the bar by construction, so the only bottom-edge component whose
  // stacking still has to be decided is the info panel.
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

// ── Dialogs ──────────────────────────────────────────────────────────────────

test("the action bar carries its own gap rather than borrowing one", () => {
  // Every dialog ends in the same action row, so the space above it has to
  // come from a rule rather than from whatever the last element in that
  // particular dialog happens to contribute. Contributions vary from 12 px to
  // nothing at all — a bordered scroll box has no trailing margin — and with
  // none, the buttons sit flush against the content and read as part of it.
  assert.match(block(".app-dialog__actions"), /margin-top:\s*16px/);
});

test("the full-bleed footers opt out of it", () => {
  // Two bars are exceptions. The print and placement bars are full-width
  // floors rather than trailing buttons: they carry a rule above and negative
  // margins that take them out to the dialog edge. Applying the standard gap
  // to them would leave a strip of background between the content and the
  // rule.
  const footer = block(".print-dialog__actions");
  assert.match(footer, /margin:\s*0 -20px -16px/);
  // The exception has the same specificity as the shared rule, so it can only
  // win by being declared after it. Moving it earlier in the file would
  // silently restore the gap.
  assert.ok(
    BARE.indexOf(".print-dialog__actions") >
      BARE.indexOf(".app-dialog__actions"),
    "the override has to be declared after the rule it overrides",
  );
});

test("nothing that ends a dialog is left touching the buttons", () => {
  // Every element that can be the last thing before an action bar carries a
  // bottom margin of its own, and the bar carries a top margin; adjacent
  // vertical margins collapse, so stating both is not double spacing. In
  // principle the bar's margin alone would do, but it does not for the entry
  // that is a scrolling box rather than a paragraph, so both are required.
  //
  // The list is written out rather than derived from the markup on purpose.
  // Adding a dialog then means adding a line here, which is one deliberate
  // moment of thought about where its last element ends.
  for (const selector of [
    ".app-dialog__hint",
    ".app-dialog__calc",
    ".confirm-dialog__detail",
    ".shortcuts-dialog__groups",
    ".territory-list__rows",
  ]) {
    assert.match(
      block(selector),
      /margin(-bottom)?:\s*[^;]*\b(?!0\b)\d+px/,
      `${selector} ends a dialog with no space after it`,
    );
  }
});
