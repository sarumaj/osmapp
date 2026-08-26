/**
 * The wall map: every territory of a project on one sheet.
 *
 * Two things about it fail silently, which is why they are pinned here rather
 * than left to be noticed in a printer.
 *
 * The first is the sheet. The map area is handed to pdfdoc.js as a rectangle
 * in page coordinates, and a rectangle that runs off the page is refused
 * several seconds after the button, with a message about a rectangle. So the
 * placeholder has to sit inside the page at every size and both orientations.
 *
 * The second is the canvas. A card is A4 and 300 dpi across it is nine
 * megapixels; a wall map can be A0, and 300 dpi across that is a hundred and
 * forty. A canvas that large does not throw - it allocates, comes back blank,
 * and the first anyone knows of it is a white sheet of A1. So the resolution
 * has to fall back to whatever fits, and a card-sized frame has to be left at
 * the full 300 dpi it has always been drawn at.
 *
 * The rest is wiring, read off the sources for the same reason
 * print-decorations.test.mjs reads its own: a checkbox that is drawn but never
 * read, or a control the preferences forget, is how this ships half-working.
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
  join(ROOT, "src", "osmapp", "templates", "index.html.j2"),
  "utf8",
);
const PRINT = readFileSync(join(JS_DIR, "print.js"), "utf8");
const CONTROLS = readFileSync(join(JS_DIR, "controls.js"), "utf8");
const DICT = JSON.parse(
  readFileSync(join(ROOT, "src", "osmapp", "static", "lang", "en.json"), "utf8"),
);

const DIALOG = (() => {
  const start = INDEX.indexOf('id="tpl-print-dialog"');
  return INDEX.slice(start, INDEX.indexOf("</template>", start));
})();

/** print.js resolves its neighbors in init() and everything else at call time. */
function load() {
  const App = loadApp(["util.js", "print.js"], { window: {} });
  App.state = {};
  App.geometry = {};
  App.dom = {};
  App.i18n = { n: String, t: (key) => key };
  App.print.init();
  return App.print;
}

const SIZES = ["a4", "a3", "a2", "a1", "a0"];

// The browser limits print.js is staying under. Restated rather than read out
// of the source: a test that imports the number it is checking passes when
// somebody raises the number past what a browser will actually allocate.
const MAX_SIDE_PX = 8000;
const MAX_TOTAL_PX = 20e6;

// ── The sheet ────────────────────────────────────────────────────────────────

test("the map area sits inside the page, at every size and both ways round", () => {
  const print = load();
  for (const size of SIZES) {
    for (const landscape of [false, true]) {
      const { layout } = print.wallSheet(size, landscape);
      const box = layout.placeholder;
      assert.ok(box.width > 0 && box.height > 0, `${size} has no map area`);
      assert.ok(box.x >= 0 && box.y >= 0, `${size} starts off the page`);
      assert.ok(
        box.x + box.width <= layout.pageWidth + 1e-9 &&
          box.y + box.height <= layout.pageHeight + 1e-9,
        `${size} runs off the page`,
      );
    }
  }
});

test("landscape turns the sheet, and only the sheet", () => {
  const print = load();
  const portrait = print.wallSheet("a2", false).layout;
  const landscape = print.wallSheet("a2", true).layout;
  assert.equal(landscape.pageWidth, portrait.pageHeight);
  assert.equal(landscape.pageHeight, portrait.pageWidth);
  assert.ok(
    landscape.placeholder.width > landscape.placeholder.height,
    "a landscape sheet with an upright map area is not landscape",
  );
});

test("the heading is left room above the map, not printed over it", () => {
  const print = load();
  const { layout } = print.wallSheet("a3", false);
  const box = layout.placeholder;
  assert.ok(layout.fields.title, "no heading field");
  assert.ok(
    layout.fields.title.y >= box.y + box.height,
    "the heading sits inside the map area",
  );
  assert.ok(
    layout.fields.title.y + layout.fields.title.size <= layout.pageHeight,
    "the heading runs off the top of the page",
  );
});

test("an unknown sheet size is a sheet, not a crash", () => {
  const print = load();
  const { layout } = print.wallSheet("a7", false);
  assert.ok(layout.pageWidth > 0 && layout.pageHeight > 0);
});

// ── The canvas ───────────────────────────────────────────────────────────────

