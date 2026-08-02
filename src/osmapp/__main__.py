"""Entrypoint — starts background threads, then hands off to the WSGI server."""

from __future__ import annotations

import os
import threading

from waitress import serve

from . import create_app
from .internal.headers import refresh_headers
from .internal.threads import execute_in_thread
from .internal.tiles import prune_tiles


def main() -> None:
    app = create_app()
    cancel = threading.Event()

    execute_in_thread(refresh_headers, cancel, 300, "refresh_headers")  # every 5 min

    def prune_tiles_wrapper() -> None:
        _ = prune_tiles()

    execute_in_thread(prune_tiles_wrapper, cancel, 6 * 3600, "prune_tiles")  # every 6 h

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"

    try:
        if debug:
            app.run(host=host, port=port, debug=True)
        else:
            serve(app, host=host, port=port)
    finally:
        cancel.set()


if __name__ == "__main__":
    main()
