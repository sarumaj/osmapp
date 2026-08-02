"""OSM tile proxy with disk cache and background pruning."""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from pathlib import Path

import requests
from flask import Blueprint, Response

from .config import (
    TILE_CACHE_DIR,
    TILE_CACHE_MAX_AGE_DAYS,
    TILE_CACHE_MAX_BYTES,
    TILE_MIN_INTERVAL,
    TILE_URL_TEMPLATE,
)
from .headers import get_headers
from .responses import error_

logger = logging.getLogger("osm_app")
bp = Blueprint("tiles", __name__)

_lock = threading.Lock()
_last_call = 0.0


# ── helpers ───────────────────────────────────────────────────────────────────


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
    if not 0 <= z <= 19:
        return error_("Zoom out of range.", 400)
    span = 2**z
    if not (0 <= x < span and 0 <= y < span):
        return error_("Tile out of range.", 400)

    cached = _tile_root() / str(z) / str(x) / f"{y}.png"
    if cached.is_file():
        return _tile_response(cached.read_bytes())

    global _last_call
    with _lock:
        wait = TILE_MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()

    url = TILE_URL_TEMPLATE.format(z=z, x=x, y=y)
    try:
        h = get_headers()
        resp = requests.get(
            url,
            headers={"User-Agent": h["User-Agent"], "Referer": h["Referer"]},
            timeout=10,
        )
        resp.raise_for_status()
    except Exception:
        logger.warning("tile %s/%s/%s unavailable", z, x, y)
        return error_("Tile unavailable.", 502)

    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_bytes(resp.content)
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
