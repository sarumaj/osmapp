"""split_polygon and /split_area.

The one thing between "draw a boundary" and "download it": an area larger than
a single Overpass request is cut into pieces here, fetched piece by piece, and
put back together in the browser. What the assembly is allowed to assume is
decided in this module, and two of the assumptions fail silently when they
break.

  - **Coverage.** The tiles are the boundary. A gap between two of them is a
    street nobody downloads, on a card nobody walks - and the map looks
    complete, because the hole is the shape of a grid line.
  - **Fit.** Every tile passes the guard that refuses an oversized request. A
    tile a percent over the limit is a download that dies at the last piece,
    after the other eleven have already been paid for.

Overlap and the shape of a tile are cheaper failures - duplicate features and
a wasted request - but both are checked here too, since both are free to check
and neither is visible on screen.
"""

import math
from typing import Any, cast

import pytest
from flask import Flask
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.ops import unary_union

from osmapp import create_app
from osmapp.internal.geo import (
    approx_area_km2,
    polygon_from_request,
    split_polygon,
)
from osmapp.internal.responses import BadRequest

# Around 52°N, where a degree of longitude is ~68.5 km and one of latitude
# ~110.6 km: the latitudes this app is actually used at, and far enough from
# the equator that the two are not interchangeable.
LAT = 52.0
LNG = 21.0


def square(km2: float, lat: float = LAT, lng: float = LNG) -> Polygon:
    """A square of `km2` square kilometers, in degrees at `lat`.

    Sized rather than drawn, so a test says what it is testing: 120 is "over
    two tiles at the default limit", not a pair of coordinates the reader has
    to multiply out.
    """
    side = math.sqrt(km2)
    return box(
        lng,
        lat,
        lng + side / (111.320 * math.cos(math.radians(lat))),
        lat + side / 110.574,
    )


def polygons(tiles: list[Any]) -> list[Polygon]:
    return [tile.polygon for tile in tiles]


# ── The two assumptions the assembly rests on ────────────────────────────────


@pytest.mark.parametrize("km2", [12.0, 40.0, 120.0, 300.0])
def test_the_tiles_are_the_boundary(km2: float):
    """Their union is what was asked for, to within floating point."""
    area = square(km2)
    covered = unary_union(polygons(split_polygon(area, max_area_km2=50)))

    assert covered.difference(area).area == pytest.approx(0, abs=1e-12)
    assert area.difference(covered).area == pytest.approx(0, abs=1e-12)


@pytest.mark.parametrize("km2", [12.0, 40.0, 120.0, 300.0])
def test_every_tile_fits_in_one_request(km2: float):
    """Measured the way the download guard measures it, at each tile's own
    latitude - which is not the latitude the grid was laid out at."""
    for tile in split_polygon(square(km2), max_area_km2=50):
        assert approx_area_km2(tile.polygon) <= 50


def test_a_tall_boundary_fits_at_its_southern_edge_too():
    """The case the headroom in TILE_TARGET_RATIO exists for.

    approx_area_km2 scales by the cosine of a geometry's own mid-latitude, so a
    tile in the south of a boundary that spans several degrees measures larger
    on its own than it did as a share of the whole. Cutting to exactly the
    limit would put those tiles a few percent over it.
    """
    tall = box(21.0, 45.0, 21.5, 55.0)
    for tile in split_polygon(tall, max_area_km2=50, max_tiles=10_000):
        assert approx_area_km2(tile.polygon) <= 50


def test_the_tiles_do_not_overlap():
    """Overlap is duplicate features and duplicate Overpass traffic."""
    tiles = polygons(split_polygon(square(400), max_area_km2=50))
    for index, tile in enumerate(tiles):
        for other in tiles[index + 1 :]:
            assert tile.intersection(other).area == pytest.approx(0, abs=1e-12)


def test_a_tile_the_splitter_produced_passes_the_download_guard():
    """The contract between the two ends, exercised rather than assumed.

    The client posts these tiles back verbatim. A tile the splitter thinks is
    small enough and polygon_from_request refuses is a download that fails on
    the piece it fails on and nowhere else.
    """
    app = Flask(__name__)
    tiles = split_polygon(square(300), max_area_km2=50)
    assert len(tiles) > 1

    for tile in tiles:
        body = {"type": "Feature", "geometry": tile.polygon.__geo_interface__}
        with app.test_request_context(json=body):
            assert polygon_from_request().area == pytest.approx(tile.polygon.area)


# ── The shape of what comes back ─────────────────────────────────────────────


def test_a_small_area_is_one_undivided_tile():
    """The common case has to stay the download it always was: one request,
    over the polygon somebody drew, cut at the edges they drew."""
    area = square(25)
    tiles = split_polygon(area, max_area_km2=50)

    assert len(tiles) == 1
    assert tiles[0].divided is False
    assert tiles[0].polygon.equals(area)


