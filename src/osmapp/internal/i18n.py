"""Dictionary loading with mtime-based hot-reload, and the language routing map."""

import json
import logging
from typing import Any, cast

from flask import url_for

from .config import I18N_DIR

logger = logging.getLogger("osm_app")

SUPPORTED_LANGS: tuple[str, ...] = ("en", "pl", "de", "fr")
DEFAULT_LANG = "en"

# (mtime, dict) — re-read only when the file changes on disk.
_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def load_dictionary(code: str) -> dict[str, Any]:
    """One language's messages, re-read only when the file's mtime changes.

    A file that is missing, unreadable or malformed yields an empty dict rather
    than raising. The client falls back to English per key, so a broken
    dictionary costs that translation and not the page — and this is inlined into
    every render, so raising here would answer every route in every language with
    a 500.

    A failed read is deliberately not cached, so correcting the file takes effect
    on the next request rather than needing a restart.
    """
    path = I18N_DIR / f"{code}.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        logger.warning("Missing dictionary: %s", path)
        return {}

    cached = _cache.get(code)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    try:
        with path.open(encoding="utf-8") as fh:
            data: Any = json.load(fh)
    except (OSError, ValueError):
        # ValueError covers json.JSONDecodeError, which subclasses it.
        logger.exception("Unreadable dictionary: %s", path)
        return {}

    if not isinstance(data, dict):
        # A file holding a list or a bare string decodes without error and then
        # fails at the first `.get` in whatever walks it.
        logger.warning("Dictionary is not a JSON object: %s", path)
        return {}

    _cache[code] = (mtime, data)
    return cast(dict[str, Any], data)


def language_paths() -> dict[str, str]:
    """Code -> URL for every supported language.

    Lives here rather than beside either of its callers, `views.py` and `pwa.py`,
    because a second copy is one edit away from the page's <link rel="alternate">
    set and the manifest's start_url disagreeing about where a language lives.

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
