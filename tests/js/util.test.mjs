/**
 * The two helpers every other module used to carry its own copy of.
 *
 * Both fail in the same quiet way. `tagText` decides whether an OSM tag
 * carries anything, and it is asked that question twice about the same value:
 * once by the tooltip in polygons.js and once by the locality ranking in
 * naming.js. While those were two implementations, a value one counted as a
 * name and the other counted as blank would print a locality on a card that
 * the tooltip beside it says has no address — and nothing would report it.
 *
 * The storage helpers fail even more quietly, because their whole contract is
 * to swallow. Firefox in private mode throws on the *property access*, not on
 * the call, so a naive `try { window.localStorage.getItem(…) }` written with
 * the access outside the try takes the app down on load. Every caller here is
 * storing a view preference, so the right answer to any failure is always
 * "carry on without remembering" — which is exactly the behaviour a test has
 * to pin, since in a working browser it never happens.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/** A localStorage that works. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

function withStorage(storage) {
  const window = {};
  Object.defineProperty(window, "localStorage", {
    get() {
      if (typeof storage === "function") return storage();
      return storage;
    },
  });
  return loadApp(["util.js"], { window }).util;
}

// ── tagText ──────────────────────────────────────────────────────────────────

const U = withStorage(fakeStorage());

test("tagText trims and passes ordinary values through", () => {
  assert.equal(U.tagText("  Hauptstraße "), "Hauptstraße");
  assert.equal(U.tagText(12), "12");
});

test("tagText treats absent, blank and NaN-ish values as nothing", () => {
  // osmnx writes a missing tag as float NaN; the backend drops those, but an
  // older export or a hand-edited import can still carry the stringified form,
  // and "nan" printed on a territory card is worse than a blank.
  for (const value of [null, undefined, "", "   ", "nan", "NaN", "none", "None"]) {
    assert.equal(U.tagText(value), null, `expected nothing for ${JSON.stringify(value)}`);
  }
});

test("tagText joins a merged way's list of values", () => {
  // osmnx concatenates the tags of every OSM way it collapsed into one edge,
  // matching what the backend's own _clean does to the same values.
  assert.equal(U.tagText(["Bahnhofstraße", "Marktplatz"]), "Bahnhofstraße; Marktplatz");
  assert.equal(U.tagText(["Bahnhofstraße"]), "Bahnhofstraße");
  assert.equal(U.tagText([]), null);
  assert.equal(U.tagText([null, ""]), null);
});

test("tagOf reads one property off a feature, tolerating a bare one", () => {
  const feature = { properties: { "addr:street": " Am Markt ", "addr:city": "nan" } };
  assert.equal(U.tagOf(feature, "addr:street"), "Am Markt");
  assert.equal(U.tagOf(feature, "addr:city"), null);
  assert.equal(U.tagOf(feature, "addr:place"), null);
  assert.equal(U.tagOf({}, "name"), null);
  assert.equal(U.tagOf(null, "name"), null);
});

// ── storage, when it works ───────────────────────────────────────────────────

test("readLocal and writeLocal round-trip, and readLocal falls back", () => {
  const store = fakeStorage();
  const util = withStorage(store);

  assert.equal(util.readLocal("osmapp.basemap", "osm"), "osm", "absent key uses the fallback");
  assert.equal(util.writeLocal("osmapp.basemap", "imagery"), true);
  assert.equal(util.readLocal("osmapp.basemap", "osm"), "imagery");
  assert.equal(util.removeLocal("osmapp.basemap"), true);
  assert.equal(util.readLocal("osmapp.basemap", "osm"), "osm");
});

test("readLocal defaults to null when no fallback is given", () => {
  assert.equal(withStorage(fakeStorage()).readLocal("nothing.here"), null);
});

test("an empty string is a stored value, not an absent one", () => {
  // The toolbar and the numbers both store "0"/"1"; a helper that treated any
  // falsy string as absent would turn "collapsed" back into "expanded".
  const util = withStorage(fakeStorage({ "osmapp.labels.visible": "0" }));
  assert.equal(util.readLocal("osmapp.labels.visible", "1"), "0");
});

test("readJson parses, and returns the fallback for corrupt or absent values", () => {
  const util = withStorage(fakeStorage({ good: '{"zoom":13}', bad: "{oh no", nul: "null" }));
  assert.deepEqual(util.readJson("good", null), { zoom: 13 });
  assert.equal(util.readJson("bad", null), null, "corrupt JSON must not throw");
  assert.equal(util.readJson("nul", "fallback"), "fallback");
  assert.equal(util.readJson("absent", "fallback"), "fallback");
});

test("writeJson round-trips through readJson", () => {
  const util = withStorage(fakeStorage());
  assert.equal(util.writeJson("osmapp.map.view", { lat: 50, lng: 8.27, zoom: 15 }), true);
  assert.deepEqual(util.readJson("osmapp.map.view", null), { lat: 50, lng: 8.27, zoom: 15 });
});

// ── storage, when it does not ────────────────────────────────────────────────

test("a storage that throws on access degrades instead of exploding", () => {
  // Firefox private mode. The throw is on `window.localStorage` itself, which
  // is why the property access has to be inside the try.
  const util = withStorage(() => {
    throw new Error("The operation is insecure.");
  });

  assert.equal(util.readLocal("osmapp.basemap", "osm"), "osm");
  assert.equal(util.readLocal("osmapp.basemap"), null);
  assert.equal(util.writeLocal("osmapp.basemap", "imagery"), false);
  assert.equal(util.removeLocal("osmapp.basemap"), false);
  assert.deepEqual(util.readJson("osmapp.map.view", { zoom: 13 }), { zoom: 13 });
  assert.equal(util.writeJson("osmapp.map.view", { zoom: 13 }), false);
});

test("a storage that refuses writes still reads", () => {
  // Safari past its quota: getItem works, setItem throws.
  const store = fakeStorage({ "osmapp.toolbar.collapsed": "1" });
  store.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const util = withStorage(store);

  assert.equal(util.readLocal("osmapp.toolbar.collapsed", "0"), "1");
  assert.equal(util.writeLocal("osmapp.toolbar.collapsed", "0"), false);
});

test("a missing localStorage entirely is not an error", () => {
  const util = loadApp(["util.js"], { window: {} }).util;
  assert.equal(util.readLocal("anything", "fallback"), "fallback");
  assert.equal(util.writeLocal("anything", "x"), false);
});