test("no sheet asks for a canvas the browser will hand back blank", () => {
  const print = load();
  for (const size of SIZES) {
    for (const landscape of [false, true]) {
      const sheet = print.wallSheet(size, landscape);
      const longest = Math.max(sheet.renderWidth, sheet.renderHeight);
      assert.ok(longest <= MAX_SIDE_PX, `${size} is ${longest} px on a side`);
      assert.ok(
        sheet.renderWidth * sheet.renderHeight <= MAX_TOTAL_PX,
        `${size} is ${sheet.renderWidth * sheet.renderHeight} px in total`,
      );
    }
  }
});

test("a small sheet is still drawn at the full 300 dpi", () => {
  const print = load();
  const sheet = print.wallSheet("a4", false);
  // 300 dpi is 300/72 px per point, and A4 minus its margins is nowhere near
  // either ceiling - so anything less here is the fallback firing when it
  // should not, and a card printed softer than it used to be.
  const expected = Math.floor((sheet.layout.placeholder.width * 300) / 72);
  assert.equal(sheet.renderWidth, expected);
});

test("a large sheet gives up resolution rather than pixels", () => {
  const print = load();
  const a4 = print.wallSheet("a4", false);
  const a0 = print.wallSheet("a0", false);
  const dpi = (sheet) => (sheet.renderWidth / sheet.layout.placeholder.width) * 72;
  assert.ok(dpi(a0) < dpi(a4), "A0 was not softened at all");
  // Still worth printing: a wall map is read from across a room, and below
  // about 100 dpi the street names on the basemap stop being names.
  assert.ok(dpi(a0) >= 100, `A0 fell to ${Math.round(dpi(a0))} dpi`);
  assert.ok(
    a0.renderWidth > a4.renderWidth,
    "the bigger sheet came out with fewer pixels across it",
  );
});

// ── The pens ─────────────────────────────────────────────────────────────

/** The `min`, `max`, `step` and `value` the markup gives a slider. */
function slider(role) {
  const tag = new RegExp(`<input[^>]*data-role="${role}"[^>]*>`).exec(DIALOG);
  assert.ok(tag, `no ${role} control in the print dialog`);
  const read = (name) => {
    const found = new RegExp(`${name}="([^"]*)"`).exec(tag[0]);
    assert.ok(found, `the ${role} control has no ${name}`);
    return Number(found[1]);
  };
  return {
    min: read("min"),
    max: read("max"),
    step: read("step"),
    value: read("value"),
  };
}

const longest = (box) => Math.max(box.width, box.height);

test("the card's two sliders are exactly the ones the markup ships", () => {
  // The dialog is drawn from the markup and re-cut by print.js the moment a
  // frame is adopted. Where the two disagree the slider jumps as it opens,
  // and the number somebody was looking at is not the one they get.
  const print = load();
  const pens = print.pens(print.layout().placeholder);
  const shipped = ({ min, max, step, value }) => ({ min, max, step, value });
  assert.deepEqual(shipped(pens.border), slider("width"));
  assert.deepEqual(shipped(pens.erase), slider("erase-size"));
});

test("a poster's border reaches as far across its sheet as a card's does", () => {
  // The point of the whole exercise. 8 pt is 1.5% of the card's map area and
  // reads as a deliberately heavy line; the same 8 pt is 0.24% of A0, which
  // is a line drawn for a sheet nobody is holding.
  const print = load();
  const card = print.layout().placeholder;
  const want = slider("width").max / longest(card);

  for (const size of SIZES) {
    for (const landscape of [false, true]) {
      const sheet = print.wallSheet(size, landscape);
      const share = sheet.pens.border.max / longest(sheet.layout.placeholder);
      // Loose, because the range is snapped to a step a readout can say: on
      // A1 that is 2 pt, and rounding 34.35 to it moves the top of the range
      // by one percent of itself.
      assert.ok(
        share > want * 0.85 && share < want * 1.15,
        `${size} tops out at ${(share * 100).toFixed(2)}% of the sheet, the card at ${(want * 100).toFixed(2)}%`,
      );
    }
  }
});

