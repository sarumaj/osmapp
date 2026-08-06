"""Flask route contracts — the deploy surface.

Cheap to run and they cover the things a refactor breaks silently: language
routing, input validation on the Overpass endpoints, and the health check the
deploy workflow rolls back on.
"""

import json
from typing import Any

import pytest

from osmapp import create_app
from osmapp.internal.i18n import DEFAULT_LANG, SUPPORTED_LANGS


@pytest.fixture()
def client():
    app = create_app()
    # flask-limiter is on in production; leaving it on here turns a repeated
    # parametrized request into a 429 rather than the status under test.
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)  # type: ignore
    with app.test_client() as c:
        yield c


# ── Language routing ────────────────────────────────────────────────────────


def test_root_serves_the_default_language(client: Any):
    response = client.get("/")
    assert response.status_code == 200
    assert f'lang="{DEFAULT_LANG}"' in response.get_data(as_text=True)


@pytest.mark.parametrize("code", [c for c in SUPPORTED_LANGS if c != DEFAULT_LANG])
def test_each_language_has_its_own_url(client: Any, code: str):
    response = client.get(f"/{code}")
    assert response.status_code == 200
    assert f'lang="{code}"' in response.get_data(as_text=True)


def test_default_language_has_one_canonical_url(client: Any):
    # /en redirects to / so the same page is not served from two URLs.
    response = client.get(f"/{DEFAULT_LANG}")
    assert response.status_code == 302
    assert response.headers["Location"].endswith("/")


@pytest.mark.parametrize("code", [c for c in SUPPORTED_LANGS if c != DEFAULT_LANG])
def test_trailing_slash_redirects(client: Any, code: str):
    # A trailing slash changes how relative asset URLs resolve in the browser,
    # so both forms must not serve content.
    response = client.get(f"/{code}/")
    assert response.status_code == 302


@pytest.mark.parametrize("path", ["/fr", "/xx", "/nope"])
def test_unknown_languages_are_not_found(client: Any, path: str):
    assert client.get(path).status_code == 404


def test_dictionary_is_inlined_with_a_fallback(client: Any):
    body = client.get("/pl").get_data(as_text=True)
    raw = body.split("window.I18N_BUNDLE = ")[1].split(";\n")[0]
    bundle = json.loads(raw)
    assert bundle["lang"] == "pl"
    assert bundle["messages"], "the active dictionary is inlined"
    assert bundle["fallback"], "English is inlined as a fallback"


# ── Overpass endpoints ──────────────────────────────────────────────────────


@pytest.mark.parametrize("route", ["/fetch_streets", "/fetch_buildings"])
def test_polygon_is_required(client: Any, route: str):
    # There is deliberately no server-side geometry cache: one used to mean two
    # browser tabs handed each other's areas.
    assert client.post(route, json={}).status_code == 400
    assert client.post(route, data="not json").status_code == 400


@pytest.mark.parametrize("route", ["/fetch_streets", "/fetch_buildings"])
def test_oversized_polygons_are_refused(client: Any, route: str):
    # Roughly a 3-degree square: Overpass would pull hundreds of megabytes and
    # then time out, so it is refused up front.
    huge = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]]],
        },
    }
    response = client.post(route, json=huge)
    assert response.status_code == 400
    assert "error" in response.get_json()


# ── Operational ─────────────────────────────────────────────────────────────


def test_health_check_responds(client: Any):
    # The deploy workflow rolls back on this endpoint.
    assert client.get("/service/health").status_code == 200


@pytest.mark.parametrize("z,x,y", [(20, 0, 0), (5, 999, 0), (5, 0, 999)])
def test_tiles_reject_out_of_range(client: Any, z: int, x: int, y: int):
    assert client.get(f"/tiles/{z}/{x}/{y}.png").status_code == 403


def test_compose_pdf_requires_both_files(client: Any):
    assert client.post("/compose_pdf", data={}).status_code == 400
