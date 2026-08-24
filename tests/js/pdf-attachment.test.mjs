/**
 * Reading a project back out of a PDF this app wrote.
 *
 * Every card printed onto a template, and now every wall map, carries the
 * project inside it - that is what makes the sheet on somebody's desk a
 * restore point, and it is the promise the "Embed the project in the PDF"
 * checkbox makes. The write side is pdf-lib's `attach()`; the read side is
 * pdfdoc.js walking the /EmbeddedFiles name tree by hand, because pdf-lib
 * offers no reader for one.
 *
 * That walk is the half that can be wrong while looking right, and it was:
 * pdf-lib's two-argument `lookup(key, type)` *asserts* rather than tests, so
 * asking a flat name tree for its /Kids threw "Expected instance of ..., but
 * got instance of undefined" - and a flat name tree with no kids is exactly
 * what pdf-lib writes, so every card the app produced was unreadable by the
 * app that produced it.
 *
 * A stub cannot catch that. The shape of the tree and the behavior of an
 * absent key are both pdf-lib's, so the library is the thing under test here
 * as much as the reader is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";
import { loadPdfLib } from "./helpers/pdflib.mjs";

const PDFLib = loadPdfLib();
const NAME = "osmapp-project.json.gz";
const PAYLOAD = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);

const pdfdoc = loadApp(["pdfdoc.js"], {
  window: {},
  document: {},
  navigator: {},
}).pdfdoc;

/** A one-page document carrying `attachments`, saved and loaded back. */
async function roundTrip(attachments) {
  const doc = await PDFLib.PDFDocument.create();
  doc.addPage([200, 200]);
  for (const [name, bytes] of attachments) {
    doc.attach(bytes, name, { mimeType: "application/gzip" });
  }
  return PDFLib.PDFDocument.load(await doc.save());
}

test("a project written by this app is read back by this app", async () => {
  const doc = await roundTrip([[NAME, PAYLOAD]]);
  assert.deepEqual(
    Array.from(pdfdoc._attachment(PDFLib, doc, NAME)),
    Array.from(PAYLOAD),
  );
});

test("a PDF carrying nothing is empty, not an error", async () => {
  // What a holiday photo saved as a PDF looks like on the import path. The
  // caller turns a null into "that PDF does not carry a saved project"; a
  // throw from in here would surface as whatever pdf-lib called it.
  const doc = await roundTrip([]);
  assert.equal(pdfdoc._attachment(PDFLib, doc, NAME), null);
});

test("a PDF carrying somebody else's attachment is empty too", async () => {
  const doc = await roundTrip([["notes.txt", new Uint8Array([1, 2, 3])]]);
  assert.equal(pdfdoc._attachment(PDFLib, doc, NAME), null);
});

test("the project is found among other attachments", async () => {
  const doc = await roundTrip([
    ["notes.txt", new Uint8Array([9])],
    [NAME, PAYLOAD],
    ["photo.jpg", new Uint8Array([8])],
  ]);
  assert.deepEqual(
    Array.from(pdfdoc._attachment(PDFLib, doc, NAME)),
    Array.from(PAYLOAD),
  );
});
