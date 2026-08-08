"""HTML views: index, health, localized index."""

from flask import Blueprint, redirect, render_template, request, url_for
from werkzeug.wrappers import Response

from .i18n import DEFAULT_LANG, SUPPORTED_LANGS, load_dictionary
from .tiles import client_basemaps

bp = Blueprint("views", __name__)


def _language_paths() -> dict[str, str]:
    return {
        code: url_for("views.index")
        if code == DEFAULT_LANG
        else url_for("views.index_localized", lang=code)
        for code in SUPPORTED_LANGS
    }


def _render_app(lang: str) -> str:
    return render_template(
        "index.html",
        lang=lang,
        lang_paths=_language_paths(),
        basemaps=client_basemaps(),
        i18n_bundle={
            "lang": lang,
            "messages": load_dictionary(lang),
            "fallback": load_dictionary(DEFAULT_LANG),
        },
    )


@bp.route("/")
def index() -> str:
    return _render_app(DEFAULT_LANG)


@bp.route("/service/health")
def health() -> str:
    return "OK"


@bp.route(
    f"/<any({','.join(SUPPORTED_LANGS)}):lang>",
    strict_slashes=False,
)
def index_localized(lang: str) -> Response | str:
    if lang == DEFAULT_LANG:
        return redirect(url_for("views.index"), code=302)
    if request.path.endswith("/"):
        return redirect(url_for("views.index_localized", lang=lang), code=302)
    return _render_app(lang)
