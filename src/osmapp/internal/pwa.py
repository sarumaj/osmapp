"""Progressive-web-app plumbing: the manifest and the service worker.

The interesting problem here is freshness, not offline. Nothing in
`static/js/` carries a fingerprint - `url_for('static', filename='js/main.js')`
is a bare `/static/js/main.js` - so a service worker that cache-firsts those
files has no way to notice a deploy, and the app would happily run last week's
JavaScript against this week's HTML forever.

Rather than adding a build step to a project that deliberately has none, the
cache version is derived from the bytes of the precached files themselves. It
is interpolated into `sw.js`, so any change to any asset changes the service
worker's own body. Browsers byte-compare `sw.js` on every navigation, which
turns "an asset changed" into "the service worker updated" without anyone
having to remember to bump a constant.

The version is cached against the newest mtime in the tree, mirroring the
mtime-keyed cache in `i18n.py`: on a container this hashes once and never
again, while in development an edit is picked up without a restart.
"""

import hashlib
import json
from pathlib import Path

from flask import (
    Blueprint,
    Response,
    current_app,
    make_response,
    render_template,
    request,
    url_for,
)

from .config import STATIC_DIR
from .i18n import DEFAULT_LANG, SUPPORTED_LANGS, language_paths, load_dictionary

bp = Blueprint("pwa", __name__)

# Directories precached on install. `fonts/` is here because DejaVuSans stopped
# being reportlab's alone: static/js/pdfdoc.js composes the card in the browser
# and embeds the same face, and the standard 14 cannot render ł ą ę ś ż ź ć ń.
# It is ~750 KB, which is the price of printing a card with no network.
PRECACHE_DIRS = ("css", "fonts", "js", "lang", "icons", "vendor")

THEME_COLOR = "#3388ff"  # --c-accent
BACKGROUND_COLOR = "#ffffff"  # --c-surface

_cache: dict[str, tuple[float, tuple[str, list[str]]]] = {}


def _iter_assets() -> list[Path]:
    found: list[Path] = []
    for name in PRECACHE_DIRS:
        directory = STATIC_DIR / name
        if not directory.is_dir():
            continue
        found.extend(
            path
            for path in directory.rglob("*")
            if path.is_file() and not path.name.startswith(".")
        )
    return sorted(found)


def _newest_mtime(paths: list[Path]) -> float:
    return max((path.stat().st_mtime for path in paths), default=0.0)


def asset_manifest() -> tuple[str, list[str]]:
    """Return `(version, urls)` for everything the service worker precaches.

    `version` is a short digest over each file's path and contents, so it
    changes when a file is edited, added, removed or renamed.
    """
    paths = _iter_assets()
    stamp = _newest_mtime(paths)

    cached = _cache.get("assets")
    if cached is not None and cached[0] == stamp:
        return cached[1]

    # Built from `static_url_path` rather than `url_for`, which needs either a
    # request or a configured SERVER_NAME. This way the manifest can also be
    # computed at startup or from a CLI command.
    root = current_app.static_url_path or "/static"

    digest = hashlib.sha256()
    urls: list[str] = []
    for path in paths:
        relative = path.relative_to(STATIC_DIR).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(path.read_bytes())
        urls.append(f"{root}/{relative}")

    result = (digest.hexdigest()[:12], urls)
    _cache["assets"] = (stamp, result)
    return result


@bp.route("/sw.js")
def service_worker() -> Response:
    """Serve the worker from the root so its default scope covers the app.

    A worker served from `/static/js/sw.js` may only control `/static/js/`,
    which would leave the localized pages and the tile proxy uncontrolled.
    `Service-Worker-Allowed` is sent as well so the scope stays explicit even
    if the file is ever moved.
    """
    version, urls = asset_manifest()
    body = render_template(
        "sw.js.j2",
        version=version,
        precache=urls,
        navigations=sorted(set(language_paths().values())),
        offline_url=url_for("views.index"),
    )
    response = make_response(body)
    response.mimetype = "text/javascript"
    # The worker script itself must never be served from the HTTP cache, or an
    # update can sit undetected for as long as the cache entry lives.
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Service-Worker-Allowed"] = "/"
    return response


@bp.route("/manifest.webmanifest")
def manifest() -> Response:
    """One installable app, described in whichever language was requested.

    `id` is pinned to `/` across all languages on purpose: keying it on the
    localized start URL would make a Polish install and a German install look
    like two separate apps to the browser.
    """
    lang = request.args.get("lang", DEFAULT_LANG)
    if lang not in SUPPORTED_LANGS:
        lang = DEFAULT_LANG

    messages = load_dictionary(lang)
    fallback = load_dictionary(DEFAULT_LANG)

    def text(key: str, default: str) -> str:
        node = messages.copy()
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None  # type: ignore[reportUnknownMemberType]
        if isinstance(node, str):
            return node
        node = fallback
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None  # type: ignore[reportUnknownMemberType]
        return node if isinstance(node, str) else default

    payload = {
        "id": "/",
        "name": text("pwa.name", "OSM Territory Mapper"),
        "short_name": text("pwa.shortName", "Territories"),
        "description": text(
            "pwa.description",
            "Draw and manage territory polygons on OpenStreetMap data.",
        ),
        "lang": lang,
        "dir": "ltr",
        "start_url": language_paths()[lang],
        "scope": "/",
        "display": "standalone",
        "theme_color": THEME_COLOR,
        "background_color": BACKGROUND_COLOR,
        "categories": ["productivity", "utilities", "navigation"],
        "icons": [
            {
                "src": url_for("static", filename="icons/icon.svg"),
                "sizes": "any",
                "type": "image/svg+xml",
            },
            {
                "src": url_for("static", filename="icons/icon-192.png"),
                "sizes": "192x192",
                "type": "image/png",
            },
            {
                "src": url_for("static", filename="icons/icon-512.png"),
                "sizes": "512x512",
                "type": "image/png",
            },
            {
                # Maskable art keeps the mark inside the safe zone so Android
                # can crop it to whatever shape the launcher uses.
                "src": url_for("static", filename="icons/icon-maskable-512.png"),
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }

    response = make_response(json.dumps(payload, ensure_ascii=False, indent=2))
    response.mimetype = "application/manifest+json"
    response.headers["Cache-Control"] = "no-cache"
    return response
