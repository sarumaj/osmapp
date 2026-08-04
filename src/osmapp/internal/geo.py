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
    if not isinstance(payload, dict) or not payload:
        raise BadRequest("Send a GeoJSON polygon in the request body.")

    raw = payload.get("geometry", payload)  # type: ignore[reportUnknownMemberType]
    if not isinstance(raw, dict) or "type" not in raw:
        raise BadRequest("The request body has no GeoJSON geometry.")

    try:
        geom: BaseGeometry = shape(raw)  # type: ignore[reportUnknownArgumentType]
    except Exception as exc:
        raise BadRequest("That geometry could not be parsed.") from exc

    if geom.geom_type == "MultiPolygon":
        geom = cast(Polygon, max(geom.geoms, key=lambda p: p.area))  # type: ignore[attr-defined]

    if geom.geom_type != "Polygon":
        raise BadRequest(f"Expected a Polygon, got {geom.geom_type}.")

    if not geom.is_valid:
        geom = geom.buffer(0)
        # buffer(0) can hand back a MultiPolygon or GeometryCollection, so the
        # type has to be re-established rather than assumed.
        if geom.geom_type == "MultiPolygon":
            geom = max(geom.geoms, key=lambda p: p.area)  # type: ignore[reportUnknownMemberType]
        elif geom.geom_type == "GeometryCollection":
            polys = [g for g in geom.geoms if g.geom_type == "Polygon"]  # type: ignore[reportUnknownMemberType]
            if not polys:
                raise BadRequest("That polygon could not be repaired.")
            geom = max(polys, key=lambda p: p.area)  # type: ignore[reportUnknownMemberType]
    if geom.is_empty:  # type: ignore[reportUnknownMemberType]
        raise BadRequest("That polygon is empty.")

    _check_area(cast(Polygon, geom))
    return cast(Polygon, geom)


def approx_area_km2(geom: BaseGeometry) -> float:
    """Planar area of a lat/lng geometry, scaled at its mid-latitude.

    Good to a percent or so at the scale this app works at, and cheap. The
    boundary suggestion endpoint uses it too, so what the dialog shows and what
    the download guard enforces are the same number.
    """
    min_lat, max_lat = geom.bounds[1], geom.bounds[3]
    mid_lat = (min_lat + max_lat) / 2
    km_per_deg_lat = 110.574
    km_per_deg_lng = 111.320 * math.cos(math.radians(mid_lat))
    return geom.area * km_per_deg_lat * km_per_deg_lng


def _check_area(geom: Polygon) -> None:
    """Reject polygons large enough to hang Overpass."""
    area_km2 = approx_area_km2(geom)

    if area_km2 > MAX_AREA_KM2:
        raise BadRequest(
            f"That area is about {area_km2:,.0f} km², over the "
            f"{MAX_AREA_KM2:,.0f} km² limit. Draw a smaller polygon."
        )
