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
_lock = threading.Lock()
_last_call = 0.0


@bp.route("/geocode")
def geocode() -> Response:
    query = request.args.get("q", "").strip()
    limit = request.args.get("limit", "5")
    if not query:
        return json_([])  # type: ignore[arg-type]

    key = f"{query}|{limit}"
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        return Response(hit, mimetype="application/json")

    global _last_call
    with _lock:
        wait = GEOCODE_MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()

        try:
            h = get_headers()
            resp = requests.get(
                NOMINATIM_URL,
                params={"q": query, "format": "json", "limit": limit, "addressdetails": 1},
                headers={"User-Agent": h["User-Agent"], "Referer": h["Referer"]},
                timeout=5,
            )
            resp.raise_for_status()
        except Exception:
            logger.exception("geocode failed for %r", query)
            return error_("Address lookup is unavailable right now.", 502)

    _cache[key] = resp.content
    while len(_cache) > GEOCODE_CACHE_MAX:
        _cache.popitem(last=False)

    return Response(resp.content, mimetype="application/json")
