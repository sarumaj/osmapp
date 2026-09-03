"""Compression and the cache policy for everything this app serves.

Compression is Flask-Compress's job. Waitress does not compress, nothing on
Heroku's router does it for us, and the app's own assets are the bulk of a
first visit: about 2.1 MB of JavaScript and CSS unbundled, or 350 KB once
`npm run bundle` has run, against 90 KB of brotli either way. The page gains
as much again - it inlines two language dictionaries, which takes it from
about 175 KB to 25 KB - and so do the Overpass replies from `/service/data`,
which are one JSON shape repeated per building.

What is configured here rather than left at its default:

  - Only brotli and gzip, for streamed responses as well as buffered ones.
    Flask-Compress otherwise prefers zstd, whose level-3 default trades ratio
    for speed; with the compressed bodies cached, ratio is the only thing left
    to prefer.
  - Brotli level 6 rather than the default 4, and not the maximum 11. One
    level serves both halves of the traffic, and 11 costs about 700 ms for the
    bundle against 16 ms at 6, for 8 KB. Static assets would carry that once,
    but every rendered page would carry it again.
  - A bounded cache of compressed static bodies, so a stamped asset is
    encoded once per process instead of once per request. See `_cache_key`
    for what may and may not go in it.

Reaching that cache takes one more step than configuring it. `send_file` hands
back a file wrapper for the server to stream, and Flask-Compress compresses a
streamed response chunk by chunk on the request that returns it - a path that
consults no cache and drops `Content-Length`. `cache_stamped_assets` therefore
reads stamped assets into memory before compression sees them, which is what
puts them on the buffered path. Undoing that means accepting an encode per
request and a chunked 1.2 MB pdf.worker with no length to show for it.

The cache policy is this module's own. A static URL carries no fingerprint,
so werkzeug's default `Cache-Control: no-cache` is the only answer that cannot
serve a stale file, and the cost is that every reload revalidates some forty
of them. `install` closes that by stamping `?v=<digest>` onto every URL
`url_for` produces for the static endpoint, and handing a year of `immutable`
to exactly the requests that arrive with such a stamp. The digest is the one
the service worker versions its cache with, so an edited asset becomes a new
URL rather than a cache entry someone has to invalidate, and a URL without a
stamp keeps today's conservative default.
"""

import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from flask import Flask, Request, Response, g, request
from flask_compress import Compress

from .config import STATIC_DIR

# Minified output of `npm run bundle`, named relative to the static root. A
# plain checkout has neither file, and the page then loads the individual
# sources in template order - slower, and what a developer wants to debug
# against.
APP_BUNDLE = "dist/js/app.min.js"
APP_STYLESHEET = "dist/css/style.min.css"

# One year, the longest age HTTP caches are required to honor. Safe only
# because it is handed out per stamped URL - see `install`.
IMMUTABLE_MAX_AGE = 31_536_000

COMPRESS_ALGORITHMS = ["br", "gzip"]
BROTLI_LEVEL = 6

# The whole static tree compresses to about 1.5 MB, so this is headroom for
# the traffic this cache exists for. It is a bound rather than a target: an
# asset keyed by its stamp is cached under whatever stamp was asked for, so a
# caller inventing stamps can add entries for a body it already has, and this
# is what that costs at worst. Past it, the miss path still answers correctly.
MAX_CACHE_BYTES = 32 * 1024 * 1024

# The key `_cache_key` returns for a body that must not be reused. A URL
# cannot contain a NUL, so this cannot collide with one.
UNCACHEABLE = "\0uncacheable"


class CompressedAssetCache:
    """Compressed bodies for stamped static URLs, held for the process's life.

    Implements the `get`/`set` pair Flask-Compress asks of a cache backend.
    Bodies under `UNCACHEABLE` are neither stored nor returned, and storage
    stops at `MAX_CACHE_BYTES` rather than evicting: what fits is every asset
    the page loads, and past that the miss path still answers correctly.
    """

    def __init__(self):
        self._entries: dict[str, bytes] = {}
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key: str) -> bytes | None:
        if key.endswith(UNCACHEABLE):
            return None
        return self._entries.get(key)

    def set(self, key: str, value: bytes):
        """Store `value`, unless it is uncacheable, already held, or over budget.

        Called on every hit as well as every miss, so returning early for a key
        already present is what keeps a hit cheap.
        """
        if key.endswith(UNCACHEABLE):
            return
        with self._lock:
            if key in self._entries or self._bytes + len(value) > MAX_CACHE_BYTES:
                return
            self._entries[key] = value
            self._bytes += len(value)


