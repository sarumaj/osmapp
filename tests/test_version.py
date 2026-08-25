"""The two numbers in the corner, and the four files behind them.

The banner is only as useful as it is honest: a number that lags the build it
names is worse than no number, because it is believed. Three of the tests here
are about that — each of the sources agreeing with the file it is derived from
— and the fourth is about the number reaching the page at all.

The lookups themselves matter because nothing in development exercises the path
production takes. A checkout has `pyproject.toml` and `package.json` sitting
next to it and never reaches the fallbacks; an installed app has neither and is
nothing but fallbacks. So they are tested against a directory that has been
emptied of both, which is the shape of a wheel.
"""

import json
import tomllib
from pathlib import Path

import pytest
from flask import Flask

from osmapp import create_app
from osmapp.internal.version import (
    CLIENT_VERSION,
    CLIENT_VERSION_FILE,
    REPO_ROOT,
    SERVER_VERSION,
    UNKNOWN,
)
from osmapp.internal.version import (
    _json_version as json_version,  # type: ignore[reportPrivateUsage]
)
from osmapp.internal.version import (
    _pyproject_version as pyproject_version,  # type: ignore[reportPrivateUsage]
)

PYPROJECT = REPO_ROOT / "pyproject.toml"
PACKAGE_JSON = REPO_ROOT / "package.json"


@pytest.fixture
def app() -> Flask:
    return create_app()


def test_the_server_version_is_the_one_in_pyproject():
    declared = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["version"]
    assert SERVER_VERSION == declared


def test_the_client_version_is_the_one_in_package_json():
    declared = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
    assert CLIENT_VERSION == declared


def test_the_shipped_client_version_was_written_from_this_package_json():
    """The generated copy is what an installed app reads, and it can go stale.

    `npm run vendor` writes it, so a hand-edited `package.json` that never went
    through that step leaves a checkout naming one version and every wheel and
    image built from it naming the one before. Nothing else would say so: the
    number is right everywhere a developer looks and wrong everywhere else.

    The release path cannot trip this — ci.yml stamps `package.json` and then
    regenerates before it commits — which is exactly why the failure would be a
    manual bump, and why the fix is to run `npm run vendor`.
    """
    declared = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]
    assert json_version(CLIENT_VERSION_FILE) == declared, (
        f"{CLIENT_VERSION_FILE.name} says "
        f"{json_version(CLIENT_VERSION_FILE)!r} — run `npm run vendor`"
    )


@pytest.mark.parametrize("lang, path", [("en", "/"), ("de", "/de")])
def test_the_page_shows_both_halves(app: Flask, lang: str, path: str):
    """Server-rendered, so it is in the HTML rather than in what JS builds."""
    _ = lang  # the id of the case; the banner is language-independent
    body = app.test_client().get(path).get_data(as_text=True)
    banner = body.split('id="version-banner"', 1)[-1].split("</div>", 1)[0]
    assert 'data-i18n="version.server"' in banner
    assert 'data-i18n="version.client"' in banner
    assert SERVER_VERSION in banner
    assert CLIENT_VERSION in banner


def test_a_missing_source_file_is_not_a_version(tmp_path: Path):
    """What an installed app hits: neither file is next to the package."""
    assert pyproject_version(tmp_path / "pyproject.toml") is None
    assert json_version(tmp_path / "package.json") is None


@pytest.mark.parametrize(
    "content",
    [
        pytest.param("[1, 2, 3]", id="not-an-object"),
        pytest.param('{"version": 3}', id="not-a-string"),
        pytest.param('{"name": "osmapp"}', id="no-version"),
        pytest.param("{oops", id="malformed"),
        pytest.param("", id="empty"),
    ],
)
def test_a_broken_version_file_costs_the_number_not_the_page(
    content: str, tmp_path: Path
):
    """The banner is a footnote; it must never be what takes the app down."""
    path = tmp_path / "package.json"
    path.write_text(content, encoding="utf-8")
    assert json_version(path) is None


def test_nothing_ever_renders_an_empty_version():
    """`unknown` is a readable answer to "which build is this"; blank is not."""
    assert SERVER_VERSION and CLIENT_VERSION
    assert UNKNOWN not in (SERVER_VERSION, CLIENT_VERSION), (
        "neither pyproject.toml nor package.json was found from "
        f"{REPO_ROOT} — the checkout layout changed"
    )
