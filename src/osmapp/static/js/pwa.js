/**
 * pwa.js - service worker registration, the update prompt, and the online
 * indicator.
 *
 * Two decisions worth knowing about:
 *
 * The worker is never activated silently. A new build waits until the user
 * says so, because the undo stack in history.js lives in memory and is not
 * part of the IndexedDB session - swapping the app out mid-edit would throw it
 * away, and the debounced save means the last second of work with it.
 *
 * Network-dependent controls are disabled rather than left to fail. Fetching
 * OSM data, geocoding and PDF composition all need the server, and a button
 * that produces a silent nothing is worse than one that is visibly off.
 *
 * The version banner is corrected from here rather than trusted as rendered.
 * Navigation is network-first and the assets are cache-first, so between a
 * deploy and the reload above the page is the new HTML running the old
 * JavaScript - and the banner, being part of that HTML, names a build the
 * browser is not running. The controlling worker is the one thing on the page
 * that belongs to the same generation as the code, so it is asked.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.pwa = (function () {
  "use strict";

  var _waiting = null;
  var _reloading = false;
  var _versionSettled = false;

  function init() {
    _bindConnectivity();
    _apply(navigator.onLine !== false);

    if (!("serviceWorker" in navigator)) {
      App._loaded.push("pwa");
      return;
    }

    // Registration competes with the initial Overpass fetch for bandwidth on
    // a phone, and nothing on screen depends on it, so it waits for load -
    // unless load has already been and gone. Start-up runs from a timer after
    // DOMContentLoaded and every module ahead of this one runs first, which is
    // long enough for a page whose assets are all in the HTTP cache to have
    // finished loading; a listener added after that never fires, and the app
    // runs with no worker at all. Nothing on screen says so, because the only
    // thing missing is the offline copy: the shell is not precached, and the
    // first thing to notice is a card that cannot be composed with the
    // connection down, since the face it embeds was never stored.
    if (document.readyState === "complete") _register();
    else window.addEventListener("load", _register);

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      // Only ever reached after the user accepted the update.
      if (!_reloading) return;
      window.location.reload();
    });

    _checkRunningVersion();

    App._loaded.push("pwa");
  }

  function _register() {
    navigator.serviceWorker
      .register("/sw.js", {
        scope: "/",
        // Without this the browser may serve sw.js from the HTTP cache and
        // miss an update for as long as that entry lives.
        updateViaCache: "none",
      })
      .then(_watch)
      .catch(function (error) {
        // A failed registration must never take the app down with it.
        if (window.console && console.warn) {
          console.warn("service worker registration failed", error);
        }
      });
  }

  function _watch(registration) {
    if (registration.waiting && navigator.serviceWorker.controller) {
      _offerUpdate(registration.waiting);
    }

    registration.addEventListener("updatefound", function () {
      var installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", function () {
        // `controller` is null on the very first install; there is nothing to
        // update *from*, so no prompt.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          _offerUpdate(installing);
        }
      });
    });

    // Coming back online is the moment a new build is most likely waiting.
    window.addEventListener("online", function () {
      registration.update().catch(function () {});
    });
    // And catch long-lived sessions that never navigate.
    setInterval(
      function () {
        if (navigator.onLine !== false) registration.update().catch(function () {});
      },
      60 * 60 * 1000,
    );
  }

  function _offerUpdate(worker) {
    if (_waiting === worker) return;
    _waiting = worker;
    _renderPrompt();
  }

  function _renderPrompt() {
    var T = App.i18n ? App.i18n.t : null;
    var existing = document.getElementById("pwa-update");
    if (existing) return;

    var bar = document.createElement("div");
    bar.id = "pwa-update";
    bar.className = "pwa-update";
    bar.setAttribute("role", "status");

    var text = document.createElement("span");
    text.textContent = T ? T("pwa.updateReady") : "A new version is available.";

    var button = document.createElement("button");
    button.type = "button";
    button.className = "pwa-update-btn";
    button.textContent = T ? T("pwa.updateAction") : "Reload";
    button.addEventListener("click", applyUpdate);

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "pwa-update-dismiss";
    dismiss.setAttribute("aria-label", T ? T("pwa.updateDismiss") : "Later");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", function () {
      bar.remove();
    });

    bar.appendChild(text);
    bar.appendChild(button);
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
  }

  /** Activate the waiting worker and reload once it takes control. */
  function applyUpdate() {
    if (!_waiting) return;
    _reloading = true;
    _waiting.postMessage({ type: "SKIP_WAITING" });
  }

  // THE VERSION BANNER

  /**
   * Ask the worker controlling this page which build its assets came from.
   *
   * Only when there *is* a controller. On a first visit the worker is
   * installing rather than controlling, nothing is being served from a cache
   * yet, and the HTML and the code it loaded are the same build - so the
   * rendered banner is already right and there is nothing to correct.
   */
  function _checkRunningVersion() {
    var controller = navigator.serviceWorker.controller;
    if (!controller) return;

    navigator.serviceWorker.addEventListener("message", function (event) {
      var data = event.data || {};
      if (data.type === "VERSION") _reconcile(data.client);
    });

    try {
      controller.postMessage({ type: "GET_VERSION" });
    } catch (error) {
      // A worker that will not answer leaves the banner as rendered, which is
      // the same place this started.
    }
  }

  /**
   * Correct the banner to the build actually running, when they differ.
   *
   * Both numbers are shown - "1.4.0 -> 1.5.0" - because the running one alone
   * would read as "this deploy did not happen". What it means is that the new
   * one is downloaded and waiting for the reload the prompt is offering, and
   * the arrow is the shortest way to say so on a line that has room for about
   * a dozen characters.
   *
   * The title spells the arrow out for anyone not reading it off the screen.
   * It is an accessible name rather than a tooltip: the banner gives its
   * pointer events back to the map underneath, so there is nothing to hover.
   *
   * @param {string} running the client version the controlling worker carries
   */
  function _reconcile(running) {
    if (_versionSettled || !running) return;

    var value = document.getElementById("version-client");
    if (!value) return;

    var served = (value.textContent || "").trim();
    _versionSettled = true;
    if (!served || running === served) return;

    value.textContent = running + " \u2192 " + served;
    value.classList.add("is-stale");

    var T = App.i18n ? App.i18n.t : null;
    value.title = T
      ? T("version.clientStale", { running: running, available: served })
      : "Running " + running + "; " + served + " loads after a reload.";
  }

  // connectivity

  function _bindConnectivity() {
    window.addEventListener("online", function () {
      _apply(true);
    });
    window.addEventListener("offline", function () {
      _apply(false);
    });
  }

  /**
   * A single class on <body> rather than a sweep over the DOM.
   *
   * Most controls live inside <template> elements and are cloned when a dialog
   * opens, so anything found by querySelectorAll at toggle time would miss
   * every dialog opened later. The class is inherited by whatever is mounted
   * next, so mark a control with `data-online-only` and the stylesheet handles
   * the rest - now and after any future clone.
   *
   * Printing deliberately does not wear it: a card is composed in the browser
   * and drawn on cached tiles, so it works with the connection down. What does
   * wear it needs Overpass or Nominatim, which nothing local can stand in for.
   */
  function _apply(online) {
    document.body.classList.toggle("is-offline", !online);
    _renderBadge(online);
  }

  function _renderBadge(online) {
    var badge = document.getElementById("pwa-offline");
    if (online) {
      if (badge) badge.remove();
      return;
    }
    if (badge) return;

    badge = document.createElement("div");
    badge.id = "pwa-offline";
    badge.className = "pwa-offline";
    badge.setAttribute("role", "status");
    badge.textContent = App.i18n ? App.i18n.t("pwa.offline") : "Offline";
    document.body.appendChild(badge);
  }

  return { init: init };
})();

window.App = App;
