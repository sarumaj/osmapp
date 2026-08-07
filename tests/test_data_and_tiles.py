"""_clean and prune_tiles.

`_clean` shapes every property in every payload, and it fails silently: a
mishandled NaN becomes the string "nan" in an export, a mishandled list drops a
street name. `prune_tiles` deletes files, so a bug there deletes the wrong ones.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from osmapp.internal import tiles as tiles_module
from osmapp.internal.data import _clean as clean  # type: ignore[reportPrivateUsage]
from osmapp.internal.tiles import (
    _tile_root as tile_root,  # type: ignore[reportPrivateUsage]
)
from osmapp.internal.tiles import (
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


def write_tile(root: Path, y: int, size: int = 100, age_days: int = 0) -> Path:
    path = root / tile_root().name / "10" / "1" / f"{y}.png"
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
