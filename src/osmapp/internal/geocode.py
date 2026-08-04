"""Nominatim geocoding proxy with LRU cache and rate limiter.

Two routes:
  • /geocode           — address search, the same payload Nominatim returns.
  • /geocode_boundary  — the outline of one result, looked up by osm_type and
    osm_id. Kept separate on purpose: /geocode is called on every keystroke by
    the search box, and a city relation's polygon is far too heavy to ship with
    a suggestion list. The client only asks for the outline once someone picks a
    result and wants it as the outer boundary.
"""

import logging
import threading
import time
from collections import OrderedDict
from typing import Any, cast

import requests
from flask import Blueprint, Response, request
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from .config import (
    BOUNDARY_MAX_THRESHOLD,
    BOUNDARY_THRESHOLD,
    GEOCODE_CACHE_MAX,
    GEOCODE_MIN_INTERVAL,
    MAX_AREA_KM2,
    NOMINATIM_LOOKUP_URL,
    NOMINATIM_URL,
)
from .geo import approx_area_km2
from .headers import get_headers
from .responses import error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("geocode", __name__)

_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()
_slot_lock = threading.Lock()
_next_slot = 0.0

# Nominatim wants the compact form (R2740233); the client speaks the long one.
_OSM_PREFIX = {
    "node": "N",
    "way": "W",
    "relation": "R",
    "n": "N",
    "w": "W",
    "r": "R",
}


def _reserve_slot() -> float:
    """Claim the next 1-req/s window without holding a lock across the wait."""
    global _next_slot
    with _slot_lock:
        slot = max(time.monotonic(), _next_slot)
        _next_slot = slot + GEOCODE_MIN_INTERVAL
        return slot


def _cache_get(key: str) -> bytes | None:
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
    return hit


def _cache_put(key: str, value: bytes) -> None:
    with _cache_lock:
        _cache[key] = value
        while len(_cache) > GEOCODE_CACHE_MAX:
            _cache.popitem(last=False)


def _nominatim(url: str, params: dict[str, Any]) -> requests.Response:
    """One rate-limited call. Raises on a transport or HTTP error."""
    wait = _reserve_slot() - time.monotonic()
    if wait > 0:
        time.sleep(wait)

    resp = requests.get(url, params=params, headers=get_headers(False), timeout=10)
    resp.raise_for_status()
    return resp


# ── search ────────────────────────────────────────────────────────────────────


@bp.route("/geocode")
def geocode() -> Response:
    query = request.args.get("q", "").strip()
    if not query:
        return json_([])

    try:
        limit = min(10, max(1, int(request.args.get("limit", "5"))))
    except ValueError:
        limit = 5

    key = f"search|{query}|{limit}"
    hit = _cache_get(key)
    if hit is not None:
        return Response(hit, mimetype="application/json")

    try:
        resp = _nominatim(
            NOMINATIM_URL,
            {
                "q": query,
                "format": "json",
                "limit": limit,
                "addressdetails": 1,
            },
        )
    except Exception:
        logger.exception("geocode failed for %r", query)
        return error_("Address lookup is unavailable right now.", 502)

    _cache_put(key, resp.content)
    return Response(resp.content, mimetype="application/json")


# ── boundary lookup ───────────────────────────────────────────────────────────


def _count_vertices(geometry: dict[str, Any]) -> int:
    """Positions in a GeoJSON geometry, however deeply nested."""

    def walk(node: Any) -> int:
        if not isinstance(node, list):
            return 0
        if node and isinstance(node[0], (int, float)):
            return 1
        return sum(walk(child) for child in node)  # type: ignore[reportUnknownArgumentType]

    return walk(geometry.get("coordinates"))


