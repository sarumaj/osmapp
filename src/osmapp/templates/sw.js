/**
 * sw.js — rendered by `internal/pwa.py`, served from the root scope.
 *
 * VERSION below is a digest of every precached file's contents. Editing any
 * asset changes this file's bytes, which is what makes the browser's own
 * byte-comparison of sw.js act as the update trigger. There is no build step
 * and nothing to bump by hand.
 *
 * Strategy per request, and why:
 *
 *   navigation      network-first    The HTML inlines the i18n dictionary and
 *                                    names the assets, so a stale copy is a
 *                                    wrong copy. Cache is the offline fallback
 *                                    only, stored per path so /, /pl and /de
 *                                    each keep their own.
 *   /static/**      cache-first      Fingerprint-free URLs, so freshness comes
 *                                    from VERSION rather than revalidation.
 *                                    A new version precaches everything again
 *                                    and drops the old cache wholesale.
 *   /tiles/**       cache-first      Immutable in practice, already served
 *                                    with a week of max-age. Capped and
 *                                    trimmed so a long session cannot fill
 *                                    the origin's storage quota. The aid
 *                                    basemaps get a separate, smaller cache:
 *                                    they are a look-and-switch-back tool, and
 *                                    a spell of panning around satellite
 *                                    imagery must not evict the OSM tiles
 *                                    behind the territory about to be printed.
 *                                    This mirrors the eviction priority in
 *                                    internal/tiles.py.
 *   everything else network-only     Overpass, Nominatim and PDF composition
 *                                    all need a live server. Caching them
 *                                    would only mean answering with lies.
 */

"use strict";

const VERSION = "{{ version }}";
const SHELL_CACHE = `shell-${VERSION}`;
const PAGE_CACHE = `pages-${VERSION}`;
// Tiles survive a deploy: they have nothing to do with the app's own assets,
// and re-downloading them would be both slow and rude to the tile server.
const TILE_CACHE = "tiles-v1";
const AID_TILE_CACHE = "tiles-aid-v1";

const PRECACHE = [
{%- for url in precache %}
  "{{ url }}",
{%- endfor %}
];

const NAVIGATIONS = [
{%- for url in navigations %}
  "{{ url }}",
{%- endfor %}
];

const OFFLINE_URL = "{{ offline_url }}";

/** Roughly 2000 tiles at ~25 KB — a few sessions' worth of panning. */
const TILE_LIMIT = 2000;
const TILE_TRIM_TO = 1600;

/**
 * Aerial imagery runs two to three times the size of an OSM tile and is worth
 * far less offline: nothing is printed from it, and a card can be produced
 * without it. A smaller cache of its own is the whole point — one shared
 * budget would let a look around the neighbourhood on satellite quietly evict
 * the basemap someone needs.
 */
const AID_TILE_LIMIT = 500;
const AID_TILE_TRIM_TO = 400;

// ── install ──────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // `reload` bypasses the HTTP cache, so installing a new version cannot
      // pick up a stale copy of an asset the browser happens to be holding.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));

      // Warm the offline entry points. Best effort: a cold install with no
      // network should still succeed and precache what it can.
      const pages = await caches.open(PAGE_CACHE);
      await Promise.all(
        NAVIGATIONS.map((url) =>
          fetch(new Request(url, { cache: "reload" }))
            .then((response) => (response.ok ? pages.put(url, response) : null))
            .catch(() => null),
        ),
      );
    })(),
  );
  // Deliberately no skipWaiting() here. The page decides when to activate, so
  // an update cannot swap the app out from under someone mid-edit.
});

// ── activate ─────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, PAGE_CACHE, TILE_CACHE, AID_TILE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));

      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

// ── messages ─────────────────────────────────────────────────────────────────

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_VERSION") {
    event.source && event.source.postMessage({ type: "VERSION", version: VERSION });
  } else if (data.type === "CLEAR_TILES") {
    // Both: "clear cached tiles" means all of them, not the ones that happen
    // to be printable.
    event.waitUntil(Promise.all([caches.delete(TILE_CACHE), caches.delete(AID_TILE_CACHE)]));
  }
});

// ── fetch ────────────────────────────────────────────────────────────────────

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Never touch anything that changes server state, and never touch another
  // origin — the tile proxy exists precisely so tiles are same-origin.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (url.pathname.startsWith("/tiles/aid/")) {
    event.respondWith(handleTile(request, AID_TILE_CACHE, AID_TILE_LIMIT, AID_TILE_TRIM_TO));
    return;
  }
  if (url.pathname.startsWith("/tiles/")) {
    event.respondWith(handleTile(request, TILE_CACHE, TILE_LIMIT, TILE_TRIM_TO));
    return;
  }
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(handleAsset(request));
    return;
  }
  // /service/health, /geocode and friends fall through to the network.
});

/**
 * Network-first with a per-path cached fallback.
 *
 * The three localized pages differ only in the inlined dictionary, so they are
 * cached under their own paths rather than sharing one entry.
 */
async function handleNavigation(event) {
  const request = event.request;
  const key = new URL(request.url).pathname;
  const cache = await caches.open(PAGE_CACHE);

  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(request));
    if (response && response.ok) {
      cache.put(key, response.clone());
    }
    return response;
  } catch (error) {
    const cached = (await cache.match(key)) || (await cache.match(OFFLINE_URL));
    if (cached) return cached;
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Offline</title>" +
        "<p>This page has not been opened before, so there is no offline copy of it.",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/**
 * Cache-first against the versioned shell cache.
 *
 * A miss means the asset was added after this worker installed, so it is
 * fetched and stored — the next VERSION will precache it properly.
 */
async function handleAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

/** Cache-first, with a bounded cache trimmed oldest-first. */
async function handleTile(request, cacheName, limit, trimTo) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      trimTiles(cache, cacheName, limit, trimTo);
    }
    return response;
  } catch (error) {
    // A transparent 1x1 GIF: a missing tile should leave a gap in the map, not
    // a broken-image icon across every unvisited square.
    return new Response(
      Uint8Array.from( // cSpell: disable-next-line
        atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
        (c) => c.charCodeAt(0),
      ),
      { status: 200, headers: { "Content-Type": "image/gif" } },
    );
  }
}

/** Per cache, not global: a trim in progress on one must not skip the other. */
const trimming = new Set();

/**
 * Cache Storage preserves insertion order, so the front of `keys()` is the
 * oldest entry. Trimming in one batch well below the limit keeps this from
 * running on every single tile once the cache is full.
 */
async function trimTiles(cache, cacheName, limit, trimTo) {
  if (trimming.has(cacheName)) return;
  trimming.add(cacheName);
  try {
    const keys = await cache.keys();
    if (keys.length <= limit) return;
    const excess = keys.slice(0, keys.length - trimTo);
    await Promise.all(excess.map((key) => cache.delete(key)));
  } finally {
    trimming.delete(cacheName);
  }
}
