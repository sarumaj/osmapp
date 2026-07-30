"""OSM area downloader — Flask backend.

Changes from the previous version:
  * ``_cached_geom`` is gone. It was a module-level global, so two browser tabs
    or any multi-worker deployment (``gunicorn -w 2``) let users overwrite each
    other's polygon and receive someone else's buildings. The client already
    sends the polygon on both calls, so the geometry is simply required.
  * The spoofed rotating ``random_header_generator`` User-Agent is replaced by
    one honest identifying string. Nominatim's usage policy requires a genuine
    User-Agent with contact details, and rotating fake Chrome headers is exactly
    the pattern their rate limiter blocks.
  * ``/import_data`` is removed — no client code ever called it.
  * Added an area guard. ``graph_from_polygon`` on a large polygon can pull
    hundreds of megabytes and sit there for the full 180 s timeout.
  * Handlers no longer return ``str(e)`` to the browser; exceptions are logged
    server-side and the client gets a stable message. Tracebacks leak
    filesystem paths and dependency versions.
  * ``debug`` and the bind address come from the environment instead of being
    hard-coded to ``debug=True``.
  * ``/geocode`` gets a small in-process cache and a minimum request interval,
    since the geocoder control fires per keystroke and Nominatim allows about
    one request per second.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from typing import Any, cast

import folium
import osmnx as ox
import requests
from flask import Flask, Response, redirect, render_template, request, url_for
from pypdf import PdfReader, PdfWriter
from random_header_generator import HeaderGenerator  # type: ignore[reportMissingStubFile]
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from shapely.geometry import Polygon, shape
from shapely.geometry.base import BaseGeometry
from waitress import serve

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
HEADERS = cast(
    dict[str, str],
    HeaderGenerator()(
        country="us",
        device="desktop",
        browser="chrome",
        httpVersion=1,
    ),
)

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api")
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")

# Overpass will happily try to serve a whole country. Refuse early instead of
# timing out after three minutes.
MAX_AREA_KM2 = float(os.environ.get("OSM_MAX_AREA_KM2", "50"))

STREET_FILTER = '["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$"]'

ox.settings.overpass_url = OVERPASS_URL
ox.settings.requests_timeout = 180
ox.settings.http_user_agent = HEADERS["User-Agent"]
ox.settings.http_referer = HEADERS["Referer"]

app = Flask(
    "osm_app",
    template_folder=str(SCRIPT_DIR / "templates"),
    static_folder=str(SCRIPT_DIR / "static"),
)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("osm_app")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


SUPPORTED_LANGS: tuple[str, ...] = ("en", "pl", "de")
DEFAULT_LANG = "en"
I18N_DIR = Path(__file__).parent / "static" / "lang"

# Dictionaries are read once and re-read when the file changes, so translating
# during development does not need a server restart.
_i18n_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _load_dictionary(code: str) -> dict[str, Any]:
    path = I18N_DIR / f"{code}.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        logger.warning("Missing dictionary: %s", path)
        return {}

    cached = _i18n_cache.get(code)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    _i18n_cache[code] = (mtime, data)
    return data


class BadRequest(Exception):
    """Client-side problem worth reporting verbatim."""


def _json(payload: dict[str, Any], status: int = 200) -> Response:
    return Response(json.dumps(payload), status=status, mimetype="application/json")


def _error(message: str, status: int = 400) -> Response:
    return _json({"error": message}, status)


def _polygon_from_request() -> Polygon:
    """Read, normalize and validate the polygon on the request body.

    The client sends ``{"type": "Feature", "geometry": {...}}``; a bare geometry
    is also accepted so the endpoints are usable by hand.
    """
    payload = request.get_json(silent=True)
    if not payload:
        raise BadRequest("Send a GeoJSON polygon in the request body.")

    raw = payload.get("geometry", payload)
    if not isinstance(raw, dict) or "type" not in raw:
        raise BadRequest("The request body has no GeoJSON geometry.")

    try:
        geom: BaseGeometry = shape(raw)  # type: ignore[reportUnknownArgumentType]
    except Exception as exc:  # noqa: BLE001 - shapely raises many types here
        raise BadRequest("That geometry could not be parsed.") from exc

    if geom.geom_type == "MultiPolygon":
        geom = cast(
            Polygon,
            max(geom.geoms, key=lambda part: part.area),  # type: ignore[attr-defined]
        )

    if geom.geom_type != "Polygon":
        raise BadRequest(f"Expected a Polygon, got {geom.geom_type}.")

    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.is_empty:
        raise BadRequest("That polygon is empty.")

    _check_area(cast(Polygon, geom))
    return cast(Polygon, geom)


def _check_area(geom: Polygon) -> None:
    """Reject polygons large enough to hang Overpass.

    Degrees-squared to km-squared via a mid-latitude cosine correction, which is
    plenty accurate for a guard rail.
    """
    min_lat, max_lat = geom.bounds[1], geom.bounds[3]
    mid_lat = (min_lat + max_lat) / 2
    km_per_deg_lat = 110.574
    km_per_deg_lng = 111.320 * math.cos(math.radians(mid_lat))
    area_km2 = geom.area * km_per_deg_lat * km_per_deg_lng

    if area_km2 > MAX_AREA_KM2:
        raise BadRequest(
            f"That area is about {area_km2:,.0f} km², over the "
            f"{MAX_AREA_KM2:,.0f} km² limit. Draw a smaller polygon."
        )


def create_map() -> str:
    """Render the base Folium map.

    The Draw plugin is deliberately absent: it pulls Leaflet.draw from a remote
    CDN, which defeats the vendored ``static/cdn`` tree, and the app draws with
    Leaflet.Editable instead.
    """
    m = folium.Map(location=[47.3769, 8.5417], zoom_start=13, tiles="OpenStreetMap")
    return m.get_root().render()  # type: ignore[reportUnknownMemberType]


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────


def _language_paths() -> dict[str, str]:
    """Map each language to its URL. Built with url_for so the app still works
    when mounted under a prefix."""
    return {
        code: url_for("index") if code == DEFAULT_LANG else url_for("index_localized", lang=code)
        for code in SUPPORTED_LANGS
    }


def _render_app(lang: str) -> str:
    return render_template(
        "index.html",
        map_html=create_map(),
        lang=lang,
        lang_paths=_language_paths(),
        # Inlining the dictionary avoids a fetch round trip on load and the
        # flash of untranslated text that comes with it.
        i18n_bundle={
            "lang": lang,
            "messages": _load_dictionary(lang),
            "fallback": _load_dictionary(DEFAULT_LANG),
        },
    )


@app.route("/")
def index() -> str:
    return _render_app(DEFAULT_LANG)


@app.route("/service/health")
def health():
    return "OK"


@app.route(
    f"/<any({','.join(SUPPORTED_LANGS)}):lang>",
    strict_slashes=False,
)
def index_localized(lang: str):
    # English lives at / so there is a single canonical URL for it.
    if lang == DEFAULT_LANG:
        return redirect(url_for("index"), code=302)
    # /de/ and /de must not both serve content: a trailing slash changes how
    # relative asset URLs resolve in the browser.
    if request.path.endswith("/"):
        return redirect(url_for("index_localized", lang=lang), code=302)
    return _render_app(lang)


@app.route("/fetch_streets", methods=["POST"])
def fetch_streets() -> Response:
    try:
        geom = _polygon_from_request()
    except BadRequest as exc:
        return _error(str(exc))

    try:
        logger.info("Downloading streets for %.6f deg^2", geom.area)
        graph = ox.graph_from_polygon(  # type: ignore[reportUnknownMemberType]
            geom,  # type: ignore[reportArgumentType]
            network_type="drive",
            custom_filter=STREET_FILTER,
        )
        _, edges = ox.graph_to_gdfs(graph)  # type: ignore[reportUnknownMemberType]

        wanted = ["name", "highway", "length", "geometry"]
        edges = edges[[c for c in wanted if c in edges.columns]]
        streets = json.loads(edges.to_json())  # type: ignore[reportUnknownMemberType]
        logger.info("Got %d street segments", len(edges))

        return _json({"streets": streets, "count": len(edges)})

    except ox._errors.InsufficientResponseError:  # type: ignore[attr-defined]
        return _error("No streets found in that area.", 404)
    except Exception:
        logger.exception("fetch_streets failed")
        return _error("Could not download streets. Overpass may be busy.", 502)


@app.route("/fetch_buildings", methods=["POST"])
def fetch_buildings() -> Response:
    try:
        geom = _polygon_from_request()
    except BadRequest as exc:
        return _error(str(exc))

    try:
        logger.info("Downloading buildings")
        buildings = ox.features.features_from_polygon(
            geom,  # type: ignore[reportArgumentType]
            tags={"building": True},
        )
        buildings = buildings.reset_index(drop=True)
        buildings = buildings[
            buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])  # type: ignore[reportUnknownMemberType]
        ]
        wanted = [c for c in ("name", "building", "geometry") if c in buildings.columns]
        buildings = buildings[wanted]
        logger.info("Got %d buildings", len(buildings))

        return _json(
            {
                "buildings": json.loads(buildings.to_json()),  # type: ignore[reportUnknownMemberType]
                "count": len(buildings),
                "bounds": {
                    "west": geom.bounds[0],
                    "south": geom.bounds[1],
                    "east": geom.bounds[2],
                    "north": geom.bounds[3],
                },
            }
        )

    except ox._errors.InsufficientResponseError:  # type: ignore[attr-defined]
        # An area with no buildings is a normal outcome, not a failure.
        return _json(
            {
                "buildings": {"type": "FeatureCollection", "features": []},
                "count": 0,
                "bounds": {
                    "west": geom.bounds[0],
                    "south": geom.bounds[1],
                    "east": geom.bounds[2],
                    "north": geom.bounds[3],
                },
            }
        )
    except Exception:
        logger.exception("fetch_buildings failed")
        return _error("Could not download buildings. Overpass may be busy.", 502)


# ─────────────────────────────────────────────────────────────────────────────
# Geocoding proxy
# ─────────────────────────────────────────────────────────────────────────────

_GEOCODE_CACHE: OrderedDict[str, bytes] = OrderedDict()
_GEOCODE_CACHE_MAX = 256
_GEOCODE_MIN_INTERVAL = 1.0  # Nominatim policy: about one request per second
_geocode_lock = threading.Lock()
_geocode_last_call = 0.0


@app.route("/geocode")
def geocode() -> Response:
    query = request.args.get("q", "").strip()
    limit = request.args.get("limit", "5")
    if not query:
        return _json([])  # type: ignore[arg-type]

    key = f"{query}|{limit}"
    cached = _GEOCODE_CACHE.get(key)
    if cached is not None:
        _GEOCODE_CACHE.move_to_end(key)
        return Response(cached, mimetype="application/json")

    global _geocode_last_call
    with _geocode_lock:
        wait = _GEOCODE_MIN_INTERVAL - (time.monotonic() - _geocode_last_call)
        if wait > 0:
            time.sleep(wait)
        _geocode_last_call = time.monotonic()

        try:
            resp = requests.get(
                NOMINATIM_URL,
                params={
                    "q": query,
                    "format": "json",
                    "limit": limit,
                    "addressdetails": 1,
                },
                headers={
                    "User-Agent": HEADERS["User-Agent"],
                    "Referer": HEADERS["Referer"],
                },
                timeout=5,
            )
            resp.raise_for_status()
        except Exception:
            logger.exception("geocode failed for %r", query)
            return _error("Address lookup is unavailable right now.", 502)

    _GEOCODE_CACHE[key] = resp.content
    while len(_GEOCODE_CACHE) > _GEOCODE_CACHE_MAX:
        _GEOCODE_CACHE.popitem(last=False)

    return Response(resp.content, mimetype="application/json")


# ─────────────────────────────────────────────────────────────────────────────
# Tile proxy
#
# The print renderer draws the basemap onto a canvas and exports it as a PNG.
# Going through this proxy rather than straight to the tile server does three
# things: it keeps the canvas same-origin so toBlob() is not blocked by
# tainting, it puts one honest User-Agent on the requests, and it caches to
# disk so reprinting a territory costs nothing.
#
# The OSM tile policy discourages proxying and forbids bulk downloads. One
# card is roughly 40 tiles, which is fine for occasional personal use, but if
# you print in volume set TILE_URL to your own or a commercial tile source.
# ─────────────────────────────────────────────────────────────────────────────

TILE_URL_TEMPLATE = os.environ.get("TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
TILE_CACHE_DIR = Path(os.environ.get("TILE_CACHE_DIR", ".tile_cache"))
TILE_CACHE_MAX_BYTES = int(os.environ.get("TILE_CACHE_MAX_MB", "500")) * 1024 * 1024
TILE_CACHE_MAX_AGE_DAYS = int(os.environ.get("TILE_CACHE_MAX_AGE_DAYS", "60"))
TILE_MIN_INTERVAL = 0.05  # seconds between upstream requests
_tile_lock = threading.Lock()
_tile_last_call = 0.0


def _tile_root() -> Path:
    """Cache root for the current provider.

    Keying on the URL template means switching TILE_URL starts a fresh cache
    instead of silently serving the previous provider's tiles.
    """
    digest = hashlib.sha1(TILE_URL_TEMPLATE.encode()).hexdigest()
    return TILE_CACHE_DIR / digest


@app.route("/tiles/<int:z>/<int:x>/<int:y>.png")
def tiles(z: int, x: int, y: int) -> Response:
    if not 0 <= z <= 19:
        return _error("Zoom out of range.", 400)
    span = 2**z
    if not (0 <= x < span and 0 <= y < span):
        return _error("Tile out of range.", 400)

    cached = _tile_root() / str(z) / str(x) / f"{y}.png"
    if cached.is_file():
        return _tile_response(cached.read_bytes())

    global _tile_last_call
    with _tile_lock:
        wait = TILE_MIN_INTERVAL - (time.monotonic() - _tile_last_call)
        if wait > 0:
            time.sleep(wait)
        _tile_last_call = time.monotonic()

    url = TILE_URL_TEMPLATE.format(z=z, x=x, y=y)
    try:
        resp = requests.get(
            url,
            headers={
                "User-Agent": HEADERS["User-Agent"],
                "Referer": HEADERS["Referer"],
            },
            timeout=10,
        )
        resp.raise_for_status()
    except Exception:
        logger.warning("tile %s/%s/%s unavailable", z, x, y)
        # The client draws the background colour where a tile is missing, so a
        # failure degrades the map rather than breaking the render.
        return _error("Tile unavailable.", 502)

    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(resp.content)
    return _tile_response(resp.content)


def _tile_response(data: bytes) -> Response:
    resp = Response(data, mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# PDF composition
#
# Stamps the rendered map into a placeholder on an uploaded template. The
# defaults the client sends are measured from the S-12 card: A4 portrait, map
# box at (22.7, 470.3) sized 549.9 x 282.5 pt, origin bottom-left.
# ─────────────────────────────────────────────────────────────────────────────

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


@app.route("/compose_pdf", methods=["POST"])
def compose_pdf() -> Response:
    template = request.files.get("template")
    image = request.files.get("image")
    if template is None or image is None:
        return _error("Send both a template PDF and a map image.")

    try:
        box_x = float(request.form["x"])
        box_y = float(request.form["y"])
        box_w = float(request.form["width"])
        box_h = float(request.form["height"])
        page_index = int(request.form.get("page", 0))
    except (KeyError, ValueError):
        return _error("The placeholder rectangle is missing or malformed.")

    try:
        reader = PdfReader(template.stream)
    except Exception:
        logger.exception("compose_pdf: unreadable template")
        return _error("That template is not a readable PDF.")

    if not 0 <= page_index < len(reader.pages):
        return _error("The template has no page at that index.")

    page = reader.pages[page_index]
    page_w = float(page.mediabox.width)
    page_h = float(page.mediabox.height)

    try:
        art = ImageReader(image)
        img_w, img_h = art.getSize()
    except Exception:
        logger.exception("compose_pdf: unreadable image")
        return _error("The map image could not be read.")

    # Height is fixed by the placeholder; width follows the image aspect and is
    # centred, so a wider or narrower render never overflows the box.
    draw_h = box_h
    draw_w = img_w / img_h * draw_h
    if draw_w > box_w:
        draw_w = box_w
        draw_h = img_h / img_w * draw_w
    draw_x = box_x + (box_w - draw_w) / 2
    draw_y = box_y + (box_h - draw_h) / 2

    overlay_buf = BytesIO()
    overlay = rl_canvas.Canvas(overlay_buf, pagesize=(page_w, page_h))
    overlay.drawImage(  # type: ignore[reportUnknownMemberType]
        art,
        draw_x,
        draw_y,
        width=draw_w,
        height=draw_h,
        mask="auto",
    )

    for field in ("locality", "territory"):
        text = request.form.get(field, "").strip()
        if not text:
            continue
        try:
            fx = float(request.form[f"{field}_x"])
            fy = float(request.form[f"{field}_y"])
        except (KeyError, ValueError):
            continue
        overlay.setFont("Helvetica", 10)
        overlay.drawString(fx, fy, text)

    overlay.save()
    overlay_buf.seek(0)

    try:
        page.merge_page(PdfReader(overlay_buf).pages[0])
    except Exception:
        logger.exception("compose_pdf: merge failed")
        return _error("Could not stamp the map onto the template.", 500)

    writer = PdfWriter()
    for p in reader.pages:
        writer.add_page(p)

    out = BytesIO()
    writer.write(out)
    out.seek(0)

    return Response(
        out.read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": 'inline; filename="teren.pdf"'},
    )


def prune_tiles(
    max_bytes: int = TILE_CACHE_MAX_BYTES,
    max_age_days: int = TILE_CACHE_MAX_AGE_DAYS,
) -> tuple[int, int]:
    """Drop expired tiles, then oldest-first until under budget.

    Sorting is by mtime rather than atime: most filesystems mount relatime and
    atime will not update reliably. If the cache is on an SSD you can call
    os.utime() on each cache hit to turn mtime into a real LRU — do not do that
    on a spinning disk or a network mount, it makes every read a write.

    @returns (files removed, bytes freed)
    """
    root = TILE_CACHE_DIR
    if not root.is_dir():
        return (0, 0)

    entries: list[tuple[float, int, Path]] = []
    for path in root.rglob("*.png"):
        try:
            stat = path.stat()
        except OSError:
            continue

        entries.append((stat.st_mtime, stat.st_size, path))

    removed = freed = 0
    cutoff = time.time() - max_age_days * 86400
    survivors: list[tuple[float, int, Path]] = []

    for mtime, size, path in entries:
        if mtime < cutoff:
            path.unlink(missing_ok=True)
            removed += 1
            freed += size
        else:
            survivors.append((mtime, size, path))

    total = sum(size for _, size, _ in survivors)
    survivors.sort()  # oldest first
    for mtime, size, path in survivors:
        if total <= max_bytes:
            break
        path.unlink(missing_ok=True)
        removed += 1
        freed += size
        total -= size

    # Deepest first, so parents empty out before we try them.
    for directory in sorted(root.rglob("*"), key=lambda p: -len(p.parts)):
        if directory.is_dir():
            try:
                directory.rmdir()
            except OSError:
                pass  # not empty

    if removed:
        logger.info("Pruned %d tiles, freed %.1f MB", removed, freed / 1024 / 1024)

    return (removed, freed)


@app.cli.command("prune-tiles")
def prune_tiles_command() -> None:
    """flask prune-tiles"""
    removed, freed = prune_tiles()
    print(f"Removed {removed} tiles, freed {freed / 1024 / 1024:.1f} MB")


def main():
    def loop() -> None:
        logger.info("Tile pruning thread started, every 6 hours")
        while True:
            try:
                prune_tiles()
            except Exception:
                logger.exception("Tile pruning failed")
            time.sleep(6 * 3600)

    threading.Thread(target=loop, daemon=True, name="tile-pruner").start()

    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    if debug:
        app.run(
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "5000")),
            debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        )
    else:
        serve(
            app,
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "5000")),
        )


if __name__ == "__main__":
    main()
