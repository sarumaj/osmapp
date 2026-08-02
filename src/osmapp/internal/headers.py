"""Rotating User-Agent / Referer and osmnx settings initialization."""

import threading
from typing import cast

import osmnx as ox
from random_header_generator import HeaderGenerator  # type: ignore[import-untyped]

_lock = threading.Lock()

HEADERS: dict[str, str] = cast(
    dict[str, str],
    HeaderGenerator()(country="us", device="desktop", browser="chrome", httpVersion=1),
)


def init_osmnx(overpass_url: str, timeout: int = 180) -> None:
    """Push endpoint + current headers into osmnx global settings."""
    ox.settings.overpass_url = overpass_url
    ox.settings.requests_timeout = timeout
    with _lock:
        ox.settings.http_user_agent = HEADERS["User-Agent"]
        ox.settings.http_referer = HEADERS["Referer"]


def refresh_headers() -> None:
    """Generate a new header set and update osmnx in place."""
    global HEADERS
    new = cast(
        dict[str, str],
        HeaderGenerator()(country="us", device="desktop", browser="chrome", httpVersion=1),
    )
    with _lock:
        HEADERS = new  # type: ignore[reportConstantRedefinition]
        ox.settings.http_user_agent = HEADERS["User-Agent"]
        ox.settings.http_referer = HEADERS["Referer"]


def get_headers() -> dict[str, str]:
    """Thread-safe snapshot of the current headers."""
    with _lock:
        return HEADERS
