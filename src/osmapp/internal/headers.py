"""OSMNX headers and settings for osmapp."""

import osmnx as ox

UA = "osmapp (+https://osmapp.sarumaj.com; 71898979+sarumaj@users.noreply.github.com)"
REFERER = "https://osmapp.sarumaj.com/"


def init_osmnx(overpass_url: str, timeout: int = 180) -> None:
    """Push endpoint + current headers into osmnx global settings."""
    ox.settings.overpass_url = overpass_url
    ox.settings.requests_timeout = timeout
    ox.settings.http_user_agent = UA
    ox.settings.http_referer = REFERER


def get_headers() -> dict[str, str]:
    """Thread-safe snapshot of the current headers."""
    return {"User-Agent": UA, "Referer": REFERER}
