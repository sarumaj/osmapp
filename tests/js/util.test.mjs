/**
 * util.js: reading OSM tag values, and reading user preferences.
 *
 * ── tagText ───────────────────────────────────────────────────────────────
 *
 * Decides whether an OSM tag value carries any information, and normalizes it
 * if it does. Two separate features ask this about the same value — the map
 * tooltip in polygons.js and the locality name ranking in naming.js — so the
 * answer has to be identical for both. If they were to disagree, a card would
 * print a locality name that the tooltip beside it reports as having no
 * address, and nothing would flag the contradiction.
 *
 * ── The storage helpers ───────────────────────────────────────────────────
 *
 * These are harder to test than they look, because their entire contract is to
 * fail silently, and in a working browser they never fail at all. The
 * behavior therefore has to be driven by stubbing localStorage to break in
 * the specific ways real browsers break.
 *
 * Two of those are covered below and both are real. Some private browsing
 * modes throw on the *property access* `window.localStorage`, before any
 * method is called, so an implementation that opens its try block after the
 * access takes the whole app down during load. And a browser at its storage
 * quota throws from setItem while getItem continues to work, so reads must
 * keep succeeding after a write has failed.
 *
 * Everything stored here is a view preference, so the correct response to any
 * failure is to carry on without remembering.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/**
 * A localStorage that behaves. The failing variants are built inline in the
 * tests that need them, since each breaks in its own way.
 */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

/**
 * Load util.js against one localStorage stand-in.
 *
 * `storage` may be an object or a function. A function is invoked on every
 * property access, which is what lets a test make the *access itself* throw —
 * the Firefox private-mode case util.js exists to survive, and one an object
 * cannot reproduce.
 */
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
  // osmnx represents a missing tag as float NaN. The backend drops those
  // before serializing, but a file written by an older version or edited by
  // hand can still contain the stringified form, and the literal text "nan"
  // printed on a territory card is worse than an empty line.
  for (const value of [null, undefined, "", "   ", "nan", "NaN", "none", "None"]) {
    assert.equal(U.tagText(value), null, `expected nothing for ${JSON.stringify(value)}`);
  }
});

test("tagText joins a merged way's list of values", () => {
  // When osmnx collapses several OSM ways into one street edge it
  // concatenates their tags, so a value arrives as a list. The join has to
  // match what the backend's own _clean does to the same values, or the same
  // street reads differently depending on which path it came through.
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
  // Several preferences are stored as "0" or "1", and "0" is falsy. A helper
  // that tested the value for truthiness rather than for absence would treat
  // a stored "0" as nothing found and hand back the default, turning
  // "collapsed" into "expanded" on every reload.
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
  // A private browsing mode: the throw comes from evaluating
  // `window.localStorage` itself rather than from any method on it, which is
  // why the implementation has to put the property access inside its try.
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
  // A browser at its storage quota. Reads keep working and only writes
  // throw, so a failed write must not disable reading.
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

// ── The timing gate ──────────────────────────────────────────────────────────
//
// timed() wraps App.dom.onRole and App.ui's menu entries, so it runs on nearly
// every click in the app. Its whole job is to stay silent unless the page is
// served locally, and the failure is invisible in development — where the gate
// is open and everything looks right — and permanent in production, where the
// console fills up for somebody who cannot turn it off.

/** Load util.js for one hostname, capturing whatever console.time reports. */
function withHost(hostname) {
  const lines = [];
  const console_ = {
    time: (label) => lines.push(`time ${label}`),
    timeEnd: (label) => lines.push(`timeEnd ${label}`),
  };
  const window = { location: { hostname } };
  const util = loadApp(["util.js"], { window, console: console_ }).util;
  return { util, lines };
}

for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "", "dev.localhost", "LOCALHOST"]) {
  test(`${host || "(empty)"} counts as a development host`, () => {
    // Empty is what a file:// URL reports; the ".localhost" suffix is reserved
    // for loopback by RFC 6761 §6.3; the comparison is case-insensitive because
    // a hostname is.
    const { util, lines } = withHost(host);
    assert.equal(util.isLocal(), true);
    assert.equal(util.timed("job", () => 7), 7, "the value must pass through");
    assert.deepStrictEqual(lines, ["time job", "timeEnd job"]);
  });
}

for (const host of ["osmapp.example", "192.0.2.10", "localhost.example.com", "notlocalhost"]) {
  test(`${host} does not, so nothing is timed`, () => {
    // "localhost.example.com" is the one worth having: a suffix test the wrong
    // way round treats every host under a .example.com as local.
    const { util, lines } = withHost(host);
    assert.equal(util.isLocal(), false);
    assert.equal(util.timed("job", () => 7), 7);
    assert.deepStrictEqual(lines, []);
  });
}

test("a window with no location at all is not a development host", () => {
  // Distinct from an empty hostname, which is a file:// page and *is* local.
  // Reading a missing location through `|| ""` collapses the two.
  const lines = [];
  const util = loadApp(["util.js"], {
    window: {},
    console: { time: (l) => lines.push(l), timeEnd: (l) => lines.push(l) },
  }).util;
  assert.equal(util.isLocal(), false);
  util.timed("job", () => {});
  assert.deepStrictEqual(lines, []);
});

test("a handler that throws still closes its timer", () => {
  // console.time leaves the label open otherwise, and every later call for the
  // same one is answered with "Timer already exists" instead of a measurement.
  const { util, lines } = withHost("localhost");
  assert.throws(() => {
    util.timed("job", () => {
      throw new Error("boom");
    });
  }, /boom/);
  assert.deepStrictEqual(lines, ["time job", "timeEnd job"]);
});
