"""Area routes: dividing a boundary into downloadable tiles.

Geometry only. Nothing here reaches Overpass, which is why it is not part of
data.py and why it carries a rate limit of its own: a client calls this once
per download, before the two Overpass round trips per tile that follow it.
"""

import logging
from typing import Any

from flask import Blueprint, Response
from shapely.geometry import mapping

from .config import MAX_AREA_KM2, MAX_TILES
from .geo import approx_area_km2, geometry_from_request, split_polygon
from .responses import BadRequest, error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("areas", __name__)


@bp.route("/split_area", methods=["POST"])
def split_area() -> Response:
    """The posted boundary as the list of areas to download, in fetch order.

    The client posts the whole boundary - every detached part of it - and gets
    back tiles that each fit inside MAX_AREA_KM2, tagged so the fetch routes
    know they are looking at one piece of something larger. A boundary already
    under the limit comes back as one tile holding the boundary itself, so the
    client runs the same loop either way.

    The split is done here rather than in the browser for one reason: the area
    the tiles have to fit under is measured by this server's own arithmetic,
    and a client that measured it differently - turf's geodesic area against
    approx_area_km2' planar one - would hand back tiles this server then
    refuses.

    400 with a message naming the numbers when the area is over what the server
    will download at all. That is the one case left where somebody has to draw
    something smaller.
    """
    try:
        geom = geometry_from_request()
        tiles = split_polygon(geom)
    except BadRequest as exc:
        return error_(str(exc))

    total_km2 = approx_area_km2(geom)
    logger.info("Split %.1f km² into %d tiles", total_km2, len(tiles))

    features: list[dict[str, Any]] = [
        {
            "type": "Feature",
            "geometry": mapping(tile.polygon),
            "properties": {
                # Posted back verbatim, and read by both fetch routes: see
                # geo.is_tiled_request. False for an area that was under the
                # limit to begin with, whose edges are the ones somebody drew.
                "tiled": tile.divided,
                "index": index,
                "count": len(tiles),
                "areaKm2": round(approx_area_km2(tile.polygon), 3),
            },
        }
        for index, tile in enumerate(tiles)
    ]

    return json_(
        {
            "tiles": {"type": "FeatureCollection", "features": features},
            "count": len(features),
            "areaKm2": round(total_km2, 3),
            "maxAreaKm2": MAX_AREA_KM2,
            "maxTiles": MAX_TILES,
        }
    )
