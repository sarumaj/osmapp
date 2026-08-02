"""Flask application factory."""

from __future__ import annotations

import logging

from flask import Flask, Response, jsonify, make_response
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from .internal.config import MAX_UPLOAD_BYTES, OVERPASS_URL, STATIC_DIR, TEMPLATE_DIR
from .internal.headers import init_osmnx


def create_app() -> Flask:
    logging.basicConfig(level=logging.INFO)

    app = Flask(
        "osm_app",
        template_folder=str(TEMPLATE_DIR),
        static_folder=str(STATIC_DIR),
    )
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

    limiter = Limiter(key_func=get_remote_address, default_limits=["200 per second"])
    limiter.init_app(app)

    init_osmnx(OVERPASS_URL)

    from .internal.data import bp as data_bp
    from .internal.geocode import bp as geocode_bp
    from .internal.pdf import bp as pdf_bp
    from .internal.tiles import bp as tiles_bp
    from .internal.views import bp as views_bp

    for blueprint in (views_bp, data_bp, geocode_bp, tiles_bp, pdf_bp):
        app.register_blueprint(blueprint)

    from .internal.tiles import prune_tiles

    @app.errorhandler(429)
    def ratelimit_handler(e: Exception) -> Response:
        return make_response(
            jsonify(error="Rate limit exceeded.", detail=str(getattr(e, "description", None))),
            429,
        )

    @app.cli.command("prune-tiles")
    def prune_tiles_command() -> None:
        """flask prune-tiles"""
        removed, freed = prune_tiles()
        print(f"Removed {removed} tiles, freed {freed / 1024 / 1024:.1f} MB")

    return app
