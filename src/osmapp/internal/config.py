"""Environment-driven configuration constants."""

import os
import re
from pathlib import Path
from typing import TypedDict

# Paths

SCRIPT_DIR = Path(__file__).resolve().parent.parent  # the osmapp package
TEMPLATE_DIR = SCRIPT_DIR / "templates"
STATIC_DIR = SCRIPT_DIR / "static"
I18N_DIR = STATIC_DIR / "lang"
# static/fonts holds DejaVuSans, which nothing here opens: the browser fetches
# it as an ordinary static asset and embeds it into the card itself. No
# constant points at it, and pwa.py precaches the directory by name.

# Overpass / Nominatim

OVERPASS_URL = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api")
OVERPASS_TIMEOUT = int(os.environ.get("OVERPASS_TIMEOUT", "180"))  # seconds
NOMINATIM_URL = os.environ.get(
    "NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"
)
# /lookup resolves an osm_type + osm_id straight to one object, which is how the
# outer-boundary suggestion gets a polygon without asking /search for geometry on
# every keystroke. Derived from NOMINATIM_URL so a self-hosted instance only has
# to be configured once.
NOMINATIM_LOOKUP_URL = os.environ.get("NOMINATIM_LOOKUP_URL", "") or re.sub(
    r"/search/?$", "/lookup", NOMINATIM_URL
)

# Derived the same way, and for the same reason: a self-hosted Nominatim only
# has to set NOMINATIM_URL for all three endpoints to follow it.
NOMINATIM_REVERSE_URL = os.environ.get("NOMINATIM_REVERSE_URL", "") or re.sub(
    r"/search/?$", "/reverse", NOMINATIM_URL
)

# The largest polygon one Overpass round trip is allowed to cover. It is not a
# ceiling on what can be downloaded: an area above it is divided into tiles of
# at most this size and fetched one tile at a time (see geo.split_polygon), so
# the number below is the size of a request rather than the size of a project.
# Keep it small enough that a single tile finishes inside OVERPASS_TIMEOUT.
MAX_AREA_KM2 = float(os.environ.get("OSM_MAX_AREA_KM2", "50"))

# How many tiles one download may be divided into, and with it the real ceiling
# on a project: MAX_AREA_KM2 * MAX_TILES km². The cap exists because the split
# turns one refusal into a queue of requests, and a careless drag across half a
# country would otherwise become an afternoon of Overpass traffic nobody asked
# for. 24 tiles at the default size is ~1200 km² - larger than any city this
# app is used on, and still a bounded amount of work.
MAX_TILES = int(os.environ.get("OSM_MAX_TILES", "24"))

# Overpass tag filter for the street download: the road classes a territory
# boundary is routed along. Service roads, tracks and footpaths are left out,
# so a boundary follows a way that can be named on a card.
STREET_FILTER = (
    '["highway"~"^(motorway|trunk|primary|secondary|tertiary|'
    'residential|unclassified)$"]'
)

# Tile proxy

TILE_URL_TEMPLATE = os.environ.get(
    "TILE_URL", "https://tile.openstreetmap.de/{z}/{x}/{y}.png"
)
TILE_CACHE_DIR = Path(os.environ.get("TILE_CACHE_DIR", ".tile_cache"))
TILE_CACHE_MAX_BYTES = int(os.environ.get("TILE_CACHE_MAX_MB", "500")) * 1024 * 1024
TILE_CACHE_MAX_AGE_DAYS = int(os.environ.get("TILE_CACHE_MAX_AGE_DAYS", "60"))
TILE_MAX_ZOOM = 19

# Aid basemaps
#
# TILE_URL above is the *printable* basemap. It is the only one print.js ever
# composes a territory card from, and that is a deliberate constraint rather
# than an oversight: a card is walked with, annotated and handed on, and an
# aerial photograph neither names a street nor shows a house number. Everything
# below is an on-screen aid - imagery for "which of these two doors is the
# front one", terrain for reading a slope before assigning it - served through
# the same proxy so it is same-origin and cached, and never reachable from the
# print pipeline.
#
# Set any URL to an empty string to drop that layer from the switcher entirely.
# The key order here is the order they appear in the layer control.


class AidLayer(TypedDict):
    """One optional, non-printable basemap.

    camelCase because this dict is serialized straight into the page for
    App.basemap to consume; renaming on the way out would only add a mapping
    nobody would remember to update.
    """

    id: str
    labelKey: str  # i18n key, so the switcher entry follows the UI language
    url: str  # {z}/{x}/{y} placeholders, in whatever order the provider wants
    maxZoom: int  # deepest zoom the provider actually publishes
    attribution: str


def _aid_layer(
    layer_id: str,
    env: str,
    default_url: str,
    default_max_zoom: int,
    default_attribution: str,
) -> AidLayer:
    return AidLayer(
        id=layer_id,
        labelKey=f"layers.{layer_id}",
        url=os.environ.get(f"{env}_TILE_URL", default_url),
        maxZoom=int(os.environ.get(f"{env}_MAX_ZOOM", str(default_max_zoom))),
        attribution=os.environ.get(f"{env}_ATTRIBUTION", default_attribution),
    )


AID_LAYERS: dict[str, AidLayer] = {
    layer["id"]: layer
    for layer in (
        _aid_layer(
            "imagery",
            "IMAGERY",
            # Esri's World Imagery serves {z}/{y}/{x} - note the order, which
            # is why the templates are formatted by keyword and not by position.
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            19,
            "Imagery © Esri, Maxar, Earthstar Geographics",
        ),
        _aid_layer(
            "terrain",
            "TERRAIN",
            "https://tile.opentopomap.org/{z}/{x}/{y}.png",
            17,
            "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors",
        ),
    )
    if layer["url"]
}

# Geocode proxy

GEOCODE_CACHE_MAX = 256
GEOCODE_MIN_INTERVAL = float(
    os.environ.get("GEOCODE_MIN_INTERVAL", "1.0")
)  # Nominatim policy: ~1 request/second

# Douglas-Peucker tolerance in degrees that Nominatim applies to a boundary
# before sending it. ~0.0001 deg is ~11 m: enough to shed surveyor-grade noise
# from a city relation without visibly moving the outline. The client can ask
# for a different value; BOUNDARY_MAX_THRESHOLD caps it.
BOUNDARY_THRESHOLD = float(os.environ.get("BOUNDARY_THRESHOLD", "0.0001"))
BOUNDARY_MAX_THRESHOLD = 0.01

# Request body limit
#
# The only bodies the app accepts are the GeoJSON polygons the fetch routes
# take; template PDFs are composed in the browser and never cross the wire.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
