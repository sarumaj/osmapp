/**
 * The parts of pdfdoc.js that used to be internal/template.py.
 *
 * Only the pure geometry is exercised here. Loading pdf-lib and pdf.js and
 * composing a real PDF is an integration test that needs a browser and a
 * template file; what is worth pinning without one is the placeholder choice,
 * because it is the piece that can be wrong without looking wrong. A map box
 * detected one rectangle too far out puts the map on top of the card's own
 * frame, and the only way to notice is to print one.
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
  // Deliberately out of order: the territory box sits to the right on the
  // card, and the content stream is under no obligation to draw it second.
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

// pdf.js hands a whole path over as sub-operator codes plus one flat run of
// numbers, so reading a rectangle out means knowing what every other
// sub-operator consumes. Miscount by one and every rectangle after the first
// curve is nonsense — which is the failure that looks like a detector bug.
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
  // Half scale, shifted 10pt right and 20pt up — what a word processor's
  // wrapping `cm` looks like.
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
