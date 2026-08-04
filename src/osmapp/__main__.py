"""Entrypoint — starts background threads, then hands off to the WSGI server."""

from __future__ import annotations

import os
import threading

from waitress import serve

from . import create_app
from .internal.config import MAX_UPLOAD_BYTES
from .internal.headers import refresh_random_osmnx_headers
from .internal.threads import execute_in_thread
from .internal.tiles import prune_tiles


def main() -> None:
    app = create_app()
    cancel = threading.Event()

    _ = execute_in_thread(
        prune_tiles,
        cancel,
        3 * 3600,  # every 3 h
        "prune_tiles",
    )

    _ = execute_in_thread(
        refresh_random_osmnx_headers,
        cancel,
        1800,  # every 30 min
        "refresh_random_osmnx_headers",
    )

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    try:
        if debug:
            app.run(host=host, port=port, debug=True)
        else:
            serve(
                app,
                host=host,
                port=port,
                connection_limit=200,
                channel_timeout=120,
                max_request_body_size=MAX_UPLOAD_BYTES,
                backlog=256,
            )
    finally:
        cancel.set()


if __name__ == "__main__":
    main()
