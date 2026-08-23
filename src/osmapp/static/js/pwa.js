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
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.pwa = (function () {
  "use strict";

  var _waiting = null;
  var _reloading = false;

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