test("a bigger sheet is never offered a lighter pen", () => {
  const print = load();
  let previous = print.pens(print.layout().placeholder);
  for (const size of SIZES) {
    const pens = print.wallSheet(size, false).pens;
    const below = `${size} is offered less than the sheet under it`;
    assert.ok(pens.border.max >= previous.border.max, `${below}: border max`);
    assert.ok(pens.border.value >= previous.border.value, `${below}: border default`);
    assert.ok(pens.erase.max >= previous.erase.max, `${below}: eraser max`);
    previous = pens;
  }
  const a0 = print.wallSheet("a0", false).pens;
  const card = print.pens(print.layout().placeholder);
  assert.ok(a0.border.max > card.border.max * 3, "A0 is barely heavier than a card");
  assert.ok(a0.border.value > card.border.value, "an A0 poster opens with a card's hairline");
});

test("a landscape sheet gets much the same pen as the same sheet upright", () => {
  // Turning the paper changes what is on it, not how heavy a line has to be
  // to be seen from the other side of the room. Not identical, because the
  // title band comes off the height either way and so the map area is not a
  // rotation of itself - but the pen may not notice more than a step of that.
  const print = load();
  for (const size of SIZES) {
    const upright = print.wallSheet(size, false).pens;
    const turned = print.wallSheet(size, true).pens;
    for (const which of ["border", "erase"]) {
      const step = Math.max(upright[which].step, turned[which].step);
      for (const what of ["min", "max", "value"]) {
        // A step, or a fiftieth - whichever is the coarser. The band is what
        // is left of the difference once the map area is measured as a square
        // of the same area rather than by its longest side.
        const slack = Math.max(step, upright[which][what] / 50);
        assert.ok(
          Math.abs(upright[which][what] - turned[which][what]) <= slack,
          `${size} ${which} ${what}: ${upright[which][what]} upright, ${turned[which][what]} turned`,
        );
      }
    }
  }
});

test("every pen slider lands on its own stops", () => {
  // A range whose bounds are not multiples of its step cannot be dragged to
  // its own maximum, and a value the browser clamps comes to rest between two
  // stops - both of which read as a broken control rather than a rounded one.
  const print = load();
  const sheets = [
    { name: "card", pens: print.pens(print.layout().placeholder) },
    ...SIZES.map((size) => ({ name: size, pens: print.wallSheet(size, false).pens })),
  ];
  for (const { name, pens } of sheets) {
    for (const [which, range] of Object.entries(pens)) {
      const where = `${name} ${which}`;
      assert.ok(range.step > 0, `${where} has no step`);
      assert.ok(range.min > 0, `${where} starts at nothing`);
      assert.ok(range.max > range.min, `${where} has no range at all`);
      assert.ok(
        range.value >= range.min && range.value <= range.max,
        `${where} opens outside its own range`,
      );
      for (const [what, value] of Object.entries(range)) {
        if (what === "scale") continue;
        const stops = value / range.step;
        assert.ok(
          Math.abs(stops - Math.round(stops)) < 1e-9,
          `${where} ${what} is ${value}, which is not a multiple of ${range.step}`,
        );
      }
    }
    assert.ok(
      pens.erase.max > pens.border.max,
      `${name}: the eraser cannot take out the heaviest border it can draw`,
    );
  }
});

