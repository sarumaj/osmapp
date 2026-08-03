"""Nominatim geocoding proxy with LRU cache and rate limiter."""

import logging
import threading
import time
from collections import OrderedDict

import requests
from flask import Blueprint, Response, request

from .config import GEOCODE_CACHE_MAX, GEOCODE_MIN_INTERVAL, NOMINATIM_URL
from .headers import get_headers
from .responses import error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("geocode", __name__)

_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()
_slot_lock = threading.Lock()
_next_slot = 0.0


def _reserve_slot() -> float:
    """Claim the next 1-req/s window without holding a lock across the wait."""
    global _next_slot
    with _slot_lock:
        slot = max(time.monotonic(), _next_slot)
        _next_slot = slot + GEOCODE_MIN_INTERVAL
        return slot


@bp.route("/geocode")
def geocode() -> Response:
    query = request.args.get("q", "").strip()
    if not query:
        return json_([])

    try:
        limit = min(10, max(1, int(request.args.get("limit", "5"))))
    except ValueError:
        limit = 5

    key = f"{query}|{limit}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
    if hit is not None:
        return Response(hit, mimetype="application/json")

    slot = _reserve_slot()
    wait = slot - time.monotonic()
    if wait > 0:
        time.sleep(wait)

    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={
                "q": query,
                "format": "json",
                "limit": limit,
                "addressdetails": 1,
            },
            headers=get_headers(),
            timeout=5,
        )
        resp.raise_for_status()
    except Exception:
        logger.exception("geocode failed for %r", query)
        return error_("Address lookup is unavailable right now.", 502)

    with _cache_lock:
        _cache[key] = resp.content
        while len(_cache) > GEOCODE_CACHE_MAX:
            _cache.popitem(last=False)

    return Response(resp.content, mimetype="application/json")
