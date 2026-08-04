"""OSM tile proxy with disk cache and background pruning."""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import Blueprint, Response, request

from .config import (
    TILE_CACHE_DIR,
    TILE_CACHE_MAX_AGE_DAYS,
    TILE_CACHE_MAX_BYTES,
    TILE_URL_TEMPLATE,
)
from .headers import get_headers
from .responses import error_

logger = logging.getLogger("osm_app")
bp = Blueprint("tiles", __name__)


# ── helpers ───────────────────────────────────────────────────────────────────


def _same_origin() -> bool:
    ref = request.headers.get("Referer") or request.headers.get("Origin")
    if not ref:
        return False
    return urlparse(ref).netloc == urlparse(request.host_url).netloc


def _tile_root() -> Path:
    """Cache directory keyed on the URL template.

    Switching TILE_URL starts a fresh cache instead of silently serving the
    previous provider's tiles.
    """
    digest = hashlib.sha1(TILE_URL_TEMPLATE.encode()).hexdigest()
    return TILE_CACHE_DIR / digest


def _tile_response(data: bytes) -> Response:
    resp = Response(data, mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


# ── route ─────────────────────────────────────────────────────────────────────


@bp.route("/tiles/<int:z>/<int:x>/<int:y>.png")
def tiles(z: int, x: int, y: int) -> Response:
    if not _same_origin():
        return error_("Tiles are only served to this application.", 403)

    if not 0 <= z <= 19:
        return error_("Zoom out of range.", 400)

    span = 2**z
    if not (0 <= x < span and 0 <= y < span):
        return error_("Tile out of range.", 400)

    cached = _tile_root() / str(z) / str(x) / f"{y}.png"
    if cached.is_file():
        return _tile_response(cached.read_bytes())

    url = TILE_URL_TEMPLATE.format(z=z, x=x, y=y)
    try:
        resp = requests.get(
            url,
            headers=get_headers(False),
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


# ── cache management ──────────────────────────────────────────────────────────


def prune_tiles(
    max_bytes: int = TILE_CACHE_MAX_BYTES,
    max_age_days: int = TILE_CACHE_MAX_AGE_DAYS,
) -> tuple[int, int]:
    """Drop expired tiles, then oldest-first until under budget.

    Sorting is by mtime rather than atime: most filesystems mount relatime and
    atime will not update reliably.

    Returns (files_removed, bytes_freed).
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

    total = sum(s for _, s, _ in survivors)
    survivors.sort()  # oldest first
    for _, size, path in survivors:
        if total <= max_bytes:
            break
        path.unlink(missing_ok=True)
        removed += 1
        freed += size
        total -= size

    # Deepest first so parents empty before we try to remove them.
    for d in sorted(root.rglob("*"), key=lambda p: -len(p.parts)):
        if d.is_dir():
            try:
                d.rmdir()
            except OSError:
                pass

    if removed:
        logger.info("Pruned %d tiles, freed %.1f MB", removed, freed / 1024 / 1024)

    return (removed, freed)
