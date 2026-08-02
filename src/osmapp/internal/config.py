"""Environment-driven configuration constants."""

import os
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent.parent  # project root
TEMPLATE_DIR = SCRIPT_DIR / "templates"
STATIC_DIR = SCRIPT_DIR / "static"
I18N_DIR = STATIC_DIR / "lang"

# ── Overpass / Nominatim ───────────────────────────────────────────────────────

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api")
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")

# Refuse early instead of hanging Overpass for three minutes.
MAX_AREA_KM2 = float(os.environ.get("OSM_MAX_AREA_KM2", "50"))

STREET_FILTER = '["highway"~"^(motorway|trunk|primary|secondary|tertiary|' 'residential|unclassified)$"]'

# ── Tile proxy ─────────────────────────────────────────────────────────────────

TILE_URL_TEMPLATE = os.environ.get("TILE_URL", "https://tile.openstreetmap.org/{z}/{x}/{y}.png")
TILE_CACHE_DIR = Path(os.environ.get("TILE_CACHE_DIR", ".tile_cache"))
TILE_CACHE_MAX_BYTES = int(os.environ.get("TILE_CACHE_MAX_MB", "500")) * 1024 * 1024
TILE_CACHE_MAX_AGE_DAYS = int(os.environ.get("TILE_CACHE_MAX_AGE_DAYS", "60"))
TILE_MIN_INTERVAL = 0.05  # seconds between upstream requests

# ── Geocode proxy ──────────────────────────────────────────────────────────────

GEOCODE_CACHE_MAX = 256
GEOCODE_MIN_INTERVAL = 1.0  # Nominatim policy: ~1 request/second

# ── Upload limit ───────────────────────────────────────────────────────────────

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
