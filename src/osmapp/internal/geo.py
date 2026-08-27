"""GeoJSON polygon parsing, normalization, the area guard and the area split."""

import math
from typing import NamedTuple, cast

from flask import request
from shapely.geometry import MultiPolygon, Polygon, box, shape
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from .config import MAX_AREA_KM2, MAX_TILES
from .responses import BadRequest

# Tiles are cut to a fraction of the limit rather than to the limit itself.
#
# approx_area_km2 scales a polygon at its own mid-latitude, so the number the
# splitter computes for a tile and the number the guard computes for that same
# tile are taken at different latitudes: a tile in the south of a tall boundary
# measures larger on its own than it did as a share of the whole. The headroom
# absorbs that difference, and _tiles_for re-measures every piece anyway, so a
# tile that still comes out over the limit is divided again rather than sent.
TILE_TARGET_RATIO = 0.9

# Pieces smaller than this are dropped rather than downloaded. They are the
# slivers a grid line leaves when it grazes the boundary - a strip a few metres
# wide along an edge, whose contents the tile beside it already returns, since
# both fetch routes keep what crosses a tile edge rather than cutting at it. A
# request for one costs an Overpass round trip and returns nothing new.
MIN_TILE_KM2 = 1e-4  # 100 m^2

# A piece this much smaller than a tile is folded into the tile beside it
# rather than fetched on its own. A grid line that clips the corner of a
# boundary leaves a scrap a few hundred metres across, and a scrap costs
# exactly what a full tile costs: two Overpass round trips, and a retry ladder
# behind each of them if the service is busy. Folding it into a neighbor
# spends a fraction of that neighbor's budget instead.
SLIVER_RATIO = 0.1

# _tiles_for divides again when a piece is still over the limit after a pass,
# which only happens to a piece whose own latitude works out worse than the
# grid assumed. Each pass at least halves the longer side, so this is a
# backstop against a pathological geometry rather than a working limit.
MAX_SPLIT_DEPTH = 6

# Ceiling on the cells one grid pass may lay out. The total-area check in
# split_polygon already bounds a compact boundary; this bounds the other case,
# a long diagonal sliver whose bounding box is far larger than the boundary
# inside it and whose grid would be mostly empty cells.
MAX_GRID_CELLS = 4096

# Degrees to kilometers, at the equator for longitude.
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LNG = 111.320


class Tile(NamedTuple):
    """One area to download, and whether it is a piece of a larger one.

    ``divided`` is not decoration: it decides how the fetch routes treat the
    tile's edges. An area somebody drew is cut at its edges, because that is
    the boundary they asked for. A piece this module cut out of one is not -
    cutting there would leave a hole in the middle of the project at every
    seam. A boundary that was small enough to download whole therefore comes
    back as a single tile with ``divided`` False, and the download it produces
    is byte-for-byte the one it produced before this module existed.
    """

    polygon: Polygon
    divided: bool


def polygon_from_request() -> Polygon:
    """Parse and validate the GeoJSON polygon in the request body.

    Accepts both ``{"type": "Feature", "geometry": {...}}`` and a bare geometry
    so endpoints are usable by hand.

    A MultiPolygon collapses to its largest part, which is what the fetch
    routes want: they take one area per request, and the client posts the parts
    of a boundary - and the tiles of a part - one at a time.
    """
    geom = geometry_from_request()
    polygon = _largest(geom)
    _check_area(polygon)
    return polygon


