"""Dictionary loading with mtime-based hot-reload, and the language routing map."""

import json
import logging
from typing import Any

from flask import url_for

from .config import I18N_DIR

logger = logging.getLogger("osm_app")

SUPPORTED_LANGS: tuple[str, ...] = ("en", "pl", "de", "fr")
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


def language_paths() -> dict[str, str]:
    """Code -> URL for every supported language.

    Lives here rather than beside either of its callers because it had drifted
    into being defined twice — identically — in `views.py` and `pwa.py`, which
    is one edit away from the page's <link rel="alternate"> set and the
    manifest's start_url disagreeing about where a language lives.

    Needs an application context: `url_for` resolves against the registered
    view functions, which is also what keeps this honest if the routes are
    ever renamed.
    """
    return {
        code: url_for("views.index")
        if code == DEFAULT_LANG
        else url_for("views.index_localized", lang=code)
        for code in SUPPORTED_LANGS
    }
