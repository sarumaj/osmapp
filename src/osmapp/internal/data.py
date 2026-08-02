"""Overpass/osmnx routes: streets and buildings."""

import json
import logging
from typing import Any

import osmnx as ox
from flask import Blueprint

from .config import STREET_FILTER
from .geo import polygon_from_request
from .responses import BadRequest, error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("data", __name__)


@bp.route("/fetch_streets", methods=["POST"])
def fetch_streets():
    try:
        geom = polygon_from_request()
    except BadRequest as exc:
        return error_(str(exc))

    try:
        logger.info("Downloading streets for %.6f deg^2", geom.area)
        graph = ox.graph_from_polygon(  # type: ignore[reportUnknownMemberType]
            geom,  # type: ignore[reportArgumentType]
            network_type="drive",
            custom_filter=STREET_FILTER,
        )
        _, edges = ox.graph_to_gdfs(graph)  # type: ignore[reportUnknownMemberType]

        wanted = ["name", "highway", "length", "geometry"]
        edges = edges[[c for c in wanted if c in edges.columns]]
        streets = json.loads(edges.to_json())  # type: ignore[reportUnknownMemberType]
        logger.info("Got %d street segments", len(edges))

        return json_({"streets": streets, "count": len(edges)})
    except ox._errors.InsufficientResponseError:  # type: ignore[attr-defined]
        return error_("No streets found in that area.", 404)
    except Exception:
        logger.exception("fetch_streets failed")
        return error_("Could not download streets. Overpass may be busy.", 502)


@bp.route("/fetch_buildings", methods=["POST"])
def fetch_buildings():
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
        buildings = buildings.reset_index(drop=True)
        buildings = buildings[
            buildings.geometry.geom_type.isin(["Polygon", "MultiPolygon"])  # type: ignore[reportUnknownMemberType]
        ]
        wanted = [c for c in ("name", "building", "geometry") if c in buildings.columns]
        buildings = buildings[wanted]
        logger.info("Got %d buildings", len(buildings))

        return json_(
            {
                "buildings": json.loads(buildings.to_json()),  # type: ignore[reportUnknownMemberType]
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
        return error_("Could not download buildings. Overpass may be busy.", 502)