def geometry_from_request() -> Polygon | MultiPolygon:
    """The posted geometry with every part kept, and no area guard.

    What /split_area needs: it is handed the whole boundary - detached parts
    and all - and its answer is the list of areas small enough to download, so
    collapsing it or refusing it here would defeat the point.
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

    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise BadRequest(f"Expected a Polygon, got {geom.geom_type}.")

    if not geom.is_valid:
        geom = _repair(geom)

    if geom.is_empty:  # type: ignore[reportUnknownMemberType]
        raise BadRequest("That polygon is empty.")

    return cast(Polygon | MultiPolygon, geom)


def is_tiled_request() -> bool:
    """True when the posted polygon is one tile of a divided download.

    A tile is not an area somebody drew: it has three or four edges the
    boundary does not have, and what crosses them belongs to the project as
    much as what sits in the middle does. The fetch routes read this to keep
    what crosses a tile edge instead of cutting at it - see fetch_streets,
    where cutting would leave a hole at every seam.

    Accepted both at the top level of the body and inside a Feature's
    ``properties``, because the tiles /split_area hands out carry it in their
    properties and the client posts them back verbatim.
    """
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return False
    if payload.get("tiled"):  # type: ignore[reportUnknownMemberType]
        return True
    properties = payload.get("properties")  # type: ignore[reportUnknownMemberType]
    return bool(isinstance(properties, dict) and properties.get("tiled"))  # type: ignore[reportUnknownMemberType]


def approx_area_km2(geom: BaseGeometry) -> float:
    """Planar area of a lat/lng geometry, scaled at its mid-latitude.

    Good to a percent or so at the scale this app works at, and cheap. The
    boundary suggestion endpoint and the splitter use it too, so what the
    dialog shows, what the split aims at and what the download guard enforces
    are the same number.
    """
    min_lat, max_lat = geom.bounds[1], geom.bounds[3]
    mid_lat = (min_lat + max_lat) / 2
    km_per_deg_lng = KM_PER_DEG_LNG * math.cos(math.radians(mid_lat))
    return geom.area * KM_PER_DEG_LAT * km_per_deg_lng


def split_polygon(
    geom: BaseGeometry,
    max_area_km2: float | None = None,
    max_tiles: int | None = None,
) -> list[Tile]:
    """Divide a boundary into areas small enough to download one at a time.

    This is the answer to a boundary over the limit. Refusing one used to be
    the whole of it - "draw a smaller polygon" - which is a fair thing to say
    about a careless drag and an unhelpful thing to say about a town. The area
    is cut into a grid instead, each cell is clipped to the boundary, and the
    client fetches the pieces in turn and assembles them.

    The grid is a first cut rather than the answer: the scraps it leaves where
    a cell catches the corner of an outline are folded back into the tiles
    beside them, since a scrap costs a full download and carries almost
    nothing. See _merge_slivers.

    Two properties matter to the caller, and both are why cells are clipped
    rather than sent as squares:

    - The tiles cover the boundary exactly. Their union is the boundary, so
      nothing inside it goes unfetched and no request reaches for ground
      outside it that nobody asked for.
    - The tiles do not overlap. What comes back twice is limited to what the
      fetch routes deliberately return on both sides of a seam, which the
      client drops by feature identity.

    Args:
        geom: The boundary, as a Polygon or MultiPolygon. Detached parts are
            divided independently and share one tile budget.
        max_area_km2: Largest area one tile may cover. Defaults to the download
            guard's own limit, which is the only value that makes the tiles
            fetchable.
        max_tiles: Ceiling on the number of tiles. Defaults to MAX_TILES.

    Returns:
        Tiles, in the order they should be fetched. A part already under the
        limit comes back as a single tile - itself, marked undivided - so a
        caller never has to special-case the small case.

    Raises:
        BadRequest: The area is over the download ceiling, or would need more
            tiles than the budget allows. Both messages name the numbers, since
            the only useful thing to do about either is to draw less.
    """
    max_area_km2 = MAX_AREA_KM2 if max_area_km2 is None else max_area_km2
    max_tiles = MAX_TILES if max_tiles is None else max_tiles

    total_km2 = approx_area_km2(geom)
    ceiling_km2 = max_area_km2 * max_tiles
    if total_km2 > ceiling_km2:
        raise BadRequest(
            f"That area is about {total_km2:,.0f} km², over the "
            f"{ceiling_km2:,.0f} km² this server will download. "
            "Draw a smaller boundary."
        )

    tiles: list[Tile] = []
    for part in _parts(geom):
        # Divided is decided per part, not per boundary: a project assembled
        # from three villages, each of them small enough, is three whole areas
        # rather than three pieces of one.
        pieces = _merge_slivers(_tiles_for(part, max_area_km2, 0), max_area_km2)
        tiles.extend(Tile(piece, len(pieces) > 1) for piece in pieces)

    if not tiles:
        raise BadRequest("That polygon is empty.")

    # Reachable when the area is under the ceiling but the shape is not: a
    # boundary that snakes across a county picks up a tile per bend.
    if len(tiles) > max_tiles:
        raise BadRequest(
            f"That area would take {len(tiles)} downloads, over the "
            f"{max_tiles} this server allows. Draw a smaller boundary."
        )

    return tiles


def _tiles_for(polygon: Polygon, max_area_km2: float, depth: int) -> list[Polygon]:
    """One part of a boundary as tiles, divided again where a piece is still big."""
    if approx_area_km2(polygon) <= max_area_km2:
        return [polygon]

    if depth >= MAX_SPLIT_DEPTH:
        raise BadRequest("That area could not be divided into downloadable parts.")

    west, south, east, north = polygon.bounds
    cols, rows = _grid_shape(polygon, max_area_km2)
    dx = (east - west) / cols
    dy = (north - south) / rows

    tiles: list[Polygon] = []
    for col in range(cols):
        for row in range(rows):
            # The last column and row take the bounds themselves rather than a
            # multiple of the step: the float error accumulated over cols steps
            # is enough to leave a hairline of the boundary in no tile at all.
            cell = box(
                west + col * dx,
                south + row * dy,
                east if col == cols - 1 else west + (col + 1) * dx,
                north if row == rows - 1 else south + (row + 1) * dy,
            )
            piece = polygon.intersection(cell)
            if piece.is_empty:
                continue
            for part in _parts(piece):
                # A cell that clips a concave boundary into several pieces
                # yields one tile per piece rather than one multi-part tile:
                # a tile is downloaded as one polygon, and polygon_from_request
                # keeps only the largest part of what it is posted.
                if approx_area_km2(part) < MIN_TILE_KM2:
                    continue
                tiles.extend(_tiles_for(part, max_area_km2, depth + 1))

    return tiles


def _merge_slivers(pieces: list[Polygon], max_area_km2: float) -> list[Polygon]:
    """Fold the scraps a grid line leaves into the tile they lie against.

    Cutting a boundary along straight lines leaves pieces that have nothing to
    do with how big a download should be: a cell that catches the corner of an
    outline comes away with a few hundred metres of field. As a tile it costs
    what any tile costs - two Overpass round trips, and a retry ladder behind
    each if the service is busy - to return a street network that is usually
    empty and a handful of buildings its neighbor would have returned anyway.

    Folding is refused where it would break what a tile is:

    - the union has to be a single polygon, so two scraps meeting a neighbor
      at one corner stay where they are rather than becoming a shape the fetch
      routes would take the largest half of;
    - it has to stay under the limit, since a merged tile is downloaded like
      any other and is measured by the same guard.

    Coverage and non-overlap survive by construction: this only ever replaces
    two disjoint pieces with the one polygon they make together.
    """
    tiles = list(pieces)
    threshold = max_area_km2 * SLIVER_RATIO

    folded = True
    while folded:
        folded = False
        for index, tile in enumerate(tiles):
            if approx_area_km2(tile) >= threshold:
                continue
            target = _fold_into(tiles, index, max_area_km2)
            if target is None:
                continue
            neighbor, union = target
            tiles[neighbor] = union
            del tiles[index]
            # The indices have shifted and the merged tile is a different
            # shape, so the scan starts again rather than carrying on with a
            # stale list. There are a handful of slivers at most.
            folded = True
            break

    return tiles


def _fold_into(
    tiles: list[Polygon], index: int, max_area_km2: float
) -> tuple[int, Polygon] | None:
    """The tile a sliver should join, and what the two of them make.

    The neighbor sharing the longest edge with it, which is what keeps a
    merged tile compact: joining along a hairline touch would produce a tile
    shaped like two rooms and a corridor, and an Overpass query pays for the
    ground between.
    """
    sliver = tiles[index]
    best: tuple[int, Polygon] | None = None
    best_edge = 0.0

    for other, candidate in enumerate(tiles):
        if other == index or not sliver.intersects(candidate):
            continue

        # Zero for a corner touch, which is not an edge to join along.
        shared = sliver.intersection(candidate).length
        if shared <= best_edge:
            continue

        union = unary_union([sliver, candidate])
        if union.geom_type != "Polygon" or not union.is_valid:
            continue
        if approx_area_km2(union) > max_area_km2:
            continue

        best = (other, cast(Polygon, union))
        best_edge = shared

    return best


def _grid_shape(polygon: Polygon, max_area_km2: float) -> tuple[int, int]:
    """Columns and rows for one pass over a part's bounding box.

    Cells come out as square as the box allows and no larger than the target,
    which is what keeps an Overpass query compact: a long thin request costs
    about what the square one covering it costs and returns less.
    """
    west, south, east, north = polygon.bounds
    mid_lat = (south + north) / 2

    width_km = (east - west) * KM_PER_DEG_LNG * math.cos(math.radians(mid_lat))
    height_km = (north - south) * KM_PER_DEG_LAT
    side_km = math.sqrt(max_area_km2 * TILE_TARGET_RATIO)

    cols = max(1, math.ceil(width_km / side_km))
    rows = max(1, math.ceil(height_km / side_km))

    if cols * rows > MAX_GRID_CELLS:
        raise BadRequest(
            "That boundary is spread over too wide an area to divide. "
            "Draw it in smaller pieces."
        )

    return cols, rows


def _parts(geom: BaseGeometry) -> list[Polygon]:
    """Every polygon in a geometry, flattened.

    Anything that is not a polygon is dropped rather than raised over: an
    intersection that grazes an edge hands back a line or a point beside the
    polygons, and neither is an area to download.
    """
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [cast(Polygon, geom)]
    parts: list[Polygon] = []
    for sub in getattr(geom, "geoms", ()):  # type: ignore[reportUnknownVariableType]
        parts.extend(_parts(cast(BaseGeometry, sub)))
    return parts


def _largest(geom: BaseGeometry) -> Polygon:
    """The biggest polygon in a geometry."""
    parts = _parts(geom)
    if not parts:
        raise BadRequest("That polygon is empty.")
    return max(parts, key=lambda part: part.area)


def _repair(geom: BaseGeometry) -> BaseGeometry:
    """buffer(0) over an invalid geometry, keeping the polygonal result.

    buffer(0) can hand back a MultiPolygon or a GeometryCollection, so the type
    has to be re-established rather than assumed.
    """
    parts = _parts(geom.buffer(0))
    if not parts:
        raise BadRequest("That polygon could not be repaired.")
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def _check_area(geom: Polygon):
    """Reject a single request large enough to hang Overpass.

    Not a ceiling on a project any more: a boundary over the limit is divided
    by /split_area and arrives here one tile at a time. What is left is the
    guard on a single round trip, which is also what answers a polygon posted
    to these routes by hand.
    """
    area_km2 = approx_area_km2(geom)

    if area_km2 > MAX_AREA_KM2:
        raise BadRequest(
            f"That area is about {area_km2:,.0f} km², over the "
            f"{MAX_AREA_KM2:,.0f} km² one request may cover. "
            "Divide it with /split_area and post the tiles."
        )
