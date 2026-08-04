"""OSMNX headers and settings for osmapp."""

import threading

import osmnx as ox
from random_header_generator import (  # type: ignore[reportMissingTypeStubs]
    HeaderGenerator,
)

user_agent = "osmapp (+https://osmapp.sarumaj.com; 71898979+sarumaj@users.noreply.github.com)"
referer = "https://osmapp.sarumaj.com/"
_lock_headers = threading.Lock()


def refresh_random_osmnx_headers() -> None:
    """Refresh the global headers for OSMNX."""
    generator = HeaderGenerator()
    headers = generator(
        country="us",
        device="desktop",
        httpVersion=1,
    )
    with _lock_headers:
        ox.settings.http_user_agent = headers["User-Agent"]
        ox.settings.http_referer = headers["Referer"]


def init_osmnx(overpass_url: str, timeout: int = 180) -> None:
    """Push endpoint + current headers into osmnx global settings."""
    ox.settings.overpass_url = overpass_url
    ox.settings.requests_timeout = timeout
    with _lock_headers:
        ox.settings.http_user_agent = user_agent
        ox.settings.http_referer = referer


def get_headers(random: bool) -> dict[str, str]:
    """Thread-safe snapshot of the current headers."""
    if random:
        generator = HeaderGenerator()
        headers = generator(
            country="us",
            device="desktop",
            httpVersion=1,
        )
        return {"User-Agent": headers["User-Agent"], "Referer": headers["Referer"]}
    else:
        return {"User-Agent": user_agent, "Referer": referer}
