# OSM Territory Mapper

[Deutsch](#deutsch) · [Polski](#polski) · [Français](#français)

|               Territory clusters               |                   Printing a territory card                   |
|:----------------------------------------------:|:-------------------------------------------------------------:|
|  ![Territory clusters](img/screenshot_1.png)   |      ![Printing a territory card](img/screenshot_2.png)       |
|           **Using a card template**            |           **Searching to draw the territory area**            |
| ![Using a card template](img/screenshot_3.png) | ![Searching to draw the territory area](img/screenshot_4.png) |

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
5. **Annotate, if you need to** — write notes, drop pins on places, mark
   streets freehand or snapped to the road network, and set captions straight
   onto the map.
6. **Print** — right-click a territory → Print. Set line color/thickness,
   rotate/zoom, erase border segments, export PDF.
7. **Put it all on one wall map** — import as many saved projects into one as
   you like (Import offers *Add* alongside *Replace*, and takes several files
   at once), then Wall map draws every territory of every one of them onto a
   single numbered sheet, up to A0.

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
`window.VENDOR` in `templates/index.html.j2`.

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

The same run writes `static/version.json` — `package.json`'s version, and
nothing else. It exists because `package.json` does not ship: a wheel carries
`src/osmapp/` and nothing above it, and the runtime image is built from that
wheel with no Node in it, so this is how the server can still name the build
the browser is running. See the version banner below.

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
playwright install chromium           # browser suite, optional
pytest
node --test "tests/js/*.test.mjs"     # no npm install
```

Tests cover only things that fail **silently and consequentially** — loud
failures (404, startup error, blank page) aren't worth the maintenance. The JS
suite uses Node's built-in runner with no dependencies.

`tests/e2e/` is the exception to the rule above, and deliberately: a blank page
*is* loud, but neither other suite can see one. The server suite never renders
the page and the JS suite runs each module under Node with stubbed globals, so
a dropped `<script>`, an uncopied vendor file or a module that throws on the
real DOM passes both. It starts the app on an ephemeral port, drives Chromium
against it, and answers tiles and the reverse lookup itself — Overpass,
Nominatim and the tile provider are never contacted. **It skips itself, with a
reason, when `pytest-playwright` or the browser is missing**, so a plain
`pytest` still runs everything else. `--browser firefox` and `--browser webkit`
work the same way if a bug looks engine-shaped.

`.github/workflows/ci.yml` runs all three suites on every push/PR, and the
Heroku deploy job requires all three to pass. Each emits JUnit XML that a check
run turns into a summary with inline annotations; a fork PR has a read-only
token and gets the log instead. A failed browser run uploads its Playwright
traces, which replay the DOM, console and network of the run that failed.

### Releasing

Push a `v*` tag. The vendor job writes the tag's version — `v1.4.2` becomes
`1.4.2` — into `pyproject.toml` and `package.json`, regenerates
`static/vendor/`, commits, and moves the tag onto that commit; the deploy job
then builds from it. Both jobs run on every tag with no further input, and the
version lives in the tag rather than on the branch, so `main` keeps its
placeholder. Moving the tag is a force-push made with `GITHUB_TOKEN`, which
GitHub deliberately does not let start another run.

Both numbers end up in the bottom-left corner of the page, as `Server 1.4.2 ·
Client 1.4.2` — `internal/version.py` reads the first from `pyproject.toml` (or
from the installed package's metadata) and the second from `package.json` (or
from `static/version.json`). They come from one tag, so they normally agree, and
seeing them disagree is the point of printing both: an image that was not built
from a release, or a service worker still handing out the assets from before
one. On a phone the banner sits a row above the attribution, and it steps aside
while a tool's bar is on the map.

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
| Write notes, drop pins, mark streets          |   yes    |
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

**Registration does not wait for an event already past.** It is held back to
`load` so it does not compete with the first Overpass fetch, but start-up runs
from a timer after `DOMContentLoaded` and reaches `pwa.js` last, by which time a
page whose assets are all in the HTTP cache — every visit after the first — has
finished loading. `pwa.js` checks `document.readyState` and registers straight
away in that case. Nothing on screen reports a worker that never registered:
the app is already in memory, and the first thing to go missing is a card
composed with the connection down, because DejaVuSans is fetched when a PDF is
built rather than when the page loads.

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
templates/index.html.j2     Page shell + UI markup as <template> elements
templates/sw.js.j2          Service worker, rendered by internal/pwa.py
static/css/style.css        All styling; design tokens at top
static/lang/{en,pl,de,fr}.json
static/js/                  One IIFE module per file, namespaced under window.App
static/fonts/               DejaVuSans, embedded into cards by pdfdoc.js
static/icons/               PWA icons (SVG + generated PNGs)
static/vendor/              Leaflet, Turf, pdf-lib, pdf.js — no CDN at runtime
static/version.json         Client version, written by copy-vendor.js
scripts/copy-vendor.js      Populates static/vendor/ from node_modules
tests/                      pytest (server), node --test (client)
tests/e2e/                  pytest + Playwright (the page in a browser)
```

### Modules

No bundler, no imports — just `<script>` tags and a shared `window.App`. Load
order is fixed in `index.html.j2` and asserted by a test (a file in `static/js/`
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
| `naming`        | Territory names, from the OSM data and from what cards said    |
| `pdfdoc`        | Reads/writes PDFs: template measuring, preview, composition    |
| `data`          | Overpass fetching, rendering, export/import, merging projects  |
| `session`       | Debounced save and restore of working state                    |
| `clustering`    | K-Means → Voronoi → street-routed boundaries                   |
| `editing`       | Cut lines, merging, cleanup                                    |
| `trim`          | Shrink outer boundary onto buildings that matter               |
| `outline`       | Reshape outer boundary after it's been set                     |
| `gaps`          | Parts of the area belonging to no territory                    |
| `footprints`    | Boundaries drawn through buildings, moved onto the wall        |
| `autoheal`      | Repairing the faults the territory list can name               |
| `notes`         | Annotations over the area: notes, pins, marks, captions        |
| `print-filters` | Basemap filters for the print preview                          |
| `print`         | Canvas map rendering, framing, eraser, card and wall-map sheet |
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
2. **K-Means** → *k* centroids.
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

### Areas: a project made of several boundaries

A project drawn in one sitting has one outer boundary. A project assembled by
importing others has one per import, disjoint and often kilometers apart, and
the boundary is then a **MultiPolygon**. Two questions come out of that, and the
code keeps them apart deliberately:

- **"Inside the boundary"** — coverage, gaps, clipping a hand-drawn territory,
  what a wall map frames, what a download covers. That is the whole boundary:
  `geometry.outerFeature()`.
- **"Which one area"** — reshaping an outline, trimming it onto its buildings,
  splitting it into territories. Each of those is a statement about one place,
  and walks a single ring besides. That is `polygons.workingOuter()`, which
  takes the area holding the selected territory, else the middle of the screen,
  else the largest. The choice needs no control of its own because every one of
  those tools puts its handles, its preview or its result on the area it chose.

`polygons.replaceOuterPart()` puts an edited area back by subtracting the shape
it replaced and unioning the new one, so the areas nobody touched come out
untouched. Downloads run one area at a time — the server takes a single polygon
and guards its size, and one request over the bounding box of three villages is
a request for the farmland between them.

Merging two projects appends territories minus the ground already covered
(territories not overlapping is the invariant the building counts, the gap
finder and the printed marks all read), de-duplicates streets and buildings by
OSM id, and appends notes. See the block comment in `data.js`.

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

A **wall map** is the same dialog and the same three surfaces, given every
territory instead of one. It differs in three places: the subject is a
`FeatureCollection` (which `polygonParts` flattens exactly as it flattens a
territory a cut left in two pieces, so framing and drawing need no special
case); there is no template, so the sheet is an ISO A size with a margin and a
heading band; and nothing is marked as printed afterwards, because a poster of
forty territories is not forty cards. The chips are drawn on the furniture
layer, beside the scale bar and the compass rather than onto the border, so
neither the border's opacity nor the eraser reaches them.

What a chip says is **what a card called that territory**, falling back to its
number. The number is this session's position in the list — an index, not a
name — while a congregation has its own ("S-13", "12a"), which it types into
the card's *Territory no.* field. That typing is now kept on the territory
(`properties.label`, alongside the printed mark and carried by the same
payload), so it survives into the wall map, into the next card's suggestion,
and into an export. Chips are pills rather than discs for it: a single digit
still comes out round.

Resolution is not fixed at 300 dpi. A0 at 300 dpi is 140 megapixels, which no
browser will allocate — and does not refuse, it hands back a blank canvas. So
`PX_PER_PT` is derived per sheet from a side and an area ceiling, and everything
measured in points multiplies by it rather than by `DPI`.

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

No server needed for any of this: a template file never leaves the machine it
was opened on.

### Notes

Annotations are a separate document from the territories: a note survives a
re-partition, may sit outside the boundary, and is switched on and off without
touching any geometry. Four kinds, one record — `{ kind, points, text, color,
width }` — where a mark has many points and everything else has one:

| Kind | What it is | On the map |
|------|------------|------------|
| note | a sentence pinned to a spot | sticky glyph, words always shown |
| pin | a place or a building | teardrop, tip on the spot, words on hover |
| mark | a stroke along the ground | line, freehand or street-snapped, with handles on its points |
| caption | words and nothing else | the words themselves, no glyph |

Marks come from one pen, and the gesture picks the kind: a drag is a freehand
sweep, a click places a vertex. With **Snap to streets** on, a clicked vertex is
pulled onto the network and the hop before it is routed along the road, under
the same detour limits the cut tool uses — so "this street, not the next one" is
a mark that lies on the street. **Freeform** is the other end of that: only the
hand draws, a click places nothing, and the magnet goes quiet under it because a
sweep has no vertices to pull. Every kind asks for its words when it is made:
a note without any is a note thought better of, while a pin and a mark are kept
either way. Notes ride along in the session, the GeoJSON export and the card
attachment.

**A line being drawn is stepped through, not only cancelled.** While one is open
`Ctrl+Z` and `Backspace` take back the last thing the hand did — a clicked
point, or a whole freehand sweep, since half a sweep is a start point with
nothing drawn from it — and `Ctrl+Y` puts it back. That holds past the first
point too: the line leaves the map but the steps that made it do not, so one
`Ctrl+Z` too many costs nothing. Undo answers for the note list again once the
line is stored or `Esc` gives it up.

**A mark keeps its skeleton, so it can be corrected.** Alongside the geometry
everything downstream draws, a mark stores the points somebody placed and what
the app did between each pair — `{ at, snapped, via, bend, sweep }` per node,
where `via` is a run the hop follows (a routed street path, or the samples of a
sweep), `bend` is the control point of a curve, and neither is a straight line.
The geometry is derived from that and never trusted from a file, so an edit and
a reload cannot disagree.

While the pencil is the selected pen, every mark wears the polygon editor's own
handles — the same shape for the same gesture:

| Handle | Gesture | What happens |
|--------|---------|--------------|
| point | drag | the point moves, and its two hops are worked out again — re-snapped and re-routed if the magnet is on |
| point | click | the point comes out, down to the two a line needs |
| middle of a straight hop | drag | the hop bends into a curve through the handle |
| middle of a bent hop | click | the bend comes out and the hop is straight again |

The ends of a swept hop wear none: that hop is a run of samples of where the
hand went, and moving one end of it would leave the rest behind. Nor does a mark
drawn before this existed — there is no skeleton in the file to edit, and the
mark is drawn from its geometry as it always was.

**Both cards show the same thing.** A PNG is a picture, so everything is drawn
into it. A PDF is a document, so the same marks are drawn *and* carried as real
annotations — one per note, so a glyph and the words beside it are one thing to
open, move or delete:

| Kind | On a PDF |
|------|----------|
| note, pin, mark | `/Ink` — the glyph or stroke, with the words in the same appearance |
| caption | `/FreeText` — the subtype a reader opens for typing |

Ink rather than the sticky-note `/Text` a pin more closely resembles, because a
popup note is not among the types a reader will let you select and delete, and a
pin nobody can rub out is worse than one filed under the wrong subtype.

Each annotation carries its own appearance stream and the print flag, so a card
looks the same in every viewer instead of however that viewer chooses to draw a
comment, and it carries what a comment list reads — `/T`, `/Contents`, `/M`,
`/CreationDate`, `/Subj` and a linked `/Popup`. `print.js` builds the glyph
outlines and the boxes of words and hands `pdfdoc.js` everything as fractions of
the map image, so one place in the app knows what a pin looks like and one knows
where the map sits on the page. The box is measured twice — Arial for the
preview, DejaVu for the card — and kept at whichever is wider, since a box sized
for the narrower face clips the last word off every label.

A caption is drawn in the pen's color, the way the map draws it, while a
mark's label stays black in its box, where black is what survives being printed
over a street map. Both are written so that a reader which rebuilds the
appearance itself lands in the same place: the color is in `/DA` — on a
`/FreeText` that is where the lettering's color lives, while `/C` is what gets
painted *behind* it — the intent is `/FreeTextTypeWriter`, which is words and
no box, and the face is named in the document's form resources, because that is
where `/DA` is resolved (PDF 32000-1, 12.7.3.3) and a caption re-typed without
it comes back in a substituted font with the Polish diacritics gone.

**"Draw the words on the card"** turns the boxes off for a crowded card: the
glyphs and strokes stay and the words go only into the PDF's comments. A caption
is nothing but words, so it is drawn either way. The switch is off-limits while
the notes themselves are off, since there would be nothing for it to draw.

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
| `Ctrl/Cmd + Z`                          | Undo (territory geometry, a mark being drawn, or the print eraser) |
| `Ctrl/Cmd + Y` / `Ctrl/Cmd + Shift + Z` | Redo                                                        |
| `Enter`                                 | Commit current modal tool (cut, merge, trim, outline, draw) |
| `Esc`                                   | Cancel drawing, modal tool, or close a dialog               |
| `Alt` (held while cutting)              | Place a free vertex instead of snapping                     |
| `A`                                     | Notes tool; `1`–`4` pick the pen; `S` snapping, `F` freeform |
| `W`                                     | Wall map — every territory on one sheet                     |
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
- **A project of several areas opens as one on an older build.** The boundary
  is a MultiPolygon in the same `outerPolygon` field a single area has always
  used, so nothing about the file format changed and every existing session
  and export still loads. A build from before this feature reads that field
  with `largestPolygon()` and keeps the biggest area without saying so. The
  version gate was left alone deliberately: raising it would refuse every
  session and every export already out there.
- **A wall map above A3 prints below 300 dpi.** The canvas it is composed on
  is capped at twenty megapixels, which is about 115 dpi across an A0 sheet.
  Raising `MAX_RENDER_PX` costs memory in threes — the preview, the border and
  the tile mosaic are all held at that size — and a browser that cannot
  allocate one returns a blank canvas rather than an error.
- **Offline printing uses cached tiles only.** Unseen ground comes out blank
  (visible in the preview before export).
- **Server errors are English** regardless of interface language. If that matters,
  return error *codes* and map them to `alert.*` keys client-side.
- **Note labels do not avoid each other.** Each box is placed beside its own
  mark and drawn where it lands, so two notes on the same corner overlap. The
  "Draw the words on the card" switch is the answer for a card where that
  matters.
- **A PDF card's notes live in its annotation layer**, which is what makes them
  openable and deletable — and what a reader set to hide or not print comments
  hides. They carry the print flag, so printing takes them by default; a reader
  told otherwise is being told otherwise. Flattening keeps them: `qpdf
  --flatten-annotations=all` draws every note into the page.

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
*entlang* einer Straße, sodass „alles auf dieser Seite der Bahnstraße" eine
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
5. **Anmerken** — Notizen schreiben, Nadeln auf Orte setzen, Straßen freihand
   oder am Straßennetz eingerastet markieren, Beschriftungen auf die Karte
   setzen.
6. **Drucken** — Rechtsklick auf ein Gebiet → „Drucken". Linienfarbe/-stärke
   festlegen, Karte drehen/zoomen, Umrandungsteile löschen, PDF exportieren.
   Auf einer PDF-Karte werden die Anmerkungen zu echten Kommentaren, auf einem
   PNG in die Karte gezeichnet.
7. **Alles auf eine Wandkarte** — beliebig viele gespeicherte Projekte in eines
   importieren (Import bietet „Hinzufügen" neben „Ersetzen" und nimmt mehrere
   Dateien auf einmal), dann zeichnet „Wandkarte" alle Gebiete nummeriert auf
   ein einziges Blatt, bis zu A0.

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
tyle części, ile zlecisz. Każda granica przebiega *wzdłuż* drogi, więc „wszystko
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
5. **Dodaj notatki** — pisz notatki, wstawiaj pinezki, zaznaczaj ulice
   odręcznie lub z przyciąganiem do sieci dróg, dodawaj podpisy na mapie.
6. **Wydrukuj** — prawy przycisk na obszar → „Drukuj". Ustaw linię,
   obróć/zoomuj, usuń fragmenty obramowania, eksportuj PDF. Na karcie PDF
   notatki stają się prawdziwymi komentarzami, na PNG są rysowane na mapie.
7. **Wszystko na jednej mapie ściennej** — zaimportuj do jednego projektu
   dowolnie wiele zapisanych („Import" proponuje „Dodaj" obok „Zastąp"
   i przyjmuje kilka plików naraz), a „Mapa ścienna" narysuje wszystkie tereny
   z numerami na jednym arkuszu, nawet A0.

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
longe *une* route, de sorte que « tout ce qui se trouve de ce côté de l'avenue
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
5. **Annotez** — écrivez des notes, posez des épingles, marquez des rues à main
   levée ou aimantées au réseau routier, posez des légendes sur la carte.
6. **Imprimez** — clic droit sur un territoire → « Imprimer ». Définissez
   couleur/épaisseur du trait, pivotez/zoomez, effacez des parties de la limite,
   exportez le PDF. Sur une carte PDF les notes deviennent de vrais
   commentaires ; sur un PNG elles sont dessinées sur la carte.
7. **Tout sur une carte murale** — importez autant de projets enregistrés que
   vous voulez dans un seul (« Importer » propose « Ajouter » à côté de
   « Remplacer » et accepte plusieurs fichiers à la fois), puis « Carte murale »
   dessine tous les territoires numérotés sur une seule feuille, jusqu'au A0.

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
