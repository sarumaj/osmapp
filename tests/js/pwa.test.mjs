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
 * Enough of a browser for pwa.js to boot in.
 *
 * `readyState` is what the test is about, so it is a parameter; `worker` is
 * false for a browser that has no service workers at all. The document is
 * otherwise a stub that swallows the offline badge the module renders during
 * init, which is not what is under test here.
 */
function browser(readyState, worker = true) {
  const events = { window: {}, worker: {} };
  const registrations = [];

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
    getElementById: () => null,
    createElement: element,
  };
  const navigator = { onLine: true };
  if (worker) {
    navigator.serviceWorker = {
      controller: null,
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
  return { App, events, registrations };
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
