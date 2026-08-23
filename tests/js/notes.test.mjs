/**
 * Notes: what survives a round trip, and where they land on a card.
 *
 * Three seams are pinned here, and they are the three where a note can be
 * wrong while everything on screen looks right.
 *
 * The first is the record filter. Notes arrive from a saved session, an export
 * file and a printed card, so it is the one place a malformed one can get in --
 * and a note carrying a NaN draws nothing on the map and an empty rectangle on
 * a card, both of which read as "the note was lost" rather than "the file was
 * wrong".
 *
 * The second is the clip. A mark that runs off the frame has to stop at its
 * edge, because the card is a map box printed on a form: ink past the edge is
 * ink across somebody's territory number.
 *
 * The third is the annotation geometry. A canvas measures y downward and a PDF
 * measures it upward, so getting the flip backwards mirrors every comment
 * about the middle of the card - which still looks like a perfectly good card
 * until it is compared with the preview it came from.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The vendored pdf-lib, run as the UMD bundle it is.
 *
 * A plain import cannot reach it: package.json declares this project a module,
 * so Node parses the bundle as ESM and hands back an empty namespace. This is
 * the same trick helpers/load.mjs uses on the app's own files, and it is what
 * lets the annotation test assert against a real PDF rather than against the
 * dictionaries this app believes it wrote.
 */
function pdfLib() {
  const source = readFileSync(
    join(
      ROOT,
      "src/osmapp/static/vendor/unpkg.com/pdf-lib/dist/pdf-lib.min.js",
    ),
    "utf8",
  );
  const module = { exports: {} };
  new Function("module", "exports", source)(module, module.exports);
  return module.exports;
}

const notes = () =>
  loadApp(["util.js", "state.js", "notes.js"], { window: {} }).notes;
const print = () => loadApp(["util.js", "print.js"], { window: {} }).print;
const pdfdoc = () => loadApp(["pdfdoc.js"], { window: {} }).pdfdoc;

// ── The records ──────────────────────────────────────────────────────────────

test("a note keeps its text, its color and its point", () => {
  const record = notes()._sanitize({
    kind: "note",
    points: [[8.54, 47.37]],
    text: "gate is round the back",
    color: "#00AA00",
    width: 3,
  });

  assert.deepEqual(record, {
    kind: "note",
    points: [[8.54, 47.37]],
    text: "gate is round the back",
    color: "#00AA00",
    width: 3,
  });
});

test("a point note keeps only its first point", () => {
  // Not a rejection: a record that grew a second point is still a note about
  // the place the first one names, and dropping the note would lose more than
  // dropping the stray coordinate does.
  const record = notes()._sanitize({
    kind: "pin",
    points: [
      [1, 2],
      [3, 4],
    ],
  });
  assert.deepEqual(record.points, [[1, 2]]);
});

test("coordinates that are not coordinates are dropped", () => {
  const N = notes();
  assert.equal(N._sanitize({ kind: "note", points: [[NaN, 47]] }), null);
  assert.equal(N._sanitize({ kind: "note", points: [[8.5, 200]] }), null);
  assert.equal(N._sanitize({ kind: "note", points: [] }), null);
  assert.equal(N._sanitize({ kind: "note" }), null);
});

test("a line needs two points, and an unknown kind is not a note at all", () => {
  const N = notes();
  assert.equal(N._sanitize({ kind: "line", points: [[1, 2]] }), null);
  assert.ok(
    N._sanitize({
      kind: "line",
      points: [
        [1, 2],
        [3, 4],
      ],
    }),
  );
  assert.equal(N._sanitize({ kind: "arrow", points: [[1, 2]] }), null);
});

test("a color that is not a hex color falls back rather than reaching markup", () => {
  // The color is interpolated into the marker's inline style, so this is the
  // gate between a saved file and an attribute value.
  const record = notes()._sanitize({
    kind: "pin",
    points: [[1, 2]],
    color: '"><script>alert(1)</script>',
  });
  assert.match(record.color, /^#[0-9a-f]{6}$/i);
});

// ── The clip ─────────────────────────────────────────────────────────────────

test("a line wholly inside the frame comes back unchanged", () => {
  const runs = print().clipToFrame([
    [0.2, 0.2],
    [0.5, 0.5],
    [0.8, 0.3],
  ]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [
    [0.2, 0.2],
    [0.5, 0.5],
    [0.8, 0.3],
  ]);
});

test("a line leaving the frame stops at the edge", () => {
  const runs = print().clipToFrame([
    [0.5, 0.5],
    [1.5, 0.5],
  ]);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0][0], [0.5, 0.5]);
  assert.equal(runs[0][1][0], 1);
});

test("a line that leaves and comes back is two runs, not one straight across", () => {
  // The join is the point: treated as one run, the gap would be drawn as a
  // chord across the part of the card the mark deliberately left.
  const runs = print().clipToFrame([
    [0.5, 0.5],
    [0.5, 2],
    [0.6, 2],
    [0.6, 0.5],
  ]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0][1][1], 1);
  assert.equal(runs[1][0][1], 1);
});

