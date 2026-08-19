"""HTML views: index, health, localized index."""

from flask import Blueprint, redirect, render_template, request, url_for
from werkzeug.wrappers import Response

from .i18n import DEFAULT_LANG, SUPPORTED_LANGS, language_paths, load_dictionary
from .tiles import client_basemaps

bp = Blueprint("views", __name__)


def _render_app(lang: str) -> str:
    return render_template(
        "index.html.j2",
        lang=lang,
        lang_paths=language_paths(),
        basemaps=client_basemaps(),
        i18n_bundle={
            "lang": lang,
            "messages": load_dictionary(lang),
            "fallback": load_dictionary(DEFAULT_LANG),
        },
    )


@bp.route("/")
def index() -> str:
    """The app in the default language."""
    return _render_app(DEFAULT_LANG)


@bp.route("/service/health")
def health() -> str:
    """Liveness probe: 200 and a fixed body, touching nothing else."""
    return "OK"


@bp.route(
    f"/<any({','.join(SUPPORTED_LANGS)}):lang>",
    strict_slashes=False,
)
def index_localized(lang: str) -> Response | str:
    """The app under a language prefix, e.g. /de.

    Redirects rather than serving two URLs for one page: the default language
    belongs at / and a trailing slash is not a second address for /de.
    """
    if lang == DEFAULT_LANG:
        return redirect(url_for("views.index"), code=302)
    if request.path.endswith("/"):
        return redirect(url_for("views.index_localized", lang=lang), code=302)
    return _render_app(lang)