def test_an_area_over_the_limit_comes_back_divided():
    """`divided` is what tells the fetch routes to keep what crosses a seam."""
    tiles = split_polygon(square(400), max_area_km2=50)

    assert len(tiles) > 1
    assert all(tile.divided for tile in tiles)


def test_detached_parts_are_split_independently():
    """A project assembled from villages is villages, not pieces of one area.

    Both parts are small enough to fetch whole, so neither is a tile of
    anything and neither should have its edges treated as a grid line.
    """
    tiles = split_polygon(
        MultiPolygon([square(20), square(10, lng=LNG + 2)]),
        max_area_km2=50,
    )

    assert len(tiles) == 2
    assert not any(tile.divided for tile in tiles)


def test_a_big_part_beside_a_small_one_divides_only_itself():
    tiles = split_polygon(
        MultiPolygon([square(20), square(400, lng=LNG + 5)]),
        max_area_km2=50,
    )

    # The small part is the one nowhere near the big one, not the one with the
    # smallest area: a corner tile of the divided part can be small too.
    small = [tile for tile in tiles if tile.polygon.bounds[2] < LNG + 1]
    assert len(small) == 1
    assert small[0].divided is False
    assert all(tile.divided for tile in tiles if tile is not small[0])


def test_a_cell_that_cuts_a_concave_boundary_in_two_yields_two_tiles():
    """One tile is one polygon.

    A U-shaped boundary meets a grid column in two separate pieces. Handing
    both back as one MultiPolygon tile would lose the smaller one:
    polygon_from_request keeps the largest part of what it is posted.
    """
    outer = square(400)
    west, south, east, north = outer.bounds
    notch = box(
        west + (east - west) * 0.3,
        south - 1,
        west + (east - west) * 0.7,
        south + (north - south) * 0.75,
    )
    u_shape = cast(Polygon, outer.difference(notch))

    tiles = split_polygon(u_shape, max_area_km2=50)

    assert all(tile.polygon.geom_type == "Polygon" for tile in tiles)
    covered = unary_union(polygons(tiles))
    assert u_shape.difference(covered).area == pytest.approx(0, abs=1e-12)


# ── What is still refused ────────────────────────────────────────────────────


def test_an_area_over_the_download_ceiling_is_refused_with_both_numbers():
    """The one case left where somebody has to draw something smaller, so the
    message has to say how much smaller."""
    with pytest.raises(BadRequest) as raised:
        _ = split_polygon(square(400), max_area_km2=50, max_tiles=4)

    message = str(raised.value)
    assert "km²" in message
    assert "200" in message  # 50 * 4, the ceiling it names


def test_a_shape_that_needs_more_tiles_than_the_budget_is_refused():
    """Area is under the ceiling; the shape is not.

    A boundary drawn as a long diagonal ribbon covers little ground and touches
    many cells, so the tile count is its own limit rather than a consequence of
    the area check.
    """
    ribbon = MultiPolygon(
        [square(4, lat=LAT + step * 0.2, lng=LNG + step * 0.4) for step in range(12)]
    )

    with pytest.raises(BadRequest):
        _ = split_polygon(ribbon, max_area_km2=50, max_tiles=6)


# ── The route ────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_the_route_hands_back_tiles_the_fetch_routes_can_read(client: Any):
    response = client.post(
        "/split_area",
        json={"type": "Feature", "geometry": square(400).__geo_interface__},
    )
    payload = cast(dict[str, Any], response.get_json())

    assert response.status_code == 200
    assert payload["count"] > 1
    assert payload["count"] == len(payload["tiles"]["features"])
    assert payload["maxAreaKm2"] > 0

    for index, feature in enumerate(payload["tiles"]["features"]):
        properties = feature["properties"]
        # The flag is what fetch_streets reads, and the client posts the
        # feature back with its properties untouched.
        assert properties["tiled"] is True
        assert properties["index"] == index
        assert properties["count"] == payload["count"]
        assert approx_area_km2(shape(feature["geometry"])) <= payload["maxAreaKm2"]


def test_the_route_leaves_a_small_area_alone(client: Any):
    response = client.post("/split_area", json=square(25).__geo_interface__)
    payload = cast(dict[str, Any], response.get_json())

    assert payload["count"] == 1
    assert payload["tiles"]["features"][0]["properties"]["tiled"] is False


def test_the_route_reports_a_body_it_cannot_use(client: Any):
    response = client.post(
        "/split_area", json={"type": "Point", "coordinates": [21, 52]}
    )

    assert response.status_code == 400
    assert "error" in cast(dict[str, Any], response.get_json())