def _bounds(item: dict[str, Any], geom: BaseGeometry | None) -> dict[str, float] | None:
    """Prefer the geometry's own envelope; fall back to Nominatim's bbox."""
    if geom is not None and not geom.is_empty:
        west, south, east, north = geom.bounds
        return {"west": west, "south": south, "east": east, "north": north}

    box = item.get("boundingbox")  # ["south", "north", "west", "east"], strings
    if not isinstance(box, list) or len(box) != 4:  # type: ignore[reportUnknownArgumentType]
        return None
    try:
        south, north, west, east = (float(v) for v in box)  # type: ignore[reportUnknownArgumentType]
    except (TypeError, ValueError):
        return None
    return {"west": west, "south": south, "east": east, "north": north}


@bp.route("/geocode_boundary")
def geocode_boundary() -> Response:
    """Resolve one search result to its administrative outline.

    Always answers 200 with ``geometry: null`` when the object has no polygon —
    a house number or a place node is a perfectly ordinary result, not an error,
    and the client falls back to offering the bounding box.
    """
    prefix = _OSM_PREFIX.get(request.args.get("osm_type", "").strip().lower())
    osm_id = request.args.get("osm_id", "").strip()
    if not prefix or not osm_id.isdigit():
        return error_("Provide osm_type (node|way|relation) and a numeric osm_id.")

    try:
        threshold = float(request.args.get("threshold", BOUNDARY_THRESHOLD))
    except ValueError:
        threshold = BOUNDARY_THRESHOLD
    threshold = min(BOUNDARY_MAX_THRESHOLD, max(0.0, threshold))

    osm_ref = f"{prefix}{osm_id}"
    key = f"boundary|{osm_ref}|{threshold}"
    hit = _cache_get(key)
    if hit is not None:
        return Response(hit, mimetype="application/json")

    try:
        resp = _nominatim(
            NOMINATIM_LOOKUP_URL,
            {
                "osm_ids": osm_ref,
                "format": "json",
                "polygon_geojson": 1,
                "polygon_threshold": threshold,
                "extratags": 1,
                "addressdetails": 0,
            },
        )
        items = resp.json()
    except Exception:
        logger.exception("boundary lookup failed for %s", osm_ref)
        return error_("The boundary lookup is unavailable right now.", 502)

    if not isinstance(items, list) or not items:
        return error_("Nothing found for that OSM object.", 404)

    item = cast(dict[str, Any], items[0])
    raw = item.get("geojson")

    geom: BaseGeometry | None = None
    geometry: dict[str, Any] | None = None
    if isinstance(raw, dict) and raw.get("type") in ("Polygon", "MultiPolygon"):  # type: ignore[reportUnknownMemberType]
        try:
            geom = shape(raw)  # type: ignore[reportUnknownArgumentType]
            if not geom.is_valid:
                repaired = geom.buffer(0)
                if not repaired.is_empty and repaired.geom_type in (
                    "Polygon",
                    "MultiPolygon",
                ):
                    geom = repaired
            geometry = cast(dict[str, Any], raw)
        except Exception:
            logger.warning("unusable boundary geometry for %s", osm_ref)
            geom = None

    parts = 1
    if geom is not None and geom.geom_type == "MultiPolygon":
        parts = len(geom.geoms)  # type: ignore[attr-defined]

    extratags = cast(dict[str, Any], item.get("extratags") or {})
    payload: dict[str, Any] = {
        "name": item.get("display_name"),
        "osmType": item.get("osm_type"),
        "osmId": item.get("osm_id"),
        "category": item.get("category") or item.get("class"),
        "type": item.get("type"),
        "adminLevel": extratags.get("admin_level"),
        "geometry": geometry,
        "parts": parts if geometry else 0,
        "vertices": _count_vertices(geometry) if geometry else 0,
        "areaKm2": round(approx_area_km2(geom), 3) if geom is not None else None,
        "maxAreaKm2": MAX_AREA_KM2,
        "bounds": _bounds(item, geom),
        "threshold": threshold,
    }

    body = json_(payload)
    _cache_put(key, body.get_data())
    return body
