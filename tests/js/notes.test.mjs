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
 * until it is compared with the preview it came from. Pinned with it: that a
 * glyph is filled with the even-odd rule, which is what makes the second ring
 * of a pin the hole in it rather than a second blob over it.
 *
 * The fourth is the box of words. The preview measures it in the canvas font
 * and the card draws it in another, so a box carried over unchanged clips the
 * last word off every label -- and it clips it inside an appearance stream,
 * where nothing but a rendered page shows it.
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

// -- The skeleton --------------------------------------------------------

/** A straight two-node skeleton, which every case here starts from. */
function skeleton(extra = {}) {
  return [
    { at: [0, 0], snapped: false },
    Object.assign({ at: [10, 0], snapped: false }, extra),
  ];
}

test("a skeleton of straight hops draws exactly its own points", () => {
  const N = notes();
  assert.deepEqual(N._shape(skeleton()), [
    [0, 0],
    [10, 0],
  ]);
});

test("a hop that follows something draws what it follows", () => {
  // A street path and a freehand sweep are the same thing to the geometry:
  // a run of points the hop goes through on its way to the node.
  const N = notes();
  const shape = N._shape(
    skeleton({
      via: [
        [3, 1],
        [6, 2],
      ],
      sweep: true,
    }),
  );
  assert.deepEqual(shape, [
    [0, 0],
    [3, 1],
    [6, 2],
    [10, 0],
  ]);
});

test("a bent hop passes through the handle that bends it", () => {
  // Which is the whole contract of the control point: the handle is dragged
  // to a place on the map, and the curve has to arrive there rather than
  // somewhere in the direction of it.
  const N = notes();
  const wanted = [5, 4];
  // The control point that puts the middle of the curve under the handle.
  const bend = [2 * wanted[0] - (0 + 10) / 2, 2 * wanted[1] - (0 + 0) / 2];
  const shape = N._shape(skeleton({ bend }));

  const middle = shape[(shape.length - 1) / 2];
  assert.deepEqual(middle, wanted);
  // And the ends stay where they were put.
  assert.deepEqual(shape[0], [0, 0]);
  assert.deepEqual(shape[shape.length - 1], [10, 0]);
});

test("a mark is drawn from its skeleton, not from the geometry beside it", () => {
  // The two are stored together, so a file whose points disagree with its
  // nodes has to have one of them win. The skeleton wins: it is what an edit
  // acts on, so the first drag would replace the other one anyway.
  const record = notes()._sanitize({
    kind: "line",
    points: [
      [99, 99],
      [98, 98],
    ],
    nodes: skeleton(),
    text: "",
  });
  assert.deepEqual(record.points, [
    [0, 0],
    [10, 0],
  ]);
  assert.equal(record.nodes.length, 2);
});

test("a broken skeleton is dropped and the mark keeps its geometry", () => {
  // Half a skeleton cannot be edited and must not be drawn from; the points
  // beside it are still a mark somebody made.
  const record = notes()._sanitize({
    kind: "line",
    points: [
      [1, 1],
      [2, 2],
    ],
    nodes: [{ at: [1, 1] }, { at: [Number.NaN, 2] }],
    text: "",
  });
  assert.deepEqual(record.points, [
    [1, 1],
    [2, 2],
  ]);
  assert.equal(record.nodes, undefined);
});

test("a mark with no skeleton carries no key for one", () => {
  // Absent rather than null: a session written before marks had a skeleton
  // and one written after it are the same file.
  const record = notes()._sanitize({
    kind: "line",
    points: [
      [1, 1],
      [2, 2],
    ],
    text: "",
  });
  assert.ok(!("nodes" in record));
});

