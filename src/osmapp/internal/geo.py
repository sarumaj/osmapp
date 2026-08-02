"""GeoJSON polygon parsing, normalization and area guard."""

import math
from typing import cast

from flask import request
from shapely.geometry import Polygon, shape
from shapely.geometry.base import BaseGeometry

from .config import MAX_AREA_KM2
from .responses import BadRequest


def polygon_from_request() -> Polygon:
    """Parse and validate the GeoJSON polygon in the request body.

    Accepts both ``{"type": "Feature", "geometry": {...}}`` and a bare geometry
    so endpoints are usable by hand.
    """
    payload = request.get_json(silent=True)
    if not payload:
        raise BadRequest("Send a GeoJSON polygon in the request body.")

    raw = payload.get("geometry", payload)
    if not isinstance(raw, dict) or "type" not in raw:
        raise BadRequest("The request body has no GeoJSON geometry.")

    try:
        geom: BaseGeometry = shape(raw)  # type: ignore[reportUnknownArgumentType]
    except Exception as exc:  # noqa: BLE001
        raise BadRequest("That geometry could not be parsed.") from exc

    if geom.geom_type == "MultiPolygon":
        geom = cast(Polygon, max(geom.geoms, key=lambda p: p.area))  # type: ignore[attr-defined]

    if geom.geom_type != "Polygon":
        raise BadRequest(f"Expected a Polygon, got {geom.geom_type}.")

    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.is_empty:
        raise BadRequest("That polygon is empty.")

    _check_area(cast(Polygon, geom))
    return cast(Polygon, geom)


def _check_area(geom: Polygon) -> None:
    """Reject polygons large enough to hang Overpass."""
    min_lat, max_lat = geom.bounds[1], geom.bounds[3]
    mid_lat = (min_lat + max_lat) / 2
    km_per_deg_lat = 110.574
    km_per_deg_lng = 111.320 * math.cos(math.radians(mid_lat))
    area_km2 = geom.area * km_per_deg_lat * km_per_deg_lng

    if area_km2 > MAX_AREA_KM2:
        raise BadRequest(
            f"That area is about {area_km2:,.0f} km², over the "
            f"{MAX_AREA_KM2:,.0f} km² limit. Draw a smaller polygon."
        )
