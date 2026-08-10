/**
 * The scale bar and the compass rose.
 *
 * A card is read away from the screen that drew it, by somebody walking down
 * a street with no way to check it. That makes these two the only things on a
 * card that can be *confidently* wrong: a border in the wrong place is
 * obvious next to the map, but a bar of the right length under the wrong
 * number, or a needle off by a sign, looks exactly like a correct one and is
 * believed.
 *
 * So the two pure halves are pinned here — which round number the bar claims
 * and how long it is, and which way each of the four points ends up facing —
 * and the wiring around them is checked against the sources, because a
 * checkbox that is drawn but never read is the other way this ships broken.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const JS_DIR = join(ROOT, "src", "osmapp", "static", "js");
const INDEX = readFileSync(
  join(ROOT, "src", "osmapp", "templates", "index.html"),
  "utf8",
);
const PRINT = readFileSync(join(JS_DIR, "print.js"), "utf8");
const DICT = JSON.parse(
  readFileSync(join(ROOT, "src", "osmapp", "static", "lang", "en.json"), "utf8"),
);

/**
 * print.js resolves its neighbors in init() and everything else at call
 * time, so a bare object per neighbor and an init() is the whole standing-up
 * cost. Nothing here opens a dialog.
 */
function load() {
  const window = {};
  const App = loadApp(["util.js", "print.js"], { window });
  App.state = {};
  App.geometry = {};
  App.dom = {};
  App.i18n = {
    n: (value) => String(value),
    // Enough to tell metres from kilometers apart, which is what the label
    // tests are actually asking about.
    t: (key, vars) => `${vars.value} ${key === "print.scaleKm" ? "km" : "m"}`,
  };
  App.print.init();
  return App.print;
}

const EPS = 1e-9;

// ── The bar ──────────────────────────────────────────────────────────────────

test("the bar claims a round number of metres, never the exact fit", () => {
  const print = load();
  // 1000 px of card at 1 m/px: 30% of it is 300 m, so 200 is the answer —
  // 250 would fit and is not a number anybody measures with.
  assert.equal(print.scaleFor(1, 1000).meters, 200);
});

test("every round number is 1, 2 or 5 times a power of ten", () => {
  const print = load();
  const seen = new Set();
  for (let mpp = 0.01; mpp < 5000; mpp *= 1.07) {
    const bar = print.scaleFor(mpp, 1000);
    const digits = bar.meters / Math.pow(10, Math.floor(Math.log10(bar.meters)));
    assert.ok(
      [1, 2, 5].some((step) => Math.abs(digits - step) < 1e-9),
      `${bar.meters} m is not a round distance`,
    );
    seen.add(bar.meters);
  }
  assert.ok(seen.size > 10, "the sweep never changed the answer — check it");
});

test("the bar is as long as the distance it claims", () => {
  const print = load();
  for (const mpp of [0.05, 0.4, 3, 17, 250]) {
    const bar = print.scaleFor(mpp, 1000);
    assert.ok(
      Math.abs(bar.px * mpp - bar.meters) < EPS,
      "the bar and its label disagree",
    );
  }
});

test("the bar always fits on the card", () => {
  const print = load();
  for (let mpp = 0.01; mpp < 5000; mpp *= 1.13) {
    const bar = print.scaleFor(mpp, 1000);
    assert.ok(bar.px <= 300 + EPS, `${bar.px} px of a 1000 px card`);
    assert.ok(bar.px > 0);
  }
});

test("long distances are labelled in kilometers", () => {
  const print = load();
  assert.match(print.scaleFor(20, 1000).label, /km$/);
  assert.match(print.scaleFor(0.5, 1000).label, /m$/);
});

test("a card with no width and a view with no scale get no bar", () => {
  const print = load();
  assert.equal(print.scaleFor(1, 0), null);
  assert.equal(print.scaleFor(0, 1000), null);
  assert.equal(print.scaleFor(NaN, 1000), null);
});

// ── The rose ─────────────────────────────────────────────────────────────────

/** Canvas coordinates: +x is right, +y is *down*. */
const UP = [0, -1];
const DOWN = [0, 1];
const LEFT = [-1, 0];
const RIGHT = [1, 0];

function near(actual, expected) {
  assert.ok(
    Math.abs(actual[0] - expected[0]) < 1e-9 &&
      Math.abs(actual[1] - expected[1]) < 1e-9,
    `${JSON.stringify(actual)} is not ${JSON.stringify(expected)}`,
  );
}

