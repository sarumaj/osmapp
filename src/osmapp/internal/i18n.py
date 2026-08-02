"""Dictionary loading with mtime-based hot-reload."""

import json
import logging
from typing import Any

from .config import I18N_DIR

logger = logging.getLogger("osm_app")

SUPPORTED_LANGS: tuple[str, ...] = ("en", "pl", "de")
DEFAULT_LANG = "en"

# (mtime, dict) — re-read only when the file changes on disk.
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def load_dictionary(code: str) -> dict[str, Any]:
    path = I18N_DIR / f"{code}.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        logger.warning("Missing dictionary: %s", path)
        return {}

    cached = _cache.get(code)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    with path.open(encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    _cache[code] = (mtime, data)
    return data