test("a pen width is remembered against the card, not against the sheet", () => {
  // One preference record serves both dialogs, so a saved number has to mean
  // the same thing on A0 as on a card - which it only does if what is stored
  // is the width on the card's frame. Stored raw, a congregation that prints
  // cards at 2 pt gets a 2 pt line on a poster: the bug, back through the
  // preferences.
  assert.match(PRINT, /function _penStore\(/);
  const save = PRINT.slice(PRINT.indexOf("function _savePreferences("));
  assert.match(save.slice(0, 700), /_penBase\(role\)[\s\S]{0,80}_penStore\(input\)/);
  const load_ = PRINT.slice(PRINT.indexOf("function _loadPreferences("));
  assert.match(load_.slice(0, 700), /if \(_penBase\(role\)\) return;/);
});

test("the sliders are re-cut whenever a frame is adopted", () => {
  // Not only on the sheet select: a template carries its own map area, and
  // the wall map's own sheet is applied through the same call.
  const apply = PRINT.slice(
    PRINT.indexOf("function _applyLayout("),
    PRINT.indexOf("function _renderScale("),
  );
  assert.match(apply, /_syncPenControls\(\)/);
  assert.ok(
    apply.indexOf("_syncPenControls()") < apply.indexOf("_sizeEraseCursor()"),
    "the erase cursor is sized from a brush width that is about to change",
  );
});

// ── The wiring ───────────────────────────────────────────────────────────────

test("every wall-map control is in the dialog and hidden from a card", () => {
  for (const role of ["page-size", "landscape", "title-text", "numbers", "outline"]) {
    assert.match(
      DIALOG,
      new RegExp(`data-role="${role}"`),
      `no ${role} control in the print dialog`,
    );
  }
  const group = /<fieldset[^>]*data-role="wall-only"[^>]*>/.exec(DIALOG);
  assert.ok(group, "the wall-map controls are not in a group of their own");
  assert.ok(
    group[0].includes("hidden"),
    "a card would open showing the wall-map controls",
  );
});

test("the two drawing switches are read, and reach the canvas", () => {
  // Gated on the mode as well as on the box. Both live in the dialog in card
  // mode too - hidden, not removed - and the area outline is ticked by
  // default, so reading the box alone would draw the whole surveyed boundary
  // across every card from a fieldset nobody can see.
  assert.match(PRINT, /numbers:\s*wall && _checked\("numbers"\)/);
  assert.match(PRINT, /outline:\s*wall && _checked\("outline"\)/);
  assert.match(PRINT, /if \(o\.numbers\) _drawNumbers/);
  assert.match(PRINT, /if \(o\.outline\) _drawOutline/);
});

test("the numbers are furniture, not part of the border", () => {
  // The border canvas is composited at the border's own opacity and the
  // eraser cuts holes in it. A number at 30%, or with a sweep taken out of
  // it, is a territory nobody can refer to - and the number is the one thing
  // a wall map is read for.
  assert.match(PRINT, /function _drawDecorations[\s\S]{0,200}_drawNumbers/);
  const border = PRINT.slice(
    PRINT.indexOf("function _drawBorder"),
    PRINT.indexOf("function _drawOutline"),
  );
  assert.ok(
    !border.includes("_drawNumbers"),
    "the numbers are drawn onto the canvas the eraser works on",
  );
});

test("every wall-map control is remembered between sheets", () => {
  const roles = /PREFERENCES_ROLES = \[([\s\S]*?)\]/.exec(PRINT)[1];
  for (const role of ["page-size", "landscape", "numbers", "outline", "title-text"]) {
    assert.match(roles, new RegExp(`"${role}"`), `${role} is forgotten`);
  }
});

test("a wall map neither marks a territory printed nor renames one", () => {
  // The mark means "this territory's card has been produced" and the label is
  // what that card called it. A poster of forty territories is not forty
  // cards: marking them all would wipe the record of which ones have actually
  // been handed out, and naming them all would give every territory on the
  // project the wall map's heading.
  const run = PRINT.slice(PRINT.indexOf("function _run("), PRINT.indexOf("function _compose("));
  assert.match(run, /if \(wall\) return;/);
  const after = run.slice(run.indexOf("if (wall) return;"));
  assert.match(after, /App\.polygons\.markPrinted\(target, true\)/);
  assert.match(after, /App\.polygons\.setLabel\(target, territory\)/);
});

test("the sheet writes what a card called a territory, else its number", () => {
  assert.match(PRINT, /var label = App\.polygons\.labelOf\(feature\);\n\s*if \(label\) return label;/);
  assert.match(PRINT, /_territoryText\(feature, index\)/);
});

test("the sheet is reachable without knowing it exists", () => {
  assert.match(CONTROLS, /id: "wallcard"/);
  assert.match(CONTROLS, /App\.print\.printWallCard\(\)/);
  assert.match(CONTROLS, /labelKey: "toolbar\.labelWallCard"/);
});

test("every key the wall map asks for is in the dictionary", () => {
  // Every print.* key print.js names, not only the wall map's: the scan is
  // the same either way, and a typo in a card's key is the same silent
  // English-in-Polish failure.
  const keys = [
    ...new Set([...PRINT.matchAll(/"(print\.[\w.]+)"/g)].map((m) => m[1])),
  ];
  assert.ok(keys.length > 20, "the scanner found nothing - check the regex");
  for (const key of keys) {
    const value = key.split(".").reduce((node, part) => node && node[part], DICT);
    assert.equal(typeof value, "string", `${key} is not in en.json`);
  }
});
