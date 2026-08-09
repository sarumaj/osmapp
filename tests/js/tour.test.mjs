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
  return loadApp(["util.js", "tour.js"], { window }).tour;
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

test("a targeted step says where its bubble goes", () => {
  // A targeted step without a preferred side still works — the placer falls
  // back through all four — but the omission is always an oversight. `dock`
  // counts: a target too big to sit beside names a corner instead.
  const sloppy = load()
    .steps()
    .filter((step) => step.target && !step.placement && !step.dock)
    .map((step) => step.id);
  assert.deepStrictEqual(sloppy, []);
});

test("every side effect a step causes is also undone by it", () => {
  // enter() without exit() is a dialog the tour opens and never closes, which
  // survives the tour and is then sitting over the user's own map.
  const leaky = load()
    .steps()
    .filter((step) => step.enter && !step.exit)
    .map((step) => step.id);
  assert.deepStrictEqual(leaky, []);
});

test("the sample block is contiguous", () => {
  // The sample is loaded and unloaded by comparing `demo` between the step
  // being left and the one being entered. A gap in the middle would unload
  // and reload the village mid-block, resetting the map view each time.
  const flags = load()
    .steps()
    .map((step) => !!step.demo);
  const runs = flags.filter((on, i) => on && !flags[i - 1]).length;
  assert.equal(runs, 1);
});

// ── Pairing ──────────────────────────────────────────────────────────────────

test("a screen the app opens is introduced by the control that opens it", () => {
  // The whole point of `origin`: the step showing the partition dialog names
  // the Split button, and an earlier step has already spotlighted it. An
  // origin nobody was shown first is a ring round a button the user has never
  // been told about.
  const steps = load().steps();
  const orphans = [];

  steps.forEach((step, i) => {
    if (!step.origin) return;
    const introduced = steps
      .slice(0, i)
      .some((earlier) => earlier.target === step.origin);
    if (!introduced) orphans.push(step.id);
  });

  assert.deepStrictEqual(orphans, []);
});

test("an origin ring is only drawn where nothing is dimmed", () => {
  // On a dim step the spotlight's shadow has already darkened everything but
  // its own target, so an origin there is an outline round something in the
  // dark — visible, unreadable, and worse than nothing.
  const wrong = load()
    .steps()
    .filter((step) => step.origin && step.highlight !== "ring")
    .map((step) => step.id);
  assert.deepStrictEqual(wrong, []);
});

test("every toolbar button the tour points at exists in the toolbar", () => {
  // The tour addresses buttons by the data-action controls.js writes from the
  // spec id. Renaming an id there is a step that silently loses its target
  // here, and a step with no target still runs — as a centred card explaining
  // a button that is not highlighted.
  const controls = readFileSync(
    join(ROOT, "src", "osmapp", "static", "js", "controls.js"),
    "utf8",
  );
  const known = new Set(
    [...controls.matchAll(/\bid:\s*"([\w-]+)"/g)].map((m) => m[1]),
  );

  const missing = [];
  for (const step of load().steps()) {
    for (const selector of [step.target, step.origin]) {
      const action = selector && selector.match(/\[data-action="([\w-]+)"\]/);
      if (action && !known.has(action[1])) missing.push(`${step.id} → ${action[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test("offline drops both halves of the print pair", () => {
  // The print view composes a card from live tiles. Keeping the menu entry
  // while dropping the view it opens would introduce a button whose screen
  // never arrives, which is the one thing worse than not mentioning it.
  const offline = loadApp(["util.js", "tour.js"], {
    window: { localStorage: fakeStorage(), location: { search: "" } },
    navigator: { onLine: false },
  }).tour;

  const gated = offline
    .steps()
    .filter((step) => step.available)
    .map((step) => [step.id, step.available()]);

  assert.deepStrictEqual(gated, [
    ["printMenu", false],
    ["print", false],
  ]);
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
