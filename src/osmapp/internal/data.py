"""Overpass/osmnx routes: streets and buildings."""

import json
import logging
import math
from collections.abc import Sequence
from typing import Any, cast

import osmnx as ox
from flask import Blueprint, Response

from .config import STREET_FILTER
from .geo import is_tiled_request, polygon_from_request
from .responses import BadRequest, error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("data", __name__)

# Tag columns kept from osmnx, in the order the client prefers to read them.
#
# osmnx only materializes a column when at least one element in the download
# carries that tag, so every list here is filtered against the actual frame
# before use. Anything not listed is dropped: the whole payload is round-tripped
# through localStorage by session.js and written to GeoJSON exports, so an
# unbounded tag set would be paid for on every save.
STREET_FIELDS = (
    "osmid",
    "name",
    "highway",
    "ref",
    "length",
    "lanes",
    "maxspeed",
    "oneway",
    "surface",
    "width",
    "bridge",
    "tunnel",
    "junction",
    "service",
    "access",
)

# addr:place matters as much as addr:street here: Polish villages and many
# hamlets number houses against the settlement name rather than a street, and a
# territory card for one of them is blank without it.
BUILDING_FIELDS = (
    "name",
    "building",
    "building:levels",
    "addr:street",
    "addr:place",
    "addr:housenumber",
    "addr:unit",
    "addr:postcode",
    "addr:city",
    "addr:suburb",
)


def _clean(value: Any) -> Any:
    """Normalize one osmnx cell, or return None if it carries no information.

    Three shapes need handling. Missing tags arrive as float NaN, not None.
    Merged ways arrive as lists - osmnx concatenates the tags of every OSM way
    it collapsed into a single edge - and a list is awkward for a tooltip, so
    duplicates are dropped and the rest joined. Everything else is passed
    through with its type intact, which keeps ``length`` a number.
    """
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (list, tuple, set)):
        parts: list[str] = []
        for item in cast(Sequence[Any], value):
            cleaned = _clean(item)
            if cleaned is None:
                continue
            text = str(cleaned).strip()
            if text and text not in parts:
                parts.append(text)
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else "; ".join(parts)
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return value


