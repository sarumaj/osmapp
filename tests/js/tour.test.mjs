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

test("a class a step points at belongs to one thing", () => {
  // The language step spent a release pointing at the basemap picker: it
  // named .tb-item--select, and by then the toolbar had two tiles carrying
  // that class. querySelector answers with whichever the panel built first,
  // and a spotlight on the wrong control is not a failure anything reports.
  //
  // So: every class a step names must appear on at most one element in the
  // page. Classes the templates never mention are built by a module or by a
  // Leaflet plugin (.trim-marker, .leaflet-control-geocoder) and are left to
  // the modules that own them.
  const template = readFileSync(
    join(ROOT, "src", "osmapp", "templates", "index.html.j2"),
    "utf8",
  );
  const elements = [...template.matchAll(/class="([^"]*)"/g)].map((m) =>
    m[1].split(/\s+/),
  );

  const shared = [];
  for (const step of load().steps()) {
    for (const selector of [step.target, step.origin]) {
      if (!selector) continue;
      for (const [, name] of selector.matchAll(/(?:^|[\s>])\.([\w-]+)/g)) {
        const count = elements.filter((list) => list.includes(name)).length;
        if (count > 1) shared.push(`${step.id} → .${name} (${count})`);
      }
    }
  }
  assert.deepStrictEqual(shared, []);
});

test("every mode a step switches on is one the tour can switch off", () => {
  // Steps turn modal tools on in enter() and off again in exit(), and that is
  // the ordinary path. _closeModes is the other one: a step whose enter()
  // threw, a tour abandoned with Escape, or a tour started while the user was
  // already in a mode of their own. It was written when cut and merge were
  // the only two modes and did not grow when the trim and outline steps
  // arrived — which handed a boundary back to a tool still running on the
  // sample's.
  const source = readFileSync(
    join(ROOT, "src", "osmapp", "static", "js", "tour.js"),
    "utf8",
  );
  const steps = source.slice(
    source.indexOf("var STEPS = ["),
    source.indexOf("\n  ];"),
  );
  const modes = new Set(
    [...steps.matchAll(/App\.state\.(\w+Mode)/g)].map((m) => m[1]),
  );
  assert.ok(modes.size > 0, "no step switches a mode on any more");

  const start = source.indexOf("function _closeModes()");
  assert.notEqual(start, -1, "the tour has no way to close a mode");
  const body = source.slice(start, source.indexOf("\n  }\n", start));

  const stranded = [...modes].filter((mode) => !body.includes(mode));
  assert.deepStrictEqual(stranded, []);
});

test("the menu entry the print step rings carries the role it names", () => {
  // The quieter half of the same failure: this step named
  // [data-role="print"] on a menu entry that never carried one, so the ring
  // it asked for was drawn round nothing and the step arrived as a centred
  // card about an entry nobody could see. The entries are built from a list
  // and their text is translated, so a name that survives translation is the
  // only thing outside the menu can match on.
  const ui = readFileSync(
    join(ROOT, "src", "osmapp", "static", "js", "ui.js"),
    "utf8",
  );
  const step = load()
    .steps()
    .find((candidate) => candidate.id === "printMenu");
  assert.ok(step, "the step that reaches a card from a territory is gone");
  const role = step.target.match(/\[data-role="([\w-]+)"\]/);
  assert.notEqual(role, null, "the print step no longer names a role");

  assert.match(
    ui,
    /if \(item\.role\) node\.dataset\.role = item\.role;/,
    "showContextMenu drops the name its items are given",
  );

  const menu = ui.indexOf("function showPolygonContextMenu(");
  assert.notEqual(menu, -1, "the territory menu is gone");
  const body = ui.slice(menu, ui.indexOf("\n  }\n", menu));
  assert.match(
    body,
    new RegExp(`role: "${role[1]}"`),
    "no entry in the territory menu answers to the name the step points at",
  );
});

test("offline drops no step, the print chain included", () => {
  // Composition is client-side, so printing works offline and no step may be
  // gated on the connection. The three print steps — the toolbar button, the
  // menu entry that reaches the same place from a territory, and the view
  // itself — are the ones at risk: gate one of the three and not the other two
  // and the tour offers a button whose screen never arrives.
  const offline = loadApp(["util.js", "tour.js"], {
    window: { localStorage: fakeStorage(), location: { search: "" } },
    navigator: { onLine: false },
  }).tour;

  const unavailable = offline
    .steps()
    .filter((step) => step.available && !step.available())
    .map((step) => step.id);

  assert.deepStrictEqual(unavailable, []);
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
