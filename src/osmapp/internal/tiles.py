"""Tile proxy with disk cache and background pruning.

Two kinds of tile go through here, and the difference matters:

  /tiles/<z>/<x>/<y>.png            the OSM basemap. The only one a territory
                                    card is ever composed from.
  /tiles/aid/<layer>/<z>/<x>/<y>.png  optional on-screen aids (aerial imagery,
                                    terrain). Never printed - see print.js,
                                    which builds its URLs from a constant and
                                    has no way to reach this route at all.

They share one cache directory but not one standing. `prune_tiles` evicts aid
tiles before OSM tiles, because a session spent panning around satellite
imagery must not throw away the basemap someone is about to print fifty cards
from.
"""

import hashlib
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from flask import Blueprint, Response, request

from .config import (
    AID_LAYERS,
    TILE_CACHE_DIR,
    TILE_CACHE_MAX_AGE_DAYS,
    TILE_CACHE_MAX_BYTES,
    TILE_MAX_ZOOM,
    TILE_URL_TEMPLATE,
)
from .headers import get_headers
from .responses import error_

logger = logging.getLogger("osm_app")
bp = Blueprint("tiles", __name__)


# helpers


def _same_origin() -> bool:
    ref = request.headers.get("Referer") or request.headers.get("Origin")
    if not ref:
        return False
    return urlparse(ref).netloc == urlparse(request.host_url).netloc


def _tile_root(template: str = TILE_URL_TEMPLATE) -> Path:
    """Cache directory keyed on the URL template.

    Switching TILE_URL starts a fresh cache instead of silently serving the
    previous provider's tiles, and it is what keeps the aid layers in their own
    subtrees without a naming scheme anyone has to maintain.
    """
    digest = hashlib.sha1(template.encode()).hexdigest()
    return TILE_CACHE_DIR / digest


def _mimetype(data: bytes) -> str:
    """Sniff the payload rather than trusting the file name.

    Cached tiles are all written as `.png` - the extension names a cache slot,
    not a format - so that `prune_tiles` keeps one glob and the read path stays
    a single stat. Imagery providers serve JPEG, and a JPEG announced as
    `image/png` decodes in a browser but not in every canvas pipeline.
    """
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _tile_response(data: bytes) -> Response:
    resp = Response(data, mimetype=_mimetype(data))
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


# routes


@bp.route("/tiles/<int:z>/<int:x>/<int:y>.png")
def tiles(z: int, x: int, y: int) -> Response:
    """The OSM basemap: what the app shows by default and what it prints."""
    return _serve(TILE_URL_TEMPLATE, z, x, y, TILE_MAX_ZOOM)


@bp.route("/tiles/aid/<layer>/<int:z>/<int:x>/<int:y>.png")
def aid_tiles(layer: str, z: int, x: int, y: int) -> Response:
    """An optional on-screen basemap: imagery, terrain, whatever is configured.

    `layer` is a key into AID_LAYERS and nothing else - an unknown name is a
    404 before any URL is built, so neither a path nor a template can be
    smuggled in through it.
    """
    spec = AID_LAYERS.get(layer)
    if spec is None:
        return error_("Unknown basemap.", 404)
    return _serve(spec["url"], z, x, y, spec["maxZoom"])


def _serve(template: str, z: int, x: int, y: int, max_zoom: int) -> Response:
    if not _same_origin():
        return error_("Tiles are only served to this application.", 403)

    if not 0 <= z <= max_zoom:
        return error_("Zoom out of range.", 400)

    span = 2**z
    if not (0 <= x < span and 0 <= y < span):
        return error_("Tile out of range.", 400)

    cached = _tile_root(template) / str(z) / str(x) / f"{y}.png"
    if cached.is_file():
        return _tile_response(cached.read_bytes())

    url = template.format(z=z, x=x, y=y)
    try:
        resp = requests.get(
            url,
            headers=get_headers(),
            timeout=10,
        )
        resp.raise_for_status()
        ctype = resp.headers.get("Content-Type", "")
        if not ctype.startswith("image/"):
            # An upstream error page returned with 200 would otherwise be
            # cached as a tile for TILE_CACHE_MAX_AGE_DAYS.
            raise ValueError(f"tile server returned {ctype!r}")
    except Exception:  # noqa: BLE001
        logger.warning("tile %s/%s/%s unavailable", z, x, y)
        return error_("Tile unavailable.", 502)

    cached.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename: a crash mid-write must not leave a truncated PNG that
    # is served as valid for the next sixty days.
    fd, tmp_name = tempfile.mkstemp(dir=str(cached.parent), suffix=".part")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(resp.content)
        os.replace(tmp, cached)
    except Exception:
        tmp.unlink(missing_ok=True)
        logger.exception("tile %s/%s/%s cache write failed", z, x, y)
        return error_("Tile cache write failed.", 500)
    return _tile_response(resp.content)


# client configuration


def client_basemaps() -> dict[str, Any]:
    """What App.basemap needs to build the layer switcher.

    Only proxied URLs are handed out. The client never learns the upstream
    provider's address, so switching TILE_URL or an aid layer is a server-side
    change and the browser keeps talking to one origin.
    """
    return {
        "base": {
            "id": "osm",
            "labelKey": "layers.map",
            "url": "/tiles/{z}/{x}/{y}.png",
            "maxZoom": TILE_MAX_ZOOM,
            "attribution": "© OpenStreetMap contributors",
        },
        "aid": [
            {
                "id": spec["id"],
                "labelKey": spec["labelKey"],
                "url": f"/tiles/aid/{spec['id']}/{{z}}/{{x}}/{{y}}.png",
                # Leaflet keeps the map's own maxZoom and upscales past this,
                # so a 17-level terrain layer still fills the frame at z19
                # instead of going blank when you switch to it.
                "maxNativeZoom": spec["maxZoom"],
                "attribution": spec["attribution"],
            }
            for spec in AID_LAYERS.values()
        ],
    }


# cache management


def _is_basemap(path: Path, root: Path, base: str) -> bool:
    try:
        return path.relative_to(root).parts[0] == base
    except (ValueError, IndexError):
        return False


def prune_tiles(
    max_bytes: int = TILE_CACHE_MAX_BYTES,
    max_age_days: int = TILE_CACHE_MAX_AGE_DAYS,
) -> tuple[int, int]:
    """Drop expired tiles, then evict until under budget.

    Eviction order is (is basemap, mtime): every aid tile goes before the
    oldest OSM tile. One shared budget with a priority is better than two
    budgets here - an aid layer nobody switches to costs nothing, while a long
    session on satellite imagery cannot quietly evict the basemap behind the
    territory someone is about to print.

    Sorting is by mtime rather than atime: most filesystems mount relatime and
    atime will not update reliably.

    Returns (files_removed, bytes_freed).
    """
    base = _tile_root().name
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

    total = sum(s for _, s, _ in survivors)
    # False sorts before True, so aid tiles lead and the basemap is taken last.
    survivors.sort(key=lambda entry: (_is_basemap(entry[2], root, base), entry[0]))
    for _, size, path in survivors:
        if total <= max_bytes:
            break
        path.unlink(missing_ok=True)
        removed += 1
        freed += size
        total -= size

    # Deepest first, so a parent is empty by the time it is reached.
    for d in sorted(root.rglob("*"), key=lambda p: -len(p.parts)):
        if d.is_dir():
            try:
                d.rmdir()
            except OSError:
                pass

    if removed:
        logger.info("Pruned %d tiles, freed %.1f MB", removed, freed / 1024 / 1024)

    return (removed, freed)