test("a line entirely outside the frame produces nothing", () => {
  assert.deepEqual(
    print().clipToFrame([
      [2, 2],
      [3, 3],
    ]),
    [],
  );
});

// ── On the page ──────────────────────────────────────────────────────────────

const AREA = { x: 30, y: 400, width: 500, height: 300 };

test("the top of the map image is the top of the map box", () => {
  const P = pdfdoc();
  // v = 0 is the top of the canvas and therefore the *high* y in user space.
  assert.deepEqual(P._onPage([0, 0], AREA), [30, 700]);
  assert.deepEqual(P._onPage([1, 1], AREA), [530, 400]);
  assert.deepEqual(P._onPage([0.5, 0.5], AREA), [280, 550]);
});

test("a color becomes the three components a PDF is written in", () => {
  const P = pdfdoc();
  assert.deepEqual(P._rgb("#ffffff"), [1, 1, 1]);
  assert.deepEqual(P._rgb("#000000"), [0, 0, 0]);
  // Anything unreadable is black rather than a crash or a missing key: a mark
  // in the wrong color is still a mark, and a card is worth more than a hue.
  assert.deepEqual(P._rgb("rebeccapurple"), [0, 0, 0]);
});

test("a stroke's rectangle clears its own thickness", () => {
  const box = pdfdoc()._bounds(
    [
      [
        [10, 10],
        [20, 30],
      ],
    ],
    2,
  );
  assert.deepEqual(box, [8, 8, 22, 32]);
});

// ── The annotations themselves ───────────────────────────────────────────────

test("notes reach the page as annotations a reader can open", async () => {
  const PDFLib = pdfLib();
  const P = pdfdoc();

  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);
  P._annotate(PDFLib, doc, page, AREA, [
    { kind: "note", at: [0.5, 0.5], text: "Zażółć gęślą jaźń", color: "#d40000" },
    { kind: "pin", at: [0, 1], text: "", color: "#00aa00" },
    {
      kind: "line",
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      text: "Kolejowa",
      color: "#0000ff",
      width: 3,
    },
  ]);

  // Saved and reloaded rather than inspected in place: what is asserted has to
  // be what a reader would find in the file, not what this app put in memory.
  const reloaded = await PDFLib.PDFDocument.load(await doc.save());
  const annots = reloaded.getPage(0).node.Annots();
  const at = (index) => annots.lookup(index, PDFLib.PDFDict);
  const value = (dict, key) => dict.get(PDFLib.PDFName.of(key));

  assert.equal(annots.size(), 3);
  assert.deepEqual(
    [0, 1, 2].map((i) => String(value(at(i), "Subtype"))),
    ["/Text", "/Text", "/Ink"],
  );

  // The text is the whole point of a comment, and Polish is the language this
  // app spends a subsetted font on elsewhere for exactly this reason.
  assert.equal(value(at(0), "Contents").decodeText(), "Zażółć gęślą jaźń");
  assert.equal(value(at(2), "Contents").decodeText(), "Kolejowa");

  // Print flag, or a reader is entitled to leave it off the paper.
  assert.deepEqual(
    [0, 1, 2].map((i) => value(at(i), "F").asNumber()),
    [4, 4, 4],
  );

  // Every one carries its own appearance, so the card looks the same wherever
  // it is opened rather than however that viewer draws a comment.
  for (const index of [0, 1, 2]) {
    assert.ok(
      at(index).lookup(PDFLib.PDFName.of("AP"), PDFLib.PDFDict),
      `annotation ${index} has no appearance stream`,
    );
  }

  // The note sits over the middle of the map box, which is where it was put.
  const rect = at(0)
    .lookup(PDFLib.PDFName.of("Rect"), PDFLib.PDFArray)
    .asRectangle();
  assert.equal(rect.x + rect.width / 2, 280);
  assert.equal(rect.y + rect.height / 2, 550);
});

test("an appearance box is its annotation's rectangle", () => {
  // Not a detail: a viewer maps the appearance's BBox onto the Rect, so two
  // that disagree stretch the drawing into a rectangle it was not drawn for.
  const PDFLib = pdfLib();
  const P = pdfdoc();

  return PDFLib.PDFDocument.create().then((doc) => {
    const page = doc.addPage([595, 842]);
    P._annotate(PDFLib, doc, page, AREA, [
      {
        kind: "line",
        paths: [
          [
            [0.1, 0.1],
            [0.9, 0.9],
          ],
        ],
        text: "",
        color: "#123456",
        width: 2,
      },
    ]);

    const annot = page.node.Annots().lookup(0, PDFLib.PDFDict);
    const rect = annot.lookup(PDFLib.PDFName.of("Rect"), PDFLib.PDFArray);
    const form = annot
      .lookup(PDFLib.PDFName.of("AP"), PDFLib.PDFDict)
      .lookup(PDFLib.PDFName.of("N"));
    const bbox = form.dict.lookup(PDFLib.PDFName.of("BBox"), PDFLib.PDFArray);

    assert.deepEqual(bbox.asRectangle(), rect.asRectangle());
  });
});
