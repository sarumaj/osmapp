"""_clean and prune_tiles.

`_clean` shapes every property in every payload, and it fails silently: a
mishandled NaN becomes the string "nan" in an export, a mishandled list drops a
street name. `prune_tiles` deletes files, so a bug there deletes the wrong ones.
"""

import os
import time
from pathlib import Path
from typing import Any

import pytest
from flask import Flask

from osmapp.internal import tiles as tiles_module
from osmapp.internal.data import _clean as clean  # type: ignore[reportPrivateUsage]
from osmapp.internal.tiles import (
    _mimetype as mimetype,  # type: ignore[reportPrivateUsage]
)
from osmapp.internal.tiles import (
    _tile_root as tile_root,  # type: ignore[reportPrivateUsage]
)
from osmapp.internal.tiles import (
    client_basemaps,
    prune_tiles,
)


def test_nan_becomes_none():
    """osmnx uses NaN for a tag the element does not carry."""
    assert clean(float("nan")) is None


def test_blank_becomes_none():
    assert clean("") is None
    assert clean("   ") is None
    assert clean([]) is None
    assert clean([float("nan"), None, "  "]) is None


def test_a_string_is_trimmed():
    assert clean("  Rynek Główny  ") == "Rynek Główny"


def test_numbers_keep_their_type():
    # `length` is formatted as a distance client-side.
    assert clean(123.45) == 123.45


def test_a_merged_way_joins_its_parts():
    """osmnx concatenates the tags of every way it collapsed into one edge."""
    assert clean(["Rynek", "Grodzka"]) == "Rynek; Grodzka"


def test_duplicates_and_nan_are_dropped_from_a_list():
    assert clean(["Rynek", "Rynek", float("nan")]) == "Rynek"


def test_a_single_item_list_collapses_to_a_scalar():
    assert clean(["Rynek"]) == "Rynek"


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "tiles"
    monkeypatch.setattr(tiles_module, "TILE_CACHE_DIR", root)
    root.mkdir(parents=True)
    return root


def write_tile(
    root: Path,
    y: int,
    size: int = 100,
    age_days: int = 0,
    layer: str | None = None,
) -> Path:
    """`layer` names a cache subtree; the default is the printable basemap."""
    path = root / (layer or tile_root().name) / "10" / "1" / f"{y}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    if age_days:
        old = time.time() - age_days * 86400
        os.utime(path, (old, old))
    return path


def test_expired_tiles_are_removed(cache_dir: Path):
    stale = write_tile(cache_dir, 1, age_days=90)
    fresh = write_tile(cache_dir, 2)

    removed, freed = prune_tiles(max_bytes=10_000_000, max_age_days=60)
    assert (removed, freed) == (1, 100)
    assert not stale.exists()
    assert fresh.exists()


def test_the_byte_budget_evicts_oldest_first(cache_dir: Path):
    oldest = write_tile(cache_dir, 1, age_days=5)
    middle = write_tile(cache_dir, 2, age_days=3)
    newest = write_tile(cache_dir, 3, age_days=1)

    removed, _ = prune_tiles(max_bytes=100, max_age_days=365)
    assert removed == 2
    assert not oldest.exists() and not middle.exists()
    assert newest.exists()


def test_nothing_is_removed_when_under_budget(cache_dir: Path):
    write_tile(cache_dir, 1)
    assert prune_tiles(max_bytes=10_000, max_age_days=365) == (0, 0)


def test_non_tiles_are_left_alone(cache_dir: Path):
    """The cache directory is user-configurable and may not be exclusive."""
    stray = cache_dir / "README.txt"
    stray.write_text("not a tile")

    prune_tiles(max_bytes=0, max_age_days=0)
    assert stray.exists()


def test_pruning_a_missing_directory_is_a_no_op(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(tiles_module, "TILE_CACHE_DIR", tmp_path / "absent")
    assert prune_tiles(max_bytes=1000, max_age_days=1) == (0, 0)


def test_aid_tiles_are_evicted_before_the_printable_basemap(cache_dir: Path):
    """The whole reason the two share a directory but not a standing.

    Aid layers are a look-and-switch-back tool. An afternoon spent panning
    around satellite imagery must not evict the OSM tiles behind the territory
    someone is about to print fifty cards from — and under a plain oldest-first
    policy it would, because the imagery is the newer traffic.
    """
    old_basemap = write_tile(cache_dir, 1, age_days=30)
    new_aid = write_tile(cache_dir, 1, age_days=0, layer="aid-layer-digest")

    removed, _ = prune_tiles(max_bytes=100, max_age_days=365)

    assert removed == 1
    assert old_basemap.exists(), "the printable basemap must be evicted last"
    assert not new_aid.exists()


# ── the aid tile route ────────────────────────────────────────────────────────


@pytest.fixture
def tile_client():
    """Only the tiles blueprint: this needs no Overpass and no osmnx settings."""
    app = Flask(__name__)
    app.register_blueprint(tiles_module.bp)
    return app.test_client()


SAME_ORIGIN = {"Referer": "http://localhost/"}


def test_an_unknown_aid_layer_is_refused_before_a_url_is_built(tile_client: Any):
    """`layer` is a key into AID_LAYERS and nothing else.

    A miss has to fail here rather than reach `.format`, or the path segment
    would be choosing what the server fetches.
    """
    assert (
        tile_client.get("/tiles/aid/nope/10/1/1.png", headers=SAME_ORIGIN).status_code
        == 404
    )
    assert (
        tile_client.get(
            # cSpell: disable-next-line
            "/tiles/aid/..%2f..%2fetc/10/1/1.png",
            headers=SAME_ORIGIN,
        ).status_code
        == 404
    )


def test_an_aid_layer_is_capped_at_the_zoom_its_provider_publishes(tile_client: Any):
    """OpenTopoMap stops at 17; asking upstream for 18 earns a 404 or a ban."""
    assert (
        tile_client.get(
            "/tiles/aid/terrain/18/1/1.png", headers=SAME_ORIGIN
        ).status_code
        == 400
    )


def test_aid_tiles_honour_the_same_origin_rule(tile_client: Any):
    assert tile_client.get("/tiles/aid/imagery/10/1/1.png").status_code == 403


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (b"\xff\xd8\xff\xe0JFIF", "image/jpeg"),  # cSpell: disable-line
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),  # cSpell: disable-line
        (b"\x89PNG\r\n\x1a\n", "image/png"),  # cSpell: disable-line
    ],
)
def test_the_payload_is_sniffed_rather_than_named(data: bytes, expected: str):
    """Cached tiles are all `.png` — the extension names a cache slot.

    Imagery providers serve JPEG. Announced as `image/png` it still decodes in
    a browser, but not in every canvas pipeline, and the failure is a blank
    tile with nothing in the console.
    """
    assert mimetype(data) == expected


def test_the_client_never_learns_the_upstream_tile_provider():
    """Every URL handed to the browser is a route on this origin.

    Same-origin is what keeps the print canvas untainted and exportable, and
    it is what makes switching provider a server-side change.
    """
    config = client_basemaps()
    urls = [config["base"]["url"]] + [layer["url"] for layer in config["aid"]]
    assert all(url.startswith("/tiles/") for url in urls), urls


def test_the_printable_basemap_is_not_reachable_under_the_aid_prefix():
    """print.js builds its URLs from the base route; these must not collide."""
    config = client_basemaps()
    assert "/aid/" not in config["base"]["url"]
    assert all(layer["url"].startswith("/tiles/aid/") for layer in config["aid"])
