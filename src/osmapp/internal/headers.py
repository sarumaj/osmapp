"""Identifying headers for outbound requests, and the osmnx global settings.

Two paths reach third-party services. Requests this app issues directly --
Nominatim through geocode.py, tiles through tiles.py - carry `get_headers()`,
a fixed contact pair. Requests osmnx issues on our behalf carry whatever sits
in `ox.settings`, which `init_osmnx` seeds with the same contact pair and
`refresh_random_osmnx_headers` then replaces on a schedule.
"""

import threading

import osmnx as ox
from random_header_generator import (  # type: ignore[reportMissingTypeStubs]
    HeaderGenerator,
)

user_agent = (
    "osmapp (+https://osmapp.sarumaj.com; 71898979+sarumaj@users.noreply.github.com)"
)
referer = "https://osmapp.sarumaj.com/"
_lock_headers = threading.Lock()


def refresh_random_osmnx_headers():
    """Replace osmnx's User-Agent and Referer with a generated desktop pair.

    Overwrites whatever `init_osmnx` installed, so the contact pair below only
    identifies osmnx traffic until the first refresh runs.
    """
    generator = HeaderGenerator()
    headers = generator(
        country="us",
        device="desktop",
        httpVersion=1,
    )
    with _lock_headers:
        ox.settings.http_user_agent = headers["User-Agent"]
        ox.settings.http_referer = headers["Referer"]


def init_osmnx(overpass_url: str, timeout: int = 180):
    """Push endpoint + current headers into osmnx global settings."""
    ox.settings.overpass_url = overpass_url
    ox.settings.requests_timeout = timeout
    with _lock_headers:
        ox.settings.http_user_agent = user_agent
        ox.settings.http_referer = referer


def get_headers() -> dict[str, str]:
    """The contact pair for requests this app issues itself, not through osmnx."""

    return {"User-Agent": user_agent, "Referer": referer}
