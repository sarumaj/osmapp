/**
 * Registering the service worker, which is the whole of the app's offline
 * story: nothing is precached until a worker installs, and the first thing
 * anyone notices missing is the card font, because it is fetched when a PDF is
 * composed rather than when the page loads.
 *
 * The seam being pinned is the timing. Start-up runs from a timer after
 * DOMContentLoaded, so by the time this module is reached the load event may
 * already have fired -- which it does on any page whose assets are all in the
 * HTTP cache, meaning every visit after the first. A registration that waits
 * for an event already past never happens at all, and nothing on screen says
 * so.
 *
 * The second half of this file is the version banner, which has the same shape
 * of problem: something true of the page that is not true of the code it is
 * running. Navigation is network-first and the assets are cache-first, so
 * after a deploy the browser shows the new HTML -- banner included -- while
 * every script on it is still the old build out of the worker's cache. The
 * banner is only worth having if it names what is running, so pwa.js asks the
 * controlling worker and corrects it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/**
 * Run `body` with the hourly update check stubbed out.
 *
 * pwa.js schedules that check with a bare `setInterval`, which resolves to
 * Node's own inside the loader, and a live one-hour timer would hold the test
 * runner's event loop open until it fired.
 */
async function withoutTimers(body) {
  const real = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await body();
  } finally {
    globalThis.setInterval = real;
  }
}

/** A node the offline badge can be built from and appended to. */
function element() {
  return {
    classList: { toggle() {}, add() {} },
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    remove() {},
    style: {},
  };
}

/**
 * The client half of the version banner, as the server rendered it.
 *
 * `classes` and `title` are recorded rather than swallowed: the correction is
 * only useful if someone can tell it happened, and the tooltip is where the
 * reason lives.
 */
function bannerValue(served) {
  const classes = [];
  return {
    textContent: served,
    title: "",
    classes,
    // Closed over rather than reached through `this`: classList.add is called
    // as a method of classList, so `this.classes` there is not the node's.
    classList: { add: (name) => classes.push(name) },
  };
}

/**
 * Enough of a browser for pwa.js to boot in.
 *
 * `readyState` is what the test is about, so it is a parameter; `worker` is
 * false for a browser that has no service workers at all. The document is
 * otherwise a stub that swallows the offline badge the module renders during
 * init, which is not what is under test here.
 */
function browser(readyState, worker = true, options = {}) {
  const events = { window: {}, worker: {} };
  const registrations = [];
  const posted = [];
  const banner = options.served ? bannerValue(options.served) : null;

  const window = {
    addEventListener(type, handler) {
      events.window[type] = handler;
    },
    console,
  };
  const document = {
    readyState,
    body: element(),
    addEventListener() {},
    getElementById: (id) => (id === "version-client" ? banner : null),
    createElement: element,
  };
  const navigator = { onLine: true };
  if (worker) {
    navigator.serviceWorker = {
      // A page with no controller is a first visit: nothing is being served
      // from a cache yet, so the rendered banner is already right.
      controller: options.controlled
        ? {
            postMessage(data) {
              posted.push(data);
            },
          }
        : null,
      addEventListener(type, handler) {
        events.worker[type] = handler;
      },
      register(url, options) {
        registrations.push({ url, options });
        return Promise.resolve({
          addEventListener() {},
          update: () => Promise.resolve(),
        });
      },
    };
  }

  const App = loadApp(["pwa.js"], { window, document, navigator });
  return { App, events, registrations, posted, banner };
}

/** Boot a controlled page and have its worker answer with `running`. */
function answering(served, running) {
  const page = browser("complete", true, { controlled: true, served });
  page.App.pwa.init();
  page.events.worker.message({ data: { type: "VERSION", client: running } });
  return page;
}

test("a page that has finished loading registers the worker straight away", () =>
  withoutTimers(async () => {
    // The ordinary case, and the one that was silently doing nothing: on a
    // warm cache the load event fires before start-up reaches this module.
    const page = browser("complete");
    page.App.pwa.init();

    assert.equal(page.registrations.length, 1);
    assert.equal(page.registrations[0].url, "/sw.js");
    // Without this the browser may answer the update check from its own HTTP
    // cache and miss a deploy for as long as that entry lives.
    assert.equal(page.registrations[0].options.updateViaCache, "none");
  }));

test("a page still loading waits for it, so the worker does not race the map", () =>
  withoutTimers(async () => {
    const page = browser("loading");
    page.App.pwa.init();

    assert.equal(page.registrations.length, 0, "registered before load");
    page.events.window.load();
    assert.equal(page.registrations.length, 1);
  }));

test("a browser with no service worker still finishes starting up", () =>
  withoutTimers(async () => {
    const page = browser("complete", false);
    page.App.pwa.init();

    assert.ok(page.App._loaded.includes("pwa"));
  }));

// ── the version banner ───────────────────────────────────────────────────────

test("a controlled page asks its worker which build it is running", () =>
  withoutTimers(async () => {
    const page = browser("complete", true, { controlled: true, served: "1.5.0" });
    page.App.pwa.init();

    assert.deepEqual(page.posted, [{ type: "GET_VERSION" }]);
  }));

test("a first visit asks nothing and leaves the banner alone", () =>
  withoutTimers(async () => {
    // No controller means no cache in play: the HTML and the scripts it pulled
    // in are the same build, so there is nothing to correct and nobody to ask.
    const page = browser("complete", true, { controlled: false, served: "1.5.0" });
    page.App.pwa.init();

    assert.deepEqual(page.posted, []);
    assert.equal(page.banner.textContent, "1.5.0");
    assert.deepEqual(page.banner.classes, []);
  }));

test("an up-to-date worker leaves the banner alone", () =>
  withoutTimers(async () => {
    const page = answering("1.5.0", "1.5.0");

    assert.equal(page.banner.textContent, "1.5.0");
    assert.deepEqual(page.banner.classes, [], "nothing is stale, so nothing is marked");
  }));

test("a stale worker corrects the banner to what is running", () =>
  withoutTimers(async () => {
    // The case the whole thing exists for: the server rendered 1.5.0 into the
    // page, and every script on that page came out of 1.4.0's cache.
    const page = answering("1.5.0", "1.4.0");

    assert.equal(page.banner.textContent, "1.4.0 \u2192 1.5.0");
    assert.deepEqual(page.banner.classes, ["is-stale"]);
    assert.match(
      page.banner.title,
      /1\.4\.0.*1\.5\.0/,
      "the accessible name should spell out what the arrow means",
    );
  }));

test("a second answer cannot correct the correction", () =>
  withoutTimers(async () => {
    // The banner now reads "1.4.0 -> 1.5.0". Reconciling that against 1.4.0 a
    // second time would compare the running version against a string that is
    // no longer a version at all.
    const page = answering("1.5.0", "1.4.0");
    page.events.worker.message({ data: { type: "VERSION", client: "1.4.0" } });

    assert.equal(page.banner.textContent, "1.4.0 \u2192 1.5.0");
    assert.deepEqual(page.banner.classes, ["is-stale"]);
  }));

test("a worker that answers with nothing leaves the banner as rendered", () =>
  withoutTimers(async () => {
    const page = answering("1.5.0", undefined);

    assert.equal(page.banner.textContent, "1.5.0");
    assert.deepEqual(page.banner.classes, []);
  }));
