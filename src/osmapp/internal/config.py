"""Environment-driven configuration constants."""

import os
import re
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent.parent  # project root
TEMPLATE_DIR = SCRIPT_DIR / "templates"
STATIC_DIR = SCRIPT_DIR / "static"
I18N_DIR = STATIC_DIR / "lang"
FONT_PATH = STATIC_DIR / "fonts" / "DejaVuSans.ttf"

# ── Overpass / Nominatim ───────────────────────────────────────────────────────

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api")
OVERPASS_TIMEOUT = int(os.environ.get("OVERPASS_TIMEOUT", "180"))  # seconds
NOMINATIM_URL = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
# /lookup resolves an osm_type + osm_id straight to one object, which is how the
# outer-boundary suggestion gets a polygon without asking /search for geometry on
# every keystroke. Derived from NOMINATIM_URL so a self-hosted instance only has
# to be configured once.
NOMINATIM_LOOKUP_URL = os.environ.get("NOMINATIM_LOOKUP_URL", "") or re.sub(r"/search/?$", "/lookup", NOMINATIM_URL)

# Refuse early instead of hanging Overpass for three minutes.
MAX_AREA_KM2 = float(os.environ.get("OSM_MAX_AREA_KM2", "50"))

STREET_FILTER = '["highway"~"^(motorway|trunk|primary|secondary|tertiary|' 'residential|unclassified)$"]'

# ── Tile proxy ─────────────────────────────────────────────────────────────────

TILE_URL_TEMPLATE = os.environ.get("TILE_URL", "https://tile.openstreetmap.de/{z}/{x}/{y}.png")
TILE_CACHE_DIR = Path(os.environ.get("TILE_CACHE_DIR", ".tile_cache"))
TILE_CACHE_MAX_BYTES = int(os.environ.get("TILE_CACHE_MAX_MB", "500")) * 1024 * 1024
TILE_CACHE_MAX_AGE_DAYS = int(os.environ.get("TILE_CACHE_MAX_AGE_DAYS", "60"))

# ── Geocode proxy ──────────────────────────────────────────────────────────────

GEOCODE_CACHE_MAX = 256
GEOCODE_MIN_INTERVAL = float(os.environ.get("GEOCODE_MIN_INTERVAL", "1.0"))  # Nominatim policy: ~1 request/second

# Douglas-Peucker tolerance in degrees that Nominatim applies to a boundary
# before sending it. ~0.0001 deg is ~11 m: enough to shed surveyor-grade noise
# from a city relation without visibly moving the outline. The client can ask
# for a different value; BOUNDARY_MAX_THRESHOLD caps it.
BOUNDARY_THRESHOLD = float(os.environ.get("BOUNDARY_THRESHOLD", "0.0001"))
BOUNDARY_MAX_THRESHOLD = 0.01

# ── Upload limit ───────────────────────────────────────────────────────────────

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