test("a caption is a point kind, like a note and a pin", () => {
  const record = notes()._sanitize({
    kind: "text",
    points: [[8.5, 47.3]],
    text: "ODD SIDE",
  });
  assert.equal(record.kind, "text");
  assert.deepEqual(record.points, [[8.5, 47.3]]);
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

/**
 * Every annotation on a page, as dictionaries.
 *
 * By subtype rather than by position, because each note writes two objects --
 * the mark and its popup - and which order they land in is pdf-lib's business
 * rather than something worth pinning.
 */
function annotations(PDFLib, page) {
  const annots = page.node.Annots();
  const out = [];
  for (let i = 0; i < annots.size(); i++) out.push(annots.lookup(i, PDFLib.PDFDict));
  return out;
}

/**
 * A box of words as print.js hands one over: fractions of the frame
 * throughout, with the lines already wrapped and the box already measured
 * against the canvas font.
 */
function label(lines, grow) {
  return {
    lines,
    at: [0.4, 0.4],
    width: 0.2,
    height: 0.06,
    size: 0.02,
    pad: 0.004,
    step: 0.025,
    grow: grow || "right",
  };
}

/** Enough of a pdf-lib font for the label geometry to be measured. */
function stubFont(perCharacter = 5) {
  return {
    ref: { toString: () => "9 0 R" },
    widthOfTextAtSize: (text, size) => text.length * perCharacter * (size / 9),
    encodeText: (text) => `(${text})`,
  };
}

/** A square glyph a fifth of the frame wide, centred where asked. */
function glyph(kind, u, v) {
  const r = 0.1;
  return {
    kind,
    closed: true,
    text: kind === "note" ? "Zażółć gęślą jaźń" : "",
    subject: kind === "note" ? "Note" : "Pin",
    color: "#d40000",
    width: 2,
    paths: [
      [
        [u - r, v - r],
        [u + r, v - r],
        [u + r, v + r],
        [u - r, v + r],
      ],
      [
        [u - r / 2, v - r / 2],
        [u + r / 2, v - r / 2],
        [u, v + r / 2],
      ],
    ],
  };
}

test("notes reach the page as annotations a reader can open", async () => {
  const PDFLib = pdfLib();
  const P = pdfdoc();

  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);
  P._annotate(PDFLib, doc, page, AREA, [
    glyph("note", 0.5, 0.5),
    glyph("pin", 0.2, 0.8),
    {
      kind: "line",
      closed: false,
      paths: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      text: "Kolejowa",
      subject: "Mark",
      color: "#0000ff",
      width: 3,
    },
  ]);

  // Saved and reloaded rather than inspected in place: what is asserted has to
  // be what a reader would find in the file, not what this app put in memory.
  const reloaded = await PDFLib.PDFDocument.load(await doc.save());
  const all = annotations(PDFLib, reloaded.getPage(0));
  const value = (dict, key) => dict.get(PDFLib.PDFName.of(key));
  const marks = all.filter((d) => String(value(d, "Subtype")) === "/Ink");
  const at = (index) => marks[index];

  // Six objects for three notes: each mark and the window a reader opens on
  // it. The popup is why a comment list has something to show.
  assert.equal(all.length, 6);
  assert.equal(marks.length, 3);
  assert.equal(
    all.filter((d) => String(value(d, "Subtype")) === "/Popup").length,
    3,
  );

  // All three marks are ink, glyphs included. A reader that lets one be
  // selected and deleted lets all of them be, which is the whole reason a pin
  // is not filed as the popup note it more closely resembles.
  assert.deepEqual(
    [0, 1, 2].map((i) => String(value(at(i), "Subtype"))),
    ["/Ink", "/Ink", "/Ink"],
  );

  // The fields a comment list reads: who said it, when, and what kind of
  // thing it is. Without them a row is a shape with a string on it.
  assert.equal(value(at(0), "T").decodeText(), "OSM Territory Mapper");
  assert.ok(value(at(0), "CreationDate"), "no creation date");
  assert.equal(value(at(0), "Subj").decodeText(), "Note");
  assert.equal(value(at(2), "Subj").decodeText(), "Mark");

  // And each one points at its own window, which points back at it.
  for (const index of [0, 1, 2]) {
    const popup = at(index).lookup(PDFLib.PDFName.of("Popup"), PDFLib.PDFDict);
    assert.ok(popup, `mark ${index} has no popup`);
    assert.equal(String(popup.get(PDFLib.PDFName.of("Subtype"))), "/Popup");
    // Never printed: a note window on paper is a box over the map.
    assert.equal(popup.get(PDFLib.PDFName.of("F")), undefined);
  }

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

test("a glyph is filled through its holes and a mark is only stroked", () => {
  const PDFLib = pdfLib();
  const P = pdfdoc();

  return PDFLib.PDFDocument.create().then(async (doc) => {
    const page = doc.addPage([595, 842]);
    P._annotate(PDFLib, doc, page, AREA, [
      glyph("pin", 0.5, 0.5),
      {
        kind: "line",
        closed: false,
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

    const marks = annotations(PDFLib, page).filter(
      (d) => String(d.get(PDFLib.PDFName.of("Subtype"))) === "/Ink",
    );
    const streams = [0, 1].map((index) => {
      const form = marks[index]
        .lookup(PDFLib.PDFName.of("AP"), PDFLib.PDFDict)
        .lookup(PDFLib.PDFName.of("N"));
      return new TextDecoder().decode(
        PDFLib.decodePDFRawStream(form).decode(),
      );
    });

    // B* is fill-even-odd-and-stroke. Without the star the pin's inner ring is
    // painted over rather than punched out, and the glyph is a blob; without
    // the fill at all it is an outline of one.
    assert.match(streams[0], /\bB\*$/);
    // Both rings closed, or the fill runs between them.
    assert.equal((streams[0].match(/ h$/gm) || []).length, 2);
    // A mark has no fill to give it: an open stroke filled would join its own
    // ends across whatever it was drawn around.
    assert.match(streams[1], /\bS$/);
    assert.doesNotMatch(streams[1], /\bB/);
  });
});

// ── The words on the card ────────────────────────────────────────────────────

test("a label's box is widened to fit the font that draws it", () => {
  const P = pdfdoc();
  // The preview measures Arial and the card draws DejaVu, so the box arrives
  // sized for the wrong face. Kept as it came, it clips the last word off
  // every label - the appearance stream's BBox cuts anything past its edge.
  const wide = P._label(
    { label: label(["a very long line indeed"]), color: "#000000" },
    AREA,
    stubFont(20),
  );
  const boxWidth = wide.rect[2] - wide.rect[0];
  assert.ok(
    boxWidth > 0.2 * AREA.width,
    `box stayed at the width it arrived with (${boxWidth})`,
  );

  // And a box already wide enough is left alone, so the two outputs agree
  // wherever they can.
  const narrow = P._label(
    { label: label(["ab"]), color: "#000000" },
    AREA,
    stubFont(1),
  );
  assert.equal(narrow.rect[2] - narrow.rect[0], 0.2 * AREA.width);
});

test("a label grows away from the mark it belongs to", () => {
  const P = pdfdoc();
  const font = stubFont(20);
  const text = ["a very long line indeed"];

  // Right is the ordinary case: the box hangs off the mark's right side, so
  // its left edge is the one that stays put.
  const right = P._label(
    { label: label(text, "right"), color: "#000" },
    AREA,
    font,
  );
  assert.equal(right.rect[0], AREA.x + 0.4 * AREA.width);

  // Flipped to the left of its mark, the right edge is the fixed one -
  // growing the other way would run the box back over the glyph.
  const left = P._label(
    { label: label(text, "left"), color: "#000" },
    AREA,
    font,
  );
  assert.equal(left.rect[2], AREA.x + 0.6 * AREA.width);

  // A caption has no mark to avoid, so it grows both ways about its middle.
  const centre = P._label(
    { label: label(text, "centre"), color: "#000" },
    AREA,
    font,
  );
  assert.equal(
    (centre.rect[0] + centre.rect[2]) / 2,
    AREA.x + 0.5 * AREA.width,
  );
});

test("a note with no words to print gets no box", () => {
  const P = pdfdoc();
  assert.equal(P._label({ color: "#000000" }, AREA, stubFont()), null);
  // And no box without a font to draw it in, which is what keeps a card that
  // needs no typeface from fetching one.
  assert.equal(
    P._label({ label: label(["x"]), color: "#000" }, AREA, null),
    null,
  );
});

test("a caption is a FreeText, so a reader opens it for typing", async () => {
  const PDFLib = pdfLib();
  const P = pdfdoc();
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);

  P._annotate(
    PDFLib,
    doc,
    page,
    AREA,
    [
      {
        kind: "text",
        paths: [],
        closed: false,
        text: "ODD SIDE ONLY",
        subject: "Caption",
        color: "#8e44ad",
        label: label(["ODD SIDE ONLY"]),
      },
    ],
    stubFont(),
  );

  const marks = annotations(PDFLib, page).filter(
    (d) => String(d.get(PDFLib.PDFName.of("Subtype"))) !== "/Popup",
  );
  const name = (key) => PDFLib.PDFName.of(key);
  assert.equal(marks.length, 1);
  assert.equal(String(marks[0].get(name("Subtype"))), "/FreeText");
  // /DA is what a reader rebuilds an appearance from after somebody edits the
  // text, so it names the same font at the same size the box was drawn with,
  // and sets the pen's color: on a FreeText the lettering takes its color
  // from here, not from /C.
  const appearance = String(marks[0].get(name("DA")));
  assert.match(appearance, /\/OsmappSans [\d.]+ Tf/);
  assert.match(appearance, /0\.56 0\.27 0\.68 rg/);
  // And /C, which a reader paints *behind* a FreeText, stays white -- the
  // pen's color there would turn the caption into a solid block of it.
  assert.deepEqual(
    marks[0].get(name("C")).asArray().map(Number),
    [1, 1, 1],
  );
  assert.equal(String(marks[0].get(name("IT"))), "/FreeTextTypeWriter");
});

test("the caption's font is published where a reader looks it up", () => {
  // A FreeText's /DA is resolved against the document's form resources (PDF
  // 32000-1, 12.7.3.3). Without an entry there, a reader rebuilding the
  // caption after an edit substitutes a face and the Polish diacritics this
  // app embeds a font for drop out.
  const PDFLib = pdfLib();
  const P = pdfdoc();

  return PDFLib.PDFDocument.create().then((doc) => {
    const page = doc.addPage([595, 842]);
    P._annotate(
      PDFLib,
      doc,
      page,
      AREA,
      [
        {
          kind: "text",
          paths: [],
          closed: false,
          text: "ODD SIDE",
          subject: "Caption",
          color: "#8e44ad",
          label: label(["ODD SIDE"]),
        },
      ],
      stubFont(),
    );

    const name = (key) => PDFLib.PDFName.of(key);
    const form = doc.catalog.lookup(name("AcroForm"), PDFLib.PDFDict);
    const fonts = form
      .lookup(name("DR"), PDFLib.PDFDict)
      .lookup(name("Font"), PDFLib.PDFDict);
    assert.ok(fonts.get(name("OsmappSans")), "the face is not in /DR /Font");
    // Named for this app rather than F1: the card is printed onto somebody
    // else's template, which may carry a form whose fields use that name.
    assert.equal(fonts.keys().length, 1);
  });
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

    const annot = annotations(PDFLib, page).find(
      (d) => String(d.get(PDFLib.PDFName.of("Subtype"))) === "/Ink",
    );
    const rect = annot.lookup(PDFLib.PDFName.of("Rect"), PDFLib.PDFArray);
    const form = annot
      .lookup(PDFLib.PDFName.of("AP"), PDFLib.PDFDict)
      .lookup(PDFLib.PDFName.of("N"));
    const bbox = form.dict.lookup(PDFLib.PDFName.of("BBox"), PDFLib.PDFArray);

    assert.deepEqual(bbox.asRectangle(), rect.asRectangle());
  });
});

test("every pen the toolbar offers has the strings it asks for", () => {
  // notes.js builds "notes.hint<Tool>" from the tool that is selected, so a
  // pen added without its hint shows the key itself over the map. No
  // dictionary-parity test catches that: every language is equally missing it.
  const bundle = JSON.parse(
    readFileSync(join(ROOT, "src/osmapp/static/lang/en.json"), "utf8"),
  );
  const markup = readFileSync(
    join(ROOT, "src/osmapp/templates/index.html.j2"),
    "utf8",
  );
  const toolbar = markup.slice(markup.indexOf('id="tpl-notes-toolbar"'));
  const tools = [...toolbar.slice(0, toolbar.indexOf("</template>")).matchAll(
    /data-role="tool-(\w+)"/g,
  )].map((match) => match[1]);

  assert.deepEqual(tools, ["note", "pin", "draw", "text"]);
  for (const tool of tools) {
    const suffix = tool[0].toUpperCase() + tool.slice(1);
    assert.ok(bundle.notes["tool" + suffix], `notes.tool${suffix} is missing`);
    assert.ok(bundle.notes["hint" + suffix], `notes.hint${suffix} is missing`);
  }
  // And what the editor titles itself, and what a reader's comment list calls
  // the row - both keyed off the kind that was stored rather than the tool.
  for (const kind of ["Note", "Pin", "Line", "Text"]) {
    assert.ok(bundle.notes["title" + kind], `notes.title${kind} is missing`);
  }
  for (const kind of ["Note", "Pin", "Mark", "Text"]) {
    assert.ok(bundle.notes["kind" + kind], `notes.kind${kind} is missing`);
  }
});
