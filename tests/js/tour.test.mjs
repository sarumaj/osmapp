/**
 * The tour is content plus one flag, and both fail quietly.
 *
 * A step naming a key that is not in the dictionary renders the raw key path
 * to the one audience guaranteed not to understand it — someone opening the
 * app for the first time. And a suppression flag that does not stick turns a
 * one-off welcome into something that reappears on every visit, which is the
 * fastest way to make people distrust the whole app.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DICT = JSON.parse(
  readFileSync(join(ROOT, "src", "osmapp", "static", "lang", "en.json"), "utf8"),
);

/** Minimal localStorage: enough for get/set/remove, and it can be made to throw. */
function fakeStorage(broken = false) {
  const map = new Map();
  const boom = () => {
    throw new Error("storage disabled");
  };
  return {
    getItem: broken ? boom : (k) => (map.has(k) ? map.get(k) : null),
    setItem: broken ? boom : (k, v) => map.set(k, String(v)),
    removeItem: broken ? boom : (k) => map.delete(k),
    _map: map,
  };
}

function load({ search = "", storage = fakeStorage() } = {}) {
  const window = { localStorage: storage, location: { search } };
  return loadApp(["tour.js"], { window }).tour;
}

function dig(key) {
  return key.split(".").reduce((node, part) => (node ? node[part] : undefined), DICT);
}

// ── Content ──────────────────────────────────────────────────────────────────

test("every step names a title and a body that exist in the dictionary", () => {
  const tour = load();
  const missing = [];
  for (const step of tour.steps()) {
    for (const key of [tour.titleKey(step), tour.bodyKey(step)]) {
      if (typeof dig(key) !== "string") missing.push(key);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test("the chrome around the steps is translated too", () => {
  for (const key of [
    "tour.next",
    "tour.back",
    "tour.finish",
    "tour.skip",
    "tour.dontShow",
    "tour.progress",
    "toolbar.help",
    "toolbar.labelHelp",
  ]) {
    assert.equal(typeof dig(key), "string", `${key} is missing`);
  }
});

test("step ids are unique", () => {
  const ids = load()
    .steps()
    .map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a step either has no target or a placement for it", () => {
  // A targeted step without a preferred side still works — the placer falls
  // back through all four — but the omission is always an oversight.
  const sloppy = load()
    .steps()
    .filter((step) => step.target && !step.placement)
    .map((step) => step.id);
  assert.deepStrictEqual(sloppy, []);
});

// ── Suppression ──────────────────────────────────────────────────────────────

test("the tour opens by itself until it has been seen", () => {
  const tour = load();
  assert.equal(tour.shouldAutoStart(), true);
  tour.setSuppressed(true);
  assert.equal(tour.shouldAutoStart(), false);
  tour.setSuppressed(false);
  assert.equal(tour.shouldAutoStart(), true);
});

test("tour=1 and tour=0 in the query string beat the stored flag", () => {
  const seen = fakeStorage();
  seen.setItem("osmapp.tour.seen.v1", "1");

  assert.equal(load({ search: "?tour=1", storage: seen }).shouldAutoStart(), true);
  assert.equal(load({ search: "?tour=0" }).shouldAutoStart(), false);
});

test("storage that throws means the tour is offered, not an exception", () => {
  const tour = load({ storage: fakeStorage(true) });
  assert.equal(tour.isSuppressed(), false);
  assert.doesNotThrow(() => tour.setSuppressed(true));
  assert.equal(tour.shouldAutoStart(), true);
});