def _collection(gdf: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    """GeoJSON FeatureCollection with empty properties pruned.

    geopandas writes every column for every feature, so without this pass the
    majority of buildings would carry ``"addr:street": null`` and friends.
    Pruning is not cosmetic: it is what makes widening the field list above
    affordable in a payload that has to survive a localStorage quota.
    """
    columns = [c for c in fields if c in gdf.columns]
    gdf = gdf[[*columns, "geometry"]]

    data: dict[str, Any] = json.loads(gdf.to_json())  # type: ignore[reportUnknownMemberType]
    for feature in data.get("features", []):
        properties = cast(dict[str, Any], feature.get("properties") or {})
        pruned: dict[str, Any] = {}
        for key in columns:
            cleaned = _clean(properties.get(key))
            if cleaned is not None:
                pruned[key] = cleaned
        feature["properties"] = pruned
    return data


def _with_osm_id(gdf: Any) -> Any:
    """Surface the OSM element id as a plain ``osmid`` column.

    osmnx 2.x indexes feature frames by ``(element, id)``; 1.x used
    ``(element_type, osmid)``. Both are checked rather than assumed, because
    guessing wrong here silently drops the id instead of raising.
    """
    gdf = gdf.reset_index()
    for candidate in ("id", "osmid", "element_id"):
        if candidate in gdf.columns:
            if candidate != "osmid":
                gdf = gdf.rename(columns={candidate: "osmid"})
            break
    return gdf


@bp.route("/fetch_streets", methods=["POST"])
def fetch_streets() -> Response:
    """Drivable street network inside the posted polygon, as GeoJSON.

    404 when Overpass answers with nothing, which is a real answer for open
    country and not a failure. Anything else is 502 and flagged retryable: the
    client cannot tell a busy Overpass from a refusing one, and only one of the
    two is worth waiting out.

    A polygon marked as one tile of a divided download is treated differently
    in three places, and each of them is a hole in the assembled map otherwise:

    - Edges that cross the tile's edges are kept whole rather than cut, because
      a street does not stop at a grid line. The same edge comes back from the
      tile on the other side of the seam, identically, and the client drops the
      copy.
    - Every connected component is kept. osmnx otherwise returns the largest
      one, which is the right answer for a village and the wrong one for an
      arbitrary square cut out of it: the lane that leaves through the north
      edge is its own component inside the tile and a real street outside it.
    - Nothing found is 200 and an empty collection rather than 404. A tile of
      farmland is an ordinary part of a large area, and a 404 would abandon the
      whole download over it.
    """
    try:
        geom = polygon_from_request()
        tiled = is_tiled_request()
    except BadRequest as exc:
        return error_(str(exc))

    empty: dict[str, Any] = {
        "streets": {"type": "FeatureCollection", "features": []},
        "count": 0,
    }

    try:
        logger.info("Downloading streets for %.6f deg^2 (tiled=%s)", geom.area, tiled)
        graph = ox.graph_from_polygon(  # type: ignore[reportUnknownMemberType]
            geom,  # type: ignore[reportArgumentType]
            network_type="drive",
            custom_filter=STREET_FILTER,
            truncate_by_edge=tiled,
            retain_all=tiled,
        )
        _, edges = ox.graph_to_gdfs(graph)  # type: ignore[reportUnknownMemberType]

        streets = _collection(edges, STREET_FIELDS)
        logger.info("Got %d street segments", len(edges))

        return json_({"streets": streets, "count": len(edges)})
    except ox._errors.InsufficientResponseError:  # type: ignore[attr-defined]
        if tiled:
            return json_(empty)
        return error_("No streets found in that area.", 404)
    except Exception:
        logger.exception("fetch_streets failed")
        return error_(
            "Could not download streets. Overpass may be busy.", 502, retryable=True
        )


@bp.route("/fetch_buildings", methods=["POST"])
def fetch_buildings() -> Response:
    """Building footprints inside the posted polygon, as GeoJSON.

    An area with no buildings returns an empty collection with 200 rather than
    404: unlike streets, that is the expected result for farmland the boundary
    happens to include, and the client draws the rest of the map from it.

    Nothing here has to know about tiles. osmnx returns every footprint that
    intersects the polygon rather than clipping at it, so a building on a seam
    arrives whole from both tiles that touch it and the client drops the copy
    by OSM id.
    """
    try:
        geom = polygon_from_request()
    except BadRequest as exc:
        return error_(str(exc))

    empty: dict[str, Any] = {
        "buildings": {"type": "FeatureCollection", "features": []},
        "count": 0,
        "bounds": {
            "west": geom.bounds[0],
            "south": geom.bounds[1],
            "east": geom.bounds[2],
            "north": geom.bounds[3],
        },
    }

    try:
        logger.info("Downloading buildings")
        buildings = ox.features.features_from_polygon(
            geom,  # type: ignore[reportArgumentType]
            tags={"building": True},
        )
        buildings = _with_osm_id(buildings)
        buildings = buildings[
            buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])  # type: ignore[reportUnknownMemberType]
        ]
        collection = _collection(buildings, ("osmid", *BUILDING_FIELDS))
        logger.info("Got %d buildings", len(buildings))

        return json_(
            {
                "buildings": collection,
                "count": len(buildings),
                "bounds": {
                    "west": geom.bounds[0],
                    "south": geom.bounds[1],
                    "east": geom.bounds[2],
                    "north": geom.bounds[3],
                },
            }
        )

    except ox._errors.InsufficientResponseError:  # type: ignore[attr-defined]
        return json_(empty)
    except Exception:
        logger.exception("fetch_buildings failed")
        return error_(
            "Could not download buildings. Overpass may be busy.", 502, retryable=True
        )