def built(name: str, static_dir: Path | None = None) -> str | None:
    """`name` if the build step produced it, or None if only the sources exist.

    Probed per call rather than resolved at import, so that running the build
    step under a live development server takes effect on the next request, and
    so that a caller asking about a different tree gets an answer about that
    tree rather than about this one.

    Args:
        static_dir: The static root to look under. Defaults to the configured
            one.
    """
    root = STATIC_DIR if static_dir is None else static_dir
    return name if (root / name).is_file() else None


def _cache_key(req: Request) -> str:
    """The cache identity of a response body, or a key that is never stored.

    A stamped static URL names one immutable file, so its compressed body can
    be kept for as long as the process lives. Everything else is either
    different per request or free to change under a running server: an
    unstamped asset in development, the rendered page, an Overpass reply.
    `/service/data` is what makes this a correctness rule rather than a tuning
    one - it answers a POST, so two different polygons arrive at one path, and
    a cache keyed by path would hand the second caller the first one's data.
    """
    stamp = req.args.get("v") if req.endpoint == "static" else None
    # The stamp is the only parameter that identifies the representation, so
    # keying on it rather than on the whole query keeps an extra parameter
    # from becoming a second copy of one body.
    return f"{req.path}?v={stamp}" if stamp else UNCACHEABLE


def install(app: Flask, version: Callable[[], str]):
    """Register compression, URL stamping, and the static cache policy.

    Args:
        version: Returns the digest to stamp static URLs with. Called at most
            once per request, and expected to change whenever an asset does.
    """
    app.config.update(  # type: ignore[reportUnknownMemberType]
        COMPRESS_ALGORITHM=COMPRESS_ALGORITHMS,
        # Left at its default this excludes gzip, so a client that offers gzip
        # alone gets an uncompressed body.
        COMPRESS_ALGORITHM_STREAMING=COMPRESS_ALGORITHMS,
        COMPRESS_BR_LEVEL=BROTLI_LEVEL,
        COMPRESS_CACHE_BACKEND=CompressedAssetCache,
        COMPRESS_CACHE_KEY=_cache_key,
    )
    Compress(app)

    static_prefix = f"{app.static_url_path or '/static'}/"

    def current_version() -> str:
        """The digest for this request, computed once however often it is asked.

        One render calls `url_for` for the static endpoint some fifty times,
        and the digest behind it walks the whole static tree.
        """
        if "asset_version" not in g:
            g.asset_version = version()
        return g.asset_version

    @app.url_defaults
    def stamp_static_url(endpoint: str, values: dict[str, Any]):
        """Add `?v=<digest>` to static URLs, which is what earns them a year.

        A caller that passes its own `v` keeps it, which is how `pwa.py` lists
        these URLs in the service worker's precache without hashing twice.
        """
        if endpoint != "static" or "v" in values:
            return
        filename = values.get("filename")
        # pdf.js is handed a directory to append its own font names to (see
        # `standardFontDataUrl` in static/js/pdfdoc.js). A query on that would
        # end up in the middle of the URL it builds, so directories go
        # unstamped - and a directory is not a cacheable representation anyway.
        if not isinstance(filename, str) or filename.endswith("/"):
            return
        values["v"] = current_version()

    # Registered after Compress, and therefore run before it: Flask calls
    # after_request handlers in reverse. Compression may answer a revalidation
    # with a 304, and this has to have set the headers that 304 carries.
    @app.after_request
    def cache_stamped_assets(response: Response) -> Response:
        """Give a stamped static URL a year, and hand its body to the cache.

        Every other URL is left exactly as werkzeug produced it.
        """
        if (
            response.status_code == 200
            and request.path.startswith(static_prefix)
            and request.args.get("v")
        ):
            # The stamp is part of the URL, so the bytes behind it cannot
            # change: a different build is a different URL. `immutable` is
            # what stops a reload from revalidating it anyway.
            response.cache_control.no_cache = None
            response.cache_control.public = True
            response.cache_control.max_age = IMMUTABLE_MAX_AGE
            response.cache_control.immutable = True
            # Reading the file wrapper turns the response into a sequence,
            # which is what routes it to the compression cache rather than to
            # the chunked encoder. Only stamped URLs are read this way: the
            # memory is bounded by what the cache holds, and an unstamped one
            # would buy nothing by it.
            response.direct_passthrough = False
            _ = response.get_data()
        return response

    _ = (stamp_static_url, cache_stamped_assets)  # silence unused variable warning
