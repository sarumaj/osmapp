/**
 * Whatever in pdfdoc.js used to live in internal/template.py.
 *
 * Nothing but the pure geometry runs here. Pulling in pdf-lib and pdf.js and
 * building a real PDF is an integration test wanting a browser and a template
 * file. What can be nailed down without either is the placeholder choice,
 * since that is the piece capable of being wrong while looking fine. Detect
 * the map box one rectangle too far out and the map lands on the card's own
 * frame — and the only way anyone finds out is by printing one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

const A4 = { width: 595, height: 842 };

function load() {
  return loadApp(["pdfdoc.js"], { window: {}, document: {}, navigator: {} }).pdfdoc;
}

const rect = (x, y, width, height) => ({ x, y, width, height });
const text = (x, y, str, size = 10) => ({ x, y, size, text: str });

test("the smallest rectangle around the marker wins", () => {
  const pdfdoc = load();
  const frame = rect(20, 20, 555, 800); // the card outline
  const mapBox = rect(30, 400, 534, 350);

  const found = pdfdoc._placeholderFor(
    [frame, mapBox],
    [text(300, 500, "MIEJSCE NA MAPĘ")],
    A4.width,
    A4.height,
  );

  assert.deepEqual(found.placeholder, mapBox);
});

test("with no marker, the largest text-free rectangle wins", () => {
  const pdfdoc = load();
  const withText = rect(20, 20, 500, 300);
  const empty = rect(30, 400, 400, 300);

  const found = pdfdoc._placeholderFor(
    [withText, empty],
    [text(100, 100, "Numer terenu")],
    A4.width,
    A4.height,
  );

  assert.deepEqual(found.placeholder, empty);
});

test("hairlines and the page frame are not candidates", () => {
  const pdfdoc = load();
  const hairline = rect(20, 20, 500, 2); // a rule
  const pageFrame = rect(0, 0, 595, 842); // the whole page
  const mapBox = rect(30, 400, 400, 300);

  const found = pdfdoc._placeholderFor(
    [hairline, pageFrame, mapBox],
    [],
    A4.width,
    A4.height,
  );

  assert.deepEqual(found.candidates, [mapBox]);
  assert.deepEqual(found.placeholder, mapBox);
});

test("no usable rectangle is reported rather than guessed", () => {
  const pdfdoc = load();
  assert.equal(pdfdoc._placeholderFor([rect(0, 0, 10, 10)], [], A4.width, A4.height), null);
});

test("dotted leaders become the field anchors, left to right", () => {
  const pdfdoc = load();
  // Out of order on purpose. The territory box is the right-hand one on the
  // card, and nothing obliges the content stream to draw it second.
  const fields = pdfdoc._fieldsFor([
    text(479, 761.88, "..............", 14),
    text(122.3, 761.88, "…………", 14),
    text(200, 300, "Miejscowość", 9),
  ]);

  assert.deepEqual(fields, {
    locality: { x: 125.3, y: 766.88, size: 14 },
    territory: { x: 482, y: 766.88, size: 14 },
  });
});

test("a template with one leader gets one field, not a shifted pair", () => {
  const pdfdoc = load();
  const fields = pdfdoc._fieldsFor([text(122, 700, "......", 12)]);
  assert.deepEqual(Object.keys(fields), ["locality"]);
});

// A whole path reaches us as sub-operator codes plus one flat run of numbers,
// so pulling a rectangle out means knowing what each of the others eats. Be off
// by one and every rectangle after the first curve is garbage — a failure that
// presents itself as a bug in the detector.
const OPS = {
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
};

test("rectangles survive a path that also contains curves", () => {
  const pdfdoc = load();
  const out = [];
  pdfdoc._pathRects(
    [
      [OPS.moveTo, OPS.curveTo, OPS.closePath, OPS.rectangle],
      [0, 0, 1, 2, 3, 4, 5, 6, 30, 400, 534, 350],
    ],
    OPS,
    [1, 0, 0, 1, 0, 0],
    out,
  );

  assert.deepEqual(out, [rect(30, 400, 534, 350)]);
});

test("the current transform is applied, not ignored", () => {
  const pdfdoc = load();
  const out = [];
  // Halved, then moved 10pt right and 20pt up: roughly what a word
  // processor's wrapping `cm` does.
  pdfdoc._pathRects(
    [[OPS.rectangle], [60, 800, 200, 100]],
    OPS,
    [0.5, 0, 0, 0.5, 10, 20],
    out,
  );

  assert.deepEqual(out, [rect(40, 420, 100, 50)]);
});

test("an unrecognized sub-operator stops the walk instead of misreading it", () => {
  const pdfdoc = load();
  const out = [];
  pdfdoc._pathRects(
    [[999, OPS.rectangle], [30, 400, 534, 350]],
    OPS,
    [1, 0, 0, 1, 0, 0],
    out,
  );

  assert.deepEqual(out, []);
});

// pdf.js 6 moved teardown from the document onto its loading task. The old
// call is inside a `.then` nobody awaits, so getting this wrong does not fail
// loudly — it rejects the layout chain and the template silently falls back
// to the default box.
test("a document is closed through its loading task, not its proxy", async () => {
  const pdfdoc = load();
  let closed = 0;
  pdfdoc._close({ loadingTask: { destroy: () => { closed++; return Promise.resolve(); } } });
  await Promise.resolve();
  assert.equal(closed, 1);
});

test("closing tolerates a v5 proxy, a failing teardown, and nothing at all", async () => {
  const pdfdoc = load();
  let closed = 0;
  pdfdoc._close({ destroy: () => { closed++; } });
  pdfdoc._close({ loadingTask: { destroy: () => Promise.reject(new Error("worker gone")) } });
  pdfdoc._close(null);
  pdfdoc._close({});
  await Promise.resolve();
  assert.equal(closed, 1);
});
