"""Flask application factory."""

import logging

from flask import Flask, Response, jsonify, make_response
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from .internal.config import (
    MAX_UPLOAD_BYTES,
    OVERPASS_TIMEOUT,
    OVERPASS_URL,
    STATIC_DIR,
    TEMPLATE_DIR,
)
from .internal.data import bp as data_bp
from .internal.geocode import bp as geocode_bp
from .internal.headers import init_osmnx
from .internal.pwa import bp as pwa_bp
from .internal.tiles import bp as tiles_bp
from .internal.tiles import prune_tiles
from .internal.views import bp as views_bp


def create_app() -> Flask:
    """Build the configured Flask app: limits, blueprints, and osmnx headers.

    Rate limits are per blueprint rather than global, because the routes differ by
    an order of magnitude in what they cost: /service/data reaches Overpass, while
    the page, the tiles and the manifest are cached or static and are exempt.

    Returns:
        An app ready to serve. Nothing here starts a thread — see __main__ for the
        periodic jobs, so an app built by a test has none of them running.
    """
    logging.basicConfig(level=logging.INFO)

    app = Flask(
        "osm_app",
        template_folder=str(TEMPLATE_DIR),
        static_folder=str(STATIC_DIR),
    )
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

    limiter = Limiter(
        key_func=get_remote_address,
        default_limits=["200 per second"],
        storage_uri="memory://",
        strategy="fixed-window",
    )
    limiter.init_app(app)
    limiter.exempt(views_bp)  # the page itself and /service/health
    limiter.exempt(tiles_bp)  # /service/tiles is cheap and cached
    limiter.exempt(pwa_bp)  # the manifest and the worker are static and tiny
    limiter.limit("6 per minute")(data_bp)  # /service/data is expensive
    limiter.limit("30 per minute")(geocode_bp)  # /service/geocode is expensive

    init_osmnx(OVERPASS_URL, OVERPASS_TIMEOUT)

    for blueprint in (views_bp, data_bp, geocode_bp, tiles_bp, pwa_bp):
        app.register_blueprint(blueprint)

    @app.errorhandler(429)
    def ratelimit_handler(e: Exception) -> Response:
        """429 as JSON, so a throttled client parses it like any other error."""
        return make_response(
            jsonify(
                error="Rate limit exceeded.",
                detail=str(getattr(e, "description", None)),
            ),
            429,
        )

    @app.cli.command("prune-tiles")
    def prune_tiles_command():
        """flask prune-tiles"""
        removed, freed = prune_tiles()
        print(f"Removed {removed} tiles, freed {freed / 1024 / 1024:.1f} MB")

    _ = (ratelimit_handler, prune_tiles_command)  # silence unused variable warning
    return app
