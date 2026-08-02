"""Flask application factory."""

from __future__ import annotations

import logging

from flask import Flask

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

    init_osmnx(OVERPASS_URL)

    from .internal.data import bp as data_bp
    from .internal.geocode import bp as geocode_bp
    from .internal.pdf import bp as pdf_bp
    from .internal.tiles import bp as tiles_bp
    from .internal.views import bp as views_bp

    for blueprint in (views_bp, data_bp, geocode_bp, tiles_bp, pdf_bp):
        app.register_blueprint(blueprint)

    from .internal.tiles import prune_tiles

    @app.cli.command("prune-tiles")
    def prune_tiles_command() -> None:
        """flask prune-tiles"""
        removed, freed = prune_tiles()
        print(f"Removed {removed} tiles, freed {freed / 1024 / 1024:.1f} MB")

    return app