test("on an unturned frame north is up and east is right", () => {
  const print = load();
  near(print.compassVector(0, 0), UP);
  near(print.compassVector(90, 0), RIGHT);
  near(print.compassVector(180, 0), DOWN);
  near(print.compassVector(270, 0), LEFT);
});

test("a quarter turn takes north with it, the right way round", () => {
  // print.js turns the map counter-clockwise for a positive rotation, so up
  // goes to the left. The sign here is the whole bug this test exists for.
  const print = load();
  near(print.compassVector(0, 90), LEFT);
  near(print.compassVector(0, -90), RIGHT);
  near(print.compassVector(0, 180), DOWN);
});

test("the four points stay square to each other at any angle", () => {
  const print = load();
  for (const rotation of [0, 7, 45, 123.5, -68, 180]) {
    const [n, e] = [
      print.compassVector(0, rotation),
      print.compassVector(90, rotation),
    ];
    assert.ok(Math.abs(n[0] * e[0] + n[1] * e[1]) < 1e-9, "N and E are not square");
    near(print.compassVector(180, rotation), [-n[0], -n[1]]);
    near(print.compassVector(270, rotation), [-e[0], -e[1]]);
  }
});

test("a missing rotation is no rotation", () => {
  const print = load();
  near(print.compassVector(0, undefined), UP);
});

// ── The wiring ───────────────────────────────────────────────────────────────

test("both boxes are in the dialog, and off until asked for", () => {
  const start = INDEX.indexOf('id="tpl-print-dialog"');
  const body = INDEX.slice(start, INDEX.indexOf("</template>", start));
  for (const role of ["scale", "compass"]) {
    const box = new RegExp(`<input[^>]*data-role="${role}"[^>]*>`).exec(body);
    assert.ok(box, `no ${role} checkbox`);
    assert.ok(
      !box[0].includes("checked"),
      `${role} would change every card already in circulation`,
    );
  }
});

test("both boxes are remembered between cards", () => {
  // Everything else in the dialog is. A setting that has to be re-ticked for
  // every territory in a village is a setting nobody uses twice.
  const roles = /PREFERENCES_ROLES = \[([\s\S]*?)\]/.exec(PRINT)[1];
  assert.match(roles, /"scale"/);
  assert.match(roles, /"compass"/);
});

test("both boxes are read, and reach the canvas", () => {
  assert.match(PRINT, /scale:\s*_checked\("scale"\)/);
  assert.match(PRINT, /compass:\s*_checked\("compass"\)/);
  assert.match(PRINT, /if \(o\.scale\) _drawScaleBar/);
  assert.match(PRINT, /if \(o\.compass\) _drawCompass/);
});

test("the furniture is drawn after the border, not under it", () => {
  // A scale bar with a red territory outline through it is not a scale bar,
  // and the eraser is aimed at the border rather than at the furniture.
  assert.ok(
    PRINT.indexOf("_drawDecorations(ctx)") > PRINT.indexOf("_drawBorder();"),
  );
});

test("the compass letters are translated rather than spelled out", () => {
  // German is N/O/S/W and French N/E/S/O. A hardcoded "E" is a compass that
  // is wrong in two of the four languages this app ships.
  assert.ok(!/["']E["']\s*,\s*bearing/.test(PRINT), "a letter is hardcoded");
  for (const key of ["compassN", "compassE", "compassS", "compassW"]) {
    assert.equal(typeof DICT.print[key], "string", `print.${key} is missing`);
    assert.match(PRINT, new RegExp(`print\\.${key}`));
  }
});

// ── The hidden layer ─────────────────────────────────────────────────────────
//
// The sentences are translated in the browser and posted beside the picture,
// because the dictionary is here and rebuilding them on the server would mean
// a second copy of it — and a Polish congregation printing English cards.

test("the card is sent the same sentences the tooltip shows", () => {
  assert.match(PRINT, /App\.polygons\.clusterLines\(_feature\)/);
  assert.match(PRINT, /form\.append\("info", line\)/);
});

test("the sentences are built once, not restated here", () => {
  // print.js must not grow its own idea of what a territory is worth saying
  // about; polygons.clusterLines is the single source and the tooltip's too.
  for (const key of ["tooltip.buildings", "tooltip.streets", "tooltip.areaM"]) {
    assert.ok(!PRINT.includes(key), `${key} is being rebuilt in print.js`);
  }
});
