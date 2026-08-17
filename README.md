# OSM Territory Mapper

[Deutsch](#deutsch) · [Polski](#polski) · [Français](#français)

|                                       |
|:-------------------------------------:|
| ![Screenshot 1](img/screenshot_1.png) |
|          Territory clusters           |

|                                       |
|:-------------------------------------:|
| ![Screenshot 2](img/screenshot_2.png) |
|        Printing territory card        |

|                                       |
|:-------------------------------------:|
| ![Screenshot 3](img/screenshot_3.png) |
|          Using card template          |

|                                       |
|:-------------------------------------:|
| ![Screenshot 4](img/screenshot_4.png) |
|  Using search to draw territory area  |

**Split a map area into walkable territories, then print each one as a PDF card.**

Draw a shape on a map — a neighborhood, village, or a few blocks. The app
downloads real streets and buildings from OpenStreetMap, then splits the area
into however many territories you need. Every boundary runs
**along a real street**, so "everything on this side of Railway Avenue" is an
instruction someone can actually follow. Then print each territory as a PDF
card, optionally overlaid on your own pre-printed template.

## Who it's for

Anyone who divides a geographic area into assignments handed to people on foot:
canvassing, leaflet distribution, survey work, delivery rounds, parish visiting,
and congregation field service. The primary target group is congregations of
Jehovah's Witnesses carrying out their missionary work
([more about it](https://www.jw.org/finder?wtlocale=E&docid=502013361&srcid=share)).

## Quick start

1. **Draw the area** — use the polygon tool, click around the edges,
   double-click to close.
2. **Wait for data** — streets and buildings load from OpenStreetMap (a few
   seconds for a town, longer for a city).
3. **Split it** — choose a number of territories ("40") or a target size ("~25
   buildings each").
4. **Adjust by hand** — merge, cut, drag boundaries, or delete. `Ctrl+Z` undoes.
5. **Print** — right-click a territory → Print. Set line color/thickness,
   rotate/zoom, erase border segments, export PDF.

Your work is saved in the browser — a refresh or accidental tab close won't lose
it. Export to a file to load later on another machine.

## What it is not

- Does **not** track who lives where, visits, or anything about residents.
- Does **not** invent street data — everything comes from OpenStreetMap. If a
  new estate is missing there, it's missing here. Fix it on OSM, not here.

## Languages

Available in English, Polish, German, and French. Pick from the menu or go
directly to `/pl`, `/de`, or `/fr`.

## Setup

```bash
pip install .
osmapp
```

The Dockerfile does the same in three stages: Node vendors client libraries,
Python builds the wheel, and the runtime image carries neither toolchain.

### Vendored client libraries

`static/vendor/` is committed — nothing fetches a CDN at runtime. It's produced
by `scripts/copy-vendor.js`:

```bash
npm install
npm run vendor
```

Run this after any `package.json` dependency bump and **commit the result** —
the deploy workflow builds from a plain checkout with no Node step. On Renovate
PRs the CI workflow does it and folds the result into Renovate's own commit, so
this is only needed for a bump made by hand. The script wipes `static/vendor/`
before it writes, so a package dropped from `vendorConfig` leaves nothing
behind. Paths under `static/vendor/` deliberately omit the version segment the
CDN URLs carry, which is why a bump does not touch the `<script>` tags or
`window.VENDOR` in `templates/index.html`.

Each `src` in `vendorConfig` is one exact path with no fallback, and the run
ends by reading every `vendor/...` URL out of `templates/` and requiring it to
exist. A package that moves its build output therefore fails the vendor step
instead of quietly producing a tree the page cannot load. That check is why the
Dockerfile's vendor stage copies `src/osmapp/templates/` as well as
`scripts/` — without them the script dies on a missing directory after it has
already written the tree.

pdf-lib, `@pdf-lib/fontkit`, and pdfjs-dist (~2 MB combined) are precached and
load on first use, not at boot — so a page view that never opens the print
dialog never parses them.

### Configuration

All optional, all environment variables:

| Variable                  | Default                                         | Why you'd change it                                                                       |
|---------------------------|-------------------------------------------------|-------------------------------------------------------------------------------------------|
| `OSM_MAX_AREA_KM2`        | `50`                                            | Polygons above this are refused — large areas can pull hundreds of MB and hit the timeout |
| `OVERPASS_URL`            | `https://overpass-api.de/api`                   | Point at a mirror or your own instance                                                    |
| `OVERPASS_TIMEOUT`        | `180`                                           | Seconds. Raise only with `OSM_MAX_AREA_KM2`                                               |
| `NOMINATIM_URL`           | `.../nominatim.openstreetmap.org/search`        | Self-hosted instances only need to set this one (`/lookup` and `/reverse` are derived)    |
| `GEOCODE_MIN_INTERVAL`    | `1.0`                                           | Seconds between Nominatim calls. Lower only against your own instance                     |
| `BOUNDARY_THRESHOLD`      | `0.0001`                                        | Douglas-Peucker simplification in degrees (~11 m). Client can request up to `0.01`        |
| `TILE_URL`                | `https://tile.openstreetmap.de/{z}/{x}/{y}.png` | See [Tile usage](#tile-usage)                                                             |
| `TILE_CACHE_DIR`          | `.tile_cache`                                   | Docker image points to `/var/cache/osmapp/tiles`                                          |
| `TILE_CACHE_MAX_MB`       | `500`                                           | Disk budget before pruning starts (aid tiles first, oldest OSM tiles after)               |
| `TILE_CACHE_MAX_AGE_DAYS` | `60`                                            | Tiles older than this are evicted regardless of budget                                    |
| `IMAGERY_TILE_URL`        | Esri World Imagery                              | Satellite aid layer. Empty string removes it                                              |
| `TERRAIN_TILE_URL`        | `https://tile.opentopomap.org/{z}/{x}/{y}.png`  | Terrain aid layer. Empty string removes it                                                |
| `HOST` / `PORT`           | `0.0.0.0` / `5000`                              | Bind address                                                                              |
| `FLASK_DEBUG`             | `0`                                             | `1` enables the Werkzeug debugger — never on anything reachable                           |

Each aid layer also takes `<NAME>_MAX_ZOOM` and `<NAME>_ATTRIBUTION` (e.g.
`TERRAIN_MAX_ZOOM=17`).

### Basemaps

There is one **printable** basemap: OpenStreetMap. A territory card is carried
down a street and must show road names and house numbers — aerial imagery
doesn't, and topo maps show the wrong features. Cards are always composed from
OSM tiles regardless of what's on screen. This is not a setting.

**Aid layers** (satellite, terrain) exist for the other half of the work:
spotting entrances, reading slopes, identifying private drives. They appear in
the layer switcher and are explicitly marked as non-printable. Aid tiles share
the disk cache but are evicted first — an afternoon of panning satellite imagery
must not evict the basemap behind territory cards.

### Tile usage

Printing renders the basemap onto a canvas, so tiles go through `/tiles/...`
(same-origin for canvas, custom User-Agent, disk-cached). One card ≈ 350 tiles
per session — fine for occasional personal use.
**If you print in volume, set `TILE_URL` to your own or a commercial tile source.**
Attribution is burned into every rendered image.

### Tests

```bash
pip install -e ".[test]"
pytest
node --test "tests/js/*.test.mjs"     # no npm install
```

Tests cover only things that fail **silently and consequentially** — loud
failures (404, startup error, blank page) aren't worth the maintenance. The JS
suite uses Node's built-in runner with no dependencies. `.github/workflows/ci.yml`
runs both suites on every push/PR; the Heroku deploy job requires both to pass.
Both emit JUnit XML in CI — `--junitxml` for pytest, Node's built-in `junit`
reporter alongside `spec` so the log stays readable — and a check run turns
that into a summary and inline annotations on the failing test. Publishing is
best-effort: a fork PR has a read-only token and gets the log instead.

### Releasing

Push a `v*` tag. The vendor job writes the tag's version — `v1.4.2` becomes
`1.4.2` — into `pyproject.toml` and `package.json`, regenerates
`static/vendor/`, commits, and moves the tag onto that commit; the deploy job
then builds from it. Both jobs run on every tag with no further input, and the
version lives in the tag rather than on the branch, so `main` keeps its
placeholder. Moving the tag is a force-push made with `GITHUB_TOKEN`, which
GitHub deliberately does not let start another run.

---

## Installing as an app

The app is a PWA — installable from the browser, usable offline for everything
that doesn't need the server.

### What works offline

| Feature                                       | Offline? |
|-----------------------------------------------|:--------:|
| Open app, restore last session                |   yes    |
| Pan/zoom over previously viewed tiles         |   yes    |
| Draw, cut, merge, split, undo/redo            |   yes    |
| Export GeoJSON                                |   yes    |
| Load template, print card, export PDF         |   yes    |
| Import a printed card back into a session     |   yes    |
| Fetch streets/buildings (Overpass)            |    no    |
| Search a place / suggest boundary (Nominatim) |    no    |

**The one caveat is tiles.** PDF composition needs no network, but the basemap
under it does. Offline you get whatever's in the service worker's tile cache —
ground you've already looked at. Pan over an area once while connected, and the
cards are yours to print in the field.

### How freshness is handled

No file under `static/js/` carries a fingerprint. Instead, the cache version is
a SHA-256 over all precached files, computed in `internal/pwa.py` and interpolated
into `sw.js`. Change any asset → the worker's bytes change → browsers detect it
on next navigation. No manual cache-busting needed.

| Request                               | Strategy                 | Why                                                          |
|---------------------------------------|--------------------------|--------------------------------------------------------------|
| Navigation (`/`, `/pl`, `/de`, `/fr`) | Network-first            | HTML inlines the dictionary; a stale copy is a wrong copy    |
| `/static/**`                          | Cache-first              | Freshness comes from the version digest                      |
| `/tiles/**`                           | Cache-first, capped 2000 | Immutable, already served with `max-age`                     |
| `/tiles/aid/**`                       | Cache-first, capped 500  | Separate, smaller budget — never evict the printable basemap |
| Everything else                       | Network-only             | Overpass/Nominatim need a live server                        |

**Updates are never silent.** A new worker installs and waits; the page offers
a reload. The undo stack lives in memory and isn't part of the IndexedDB session,
so activating mid-edit would discard it.

### Deliberately not done: bulk tile pre-fetch

A "download this territory for offline use" button is the obvious next feature,
but the OSM tile policy forbids bulk downloading. Tiles you actually look at are
cached as a side effect; systematically walking a bounding box at every zoom is
not. If you point `TILE_URL` at your own or a commercial source, this becomes
reasonable — the cache infrastructure is already there.

---

## Project layout

```text
src/osmapp/internal/*.py    Flask: Overpass proxy, geocoding, tiles, PWA manifest
templates/index.html        Page shell + UI markup as <template> elements
templates/sw.js             Service worker, rendered by internal/pwa.py
static/css/style.css        All styling; design tokens at top
static/lang/{en,pl,de,fr}.json
static/js/                  One IIFE module per file, namespaced under window.App
static/fonts/               DejaVuSans, embedded into cards by pdfdoc.js
static/icons/               PWA icons (SVG + generated PNGs)
static/vendor/              Leaflet, Turf, pdf-lib, pdf.js — no CDN at runtime
scripts/copy-vendor.js      Populates static/vendor/ from node_modules
scripts/comment_gate.py     Proves an edit touched only comments
tests/                      pytest (server), node --test (client)
```

### Modules

No bundler, no imports — just `<script>` tags and a shared `window.App`. Load
order is fixed in `index.html` and asserted by a test (a file in `static/js/`
not in the list is precached, shipped, and never runs).

| Module          | Responsibility                                                 |
|-----------------|----------------------------------------------------------------|
| `util`          | localStorage that survives private mode, OSM tag normalization |
| `i18n`          | Dictionary loading, `t()`, DOM subtree translation             |
| `state`         | The single mutable store — everything reads `App.state`        |
| `store`         | IndexedDB key/value — session and uploaded template            |
| `dom`           | Clones `<template>` elements, looks up nodes by `data-role`    |
| `shortcuts`     | One keydown dispatcher; `?`/F1 sheet built from its registry   |
| `vertices`      | Polygon corner handles, hold-to-erase gesture                  |
| `basemap`       | Printable OSM layer, optional aid layers, the print rule       |
| `geometry`      | Turf wrappers, polygon normalization, planar segment noding    |
| `spatial`       | Uniform grid index, fast planar distance, binary min-heap      |
| `coverage`      | Boolean raster over a lng/lat box and its rings                |
| `network`       | The street graph, shared by everything that follows one        |
| `ui`            | Loading overlay, info panel, context menu, dialogs             |
| `polygons`      | Territory lifecycle, hover info, filtered street/building view |
| `labels`        | Numbered chips on parts sharing a territory number             |
| `naming`        | Territory names read off the OSM data already on the map       |
| `pdfdoc`        | Reads/writes PDFs: template measuring, preview, composition    |
| `data`          | Overpass fetching, rendering, GeoJSON export/import            |
| `session`       | Debounced save and restore of working state                    |
| `clustering`    | K-Means → Voronoi → street-routed boundaries                   |
| `editing`       | Cut lines, merging, cleanup                                    |
| `trim`          | Shrink outer boundary onto buildings that matter               |
| `outline`       | Reshape outer boundary after it's been set                     |
| `gaps`          | Parts of the area belonging to no territory                    |
| `print-filters` | Basemap filters for the print preview                          |
| `print`         | Canvas map rendering, framing, eraser, card layout             |
| `boundary`      | Turn a geocoder hit into the outer polygon                     |
| `history`       | Undo/redo                                                      |
| `controls`      | Toolbar, language picker, reset                                |
| `demo`          | Sample territory for the guided tour                           |
| `tour`          | First-run walkthrough                                          |
| `pwa`           | Worker registration, update prompt, online badge               |
| `main`          | Boot sequence and map wiring                                   |

---

## How the pieces work

### Splitting into territories

Six phases, each yielding to the event loop so the UI stays responsive:

1. **Sample points** — building centroids, falling back to street midpoints,
  then boundary samples for sparse areas.
2. **K-Means** → _k_ centroids.
3. **Voronoi** → cells, clipped to the outer boundary.
4. **Street graph** — undirected weighted graph with a grid index.
5. **Edge routing** — each unique cell edge routed along streets with A\*,
  biased toward the edge's bearing. Routed **once** (keyed on sorted endpoints)
  to avoid duplicate divergent paths that break the planar graph.
6. **Polygonize** → assign pieces to centroids → fill gaps → render.

### Merging

`geometry.unionHealed()` grows each input by 0.5 m before unioning, then shrinks
back. A plain `turf.union` on nearly-coincident boundaries returns a MultiPolygon
of touching pieces with visible internal outlines; the grow/shrink closes sub-meter
gaps so the union genuinely dissolves.

### Printing

The card is **rendered from scratch onto a canvas** — not screenshotted from Leaflet.
This guarantees only the target territory's rings are drawn (no stray borders) and
renders at 300 dpi regardless of window size.

Three surfaces compose the result:

- **tiles** — basemap + attribution, never erasable
- **border** — line on transparency; erased spans use `destination-out` to remove
  the line while leaving the map
- **preview** — tiles + border at chosen opacity

The canvas is fixed to the template placeholder's aspect ratio, so cropping is
choosing which slice of the world lands on it. Drag to pan, scroll/slide to zoom,
buttons for quarter turns.

Key details: tiles are fetched **once** (one zoom level, cached as decoded `Image`
objects for the dialog's lifetime — softness above that level is the tradeoff).
Erase strokes are stored in **lng/lat with width in meters**, not pixels, so panning
after erasing doesn't shift erasures off what they were hiding.

### Composition

`pdfdoc.js` handles everything that touches a PDF, over pdf-lib (writes) and pdf.js
(reads), both loaded on first use:

1. **Measuring the template** — finds the placeholder rectangle and field positions
   by walking the content stream (including Form XObjects). Result is cached per
   template via SHA-256; the placement dialog allows manual correction.
2. **Rasterizing a page** at 110 dpi on white — PDF pages have no background, and
   a card on transparency is a black rectangle in dark mode.
3. **Stamping the map** and drawing locality/territory fields in DejaVuSans (subsetted
to used glyphs — the standard 14 fonts lack `ł ą ę ś ż ź ć ń`).
4. **Embedding the project** — gzipped JSON under a fixed attachment name, so a
   printed sheet is a restore point. This is why `.pdf` is in the import dialog's
   accept list.

No server needed for any of this. The old `/compose_pdf` endpoints are gone — a
template file never leaves the machine it was opened on.

---

## Translations

Markup is annotated declaratively:

```html
<span data-i18n="menu.print">Print</span>
<a data-i18n-attrs="title=toolbar.draw;aria-label=toolbar.draw"></a>
```

`App.dom.render()` translates every cloned template at mount time. Strings built
in JS go through `T("key", { count: 3 })`; `{placeholders}` interpolate and
numbers are localized via `Intl.NumberFormat`. Language comes from the URL;
Flask inlines the matching dictionary plus an English fallback, so there's no
fetch waterfall and no untranslated first paint. Console output stays English
(developer output — translating makes issue reports harder to read).

**Adding a language**: copy `static/lang/en.json`, translate it, add
`{ code, label }` to `LANGUAGES` in `static/js/i18n.js` and to `SUPPORTED_LANGS`
in `internal/i18n.py`. The picker, `/<lang>` routes, and dictionary-parity test
pick it up automatically.

---

## HTTP API

| Route                                     | Purpose                                                     |
|-------------------------------------------|-------------------------------------------------------------|
| `GET /`, `/pl`, `/de`, `/fr`              | The app (`/en` redirects to `/`)                            |
| `POST /fetch_streets`                     | GeoJSON polygon in → drivable street network out            |
| `POST /fetch_buildings`                   | GeoJSON polygon in → building footprints with addresses out |
| `GET /geocode?q=`                         | Nominatim proxy, cached and rate-limited to 1 req/s         |
| `GET /geocode_boundary?osm_type=&osm_id=` | One relation/way resolved to a simplified polygon           |
| `GET /reverse_geocode?lat=&lon=`          | Locality candidates for a point (naming fields)             |
| `GET /tiles/<z>/<x>/<y>.png`              | Tile proxy with disk cache — printable basemap              |
| `GET /tiles/aid/<layer>/<z>/<x>/<y>.png`  | Same proxy, on-screen aid layers. Never printed             |
| `GET /sw.js`, `/manifest.webmanifest`     | Service worker and manifest, per language                   |
| `GET /service/health`                     | Returns `OK` — deploy health check                          |

Both fetch endpoints require the polygon on **every** request. There is deliberately
no server-side geometry cache — a module-level one meant two browser tabs (or any
multi-worker deployment) handed users each other's areas.

---

## Keyboard shortcuts

| Key                                     | Action                                                      |
|-----------------------------------------|-------------------------------------------------------------|
| `?` or `F1`                             | Shortcut sheet (reachable inside dialogs)                   |
| `Ctrl/Cmd + Z`                          | Undo (territory geometry, or print eraser in that dialog)   |
| `Ctrl/Cmd + Y` / `Ctrl/Cmd + Shift + Z` | Redo                                                        |
| `Enter`                                 | Commit current modal tool (cut, merge, trim, outline, draw) |
| `Esc`                                   | Cancel drawing, modal tool, or close a dialog               |
| `Alt` (held while cutting)              | Place a free vertex instead of snapping                     |
| Right-click                             | Context menu — on a territory, empty ground, or boundary    |

All bindings live in one registry in `shortcuts.js`, which is both the
dispatcher and the source the `?` sheet renders from.

---

## Known limits

- **Session is not a backup.** It lives in IndexedDB for that origin — survives
  a refresh/crash/reboot, but clearing site data takes it and another machine
  has never seen it. Export GeoJSON or print a card with the project embedded.
- **Urban-tuned partitioner.** Rural areas fall back to street/boundary sampling
  and give coarser results.
- **Single-page rectangular placeholders.** Multi-page or rotated placeholders
  need changes to `PLACEHOLDER` in `print.js` and `compose` in `pdfdoc.js`.
- **Offline printing uses cached tiles only.** Unseen ground comes out blank
  (visible in the preview before export).
- **Server errors are English** regardless of interface language. If that matters,
  return error _codes_ and map them to `alert.*` keys client-side.

---

## Attribution

Map data © OpenStreetMap contributors, available under the
[Open Database License](https://www.openstreetmap.org/copyright). Attribution is
rendered into every printed map. Geocoding uses Nominatim; routing data and
building footprints come from Overpass. Please read those services' usage
policies before deploying anywhere shared.

---

## Deutsch

Teilt einen Kartenbereich in begehbare Gebiete auf und druckt jedes einzelne als
Karte aus.

### So funktioniert es

Ihr zeichnet eine Form auf einer Karte ein – ein Stadtviertel, ein Dorf, ein paar
Häuserblocks. Die App lädt die tatsächlichen Straßen und Gebäude aus OpenStreetMap
und teilt die Form in so viele Teile auf, wie ihr wünscht. Jede Grenze verläuft
_entlang_ einer Straße, sodass „alles auf dieser Seite der Bahnstraße" eine
Anweisung ist, nach der man handeln kann. Dann druckst du: Jedes Gebiet wird zu
einer PDF-Karte, die nur dieses Gebiet zeigt, mit der Grenze darüber. Du kannst
sie auf ein vorgedrucktes Formular ziehen, sodass die Karte in das dafür
vorgesehene Feld passt.

### Für wen ist es gedacht

Jeder, der ein geografisches Gebiet in Aufgabenbereiche unterteilt und an Personen
vor Ort verteilt: Gemeindedienst, Wahlwerbung, Flugblattverteilung, Umfragen,
Gemeindebesuche, Auslieferungsrunden. Die Hauptzielgruppe sind Gemeinden der
Zeugen Jehovas ([mehr dazu](https://www.jw.org/finder?wtlocale=X&docid=502013361&srcid=share)).

### Was du konkret tust

1. **Gebiet einzeichnen** — Polygon-Werkzeug, entlang der Ränder klicken,
   Doppelklick zum Schließen.
2. **Daten warten** — Straßen und Gebäude werden aus OSM geladen.
3. **Aufteilen** — Anzahl Gebiete („40") oder Zielgröße („~25 Gebäude") wählen.
4. **Anpassen** — Gebiete zusammenfügen, aufteilen, Grenzen verschieben, löschen.
   `Strg+Z` macht rückgängig.
5. **Drucken** — Rechtsklick auf ein Gebiet → „Drucken". Linienfarbe/-stärke
   festlegen, Karte drehen/zoomen, Umrandungsteile löschen, PDF exportieren.

Deine Arbeit wird im Browser gespeichert. Exportiere alles in eine Datei, um sie
später auf einem anderen Rechner zu laden.

### Was es nicht ist

Es weiß nicht, wer wo wohnt, verfolgt keine Besuche und speichert keine Einwohnerdaten.
Es zeichnet Grenzen und druckt Karten. Auch Straßendaten werden nicht erfunden —
alles stammt aus OpenStreetMap; was dort fehlt, fehlt auch hier. Korrekturen werden
auf OSM vorgenommen, nicht hier.

### Sprache

Verfügbar auf Englisch, Polnisch, Deutsch und Französisch. Wähle aus dem Menü oder
gehe zu `/pl`, `/de` oder `/fr`.

---

## Polski

Podziel obszar mapy na terytoria piesze, a następnie wydrukuj każde jako kartę
PDF.

### Jak to działa

Rysujesz na mapie kształt — dzielnicę, wieś, kilka przecznic. Aplikacja pobiera
z OpenStreetMap rzeczywiste ulice i budynki, a następnie dzieli ten kształt na
tyle części, ile zlecisz. Każda granica przebiega _wzdłuż_ drogi, więc „wszystko
po tej stronie Kolejowej" to wskazówka, którą można wykorzystać w praktyce.
Następnie drukujesz: każdy obszar staje się kartą PDF pokazującą tylko ten
obszar, z narysowaną granicą. Możesz umieścić ją na wcześniej wydrukowanym
szablonie.

### Dla kogo to jest

Każdy, kto dzieli obszar geograficzny na zadania i przydziela je osobom pieszo:
służba terenowa, akcje informacyjne, rozdawanie ulotek, ankiety, wizyty
parafialne, trasy dostawcze. Główną grupą docelową są zbory Świadków Jehowy
([więcej](https://www.jw.org/finder?wtlocale=P&docid=502013361&srcid=share)).

### Co faktycznie robisz

1. **Narysuj obszar** — narzędzie wielokąta, klikaj wzdłuż krawędzi, dwukrotnie
   kliknij, aby zamknąć.
2. **Poczekaj na dane** — ulice i budynki z OSM.
3. **Podziel obszar** — liczba terytoriów („40") lub wielkość („~25 budynków").
4. **Dopasuj ręcznie** — połącz, podziel, przeciągnij granice, usuń. `Ctrl+Z`
   cofa.
5. **Wydrukuj** — prawy przycisk na obszar → „Drukuj". Ustaw linię,
   obróć/zoomuj, usuń fragmenty obramowania, eksportuj PDF.

Praca jest zapisywana w przeglądarce. Eksportuj do pliku, aby załadować później
na innym komputerze.

### Czym to nie jest

Narzędzie nie wie, kto gdzie mieszka, nie śledzi wizyt, nie przechowuje danych
mieszkańców. Wyznacza granice i drukuje mapy. Dane ulic pochodzą z OSM — czego
tam nie ma, nie ma też tutaj. Poprawki na OSM, nie tutaj.

### Język

Dostępne w języku angielskim, polskim, niemieckim i francuskim. Wybierz z menu
lub przejdź do `/pl`, `/de`, `/fr`.

---

## Français

Divisez une zone de la carte en territoires parcourables à pied, puis imprimez
chacun sous forme de carte PDF.

### Fonctionnement

Vous tracez une forme sur la carte — un quartier, un village, quelques pâtés de
maisons. L'application télécharge les rues et bâtiments réels depuis OpenStreetMap,
puis découpe la forme en autant de morceaux que vous le souhaitez. Chaque limite
longe _une_ route, de sorte que « tout ce qui se trouve de ce côté de l'avenue
Railway » est une instruction que vous pouvez suivre. Il ne vous reste plus qu'à
imprimer : chaque territoire devient une fiche PDF présentant uniquement ce
territoire, avec la limite tracée par-dessus. Vous pouvez les glisser sur un
formulaire pré-imprimé.

### À qui s'adresse cet outil

À toute personne qui divise une zone géographique en secteurs d'intervention
attribués à des personnes à pied : service de terrain, porte-à-porte, distribution
de tracts, enquêtes, visites paroissiales, tournées de livraison. Le public cible
principal est constitué des congrégations des Témoins de Jéhovah
([en savoir plus](https://www.jw.org/finder?wtlocale=F&docid=502013361&srcid=share)).

### Comment procéder

1. **Dessinez la zone** — outil polygone, cliquez autour du périmètre,
   double-cliquez pour fermer.
2. **Attendez les données** — rues et bâtiments depuis OSM.
3. **Divisez** — nombre de secteurs (« 40 ») ou taille cible (« ~25 bâtiments »).
4. **Ajustez manuellement** — fusionnez, réduisez, déplacez une limite, supprimez.
   `Ctrl+Z` annule.
5. **Imprimez** — clic droit sur un territoire → « Imprimer ». Définissez
   couleur/épaisseur du trait, pivotez/zoomez, effacez des parties de la limite,
   exportez le PDF.

Votre travail est conservé dans le navigateur. Exportez tout vers un fichier pour
le recharger plus tard sur un autre ordinateur.

### Ce que ce n'est pas

Cet outil ne sait pas qui habite où, ne suit pas les visites, ne stocke aucune
information sur les résidents. Il trace des limites et imprime des cartes. Les
données de rues proviennent d'OpenStreetMap — ce qui n'y figure pas n'apparaît
pas ici non plus. Les corrections se font sur OSM, pas ici.

### Langue

Disponible en anglais, polonais, allemand et français. Choisissez dans le menu
ou rendez-vous sur `/pl`, `/de`, `/fr`.
