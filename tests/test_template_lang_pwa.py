"""Three things that fail quietly.

The dictionaries and their call sites fall back to English without a warning
when a key is missing or a plural is called without a count. The PWA cache
version is the only thing that tells a browser a deploy happened. And the
client version baked into the worker is the only thing that lets the banner in
the corner name the build actually running rather than the one just deployed.

Template detection is not checked here. It runs in the browser with the rest of
the PDF work, so `tests/js/pdfdoc.test.mjs` covers that ground — the marked box
beating the page frame, the smallest enclosing rectangle, the largest empty one,
and leader dots becoming named fields.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, cast
from unittest import mock

import pytest
from flask import Flask

from osmapp import create_app
from osmapp.internal import i18n as i18n_module
from osmapp.internal import pwa as pwa_module
from osmapp.internal.config import I18N_DIR, STATIC_DIR
from osmapp.internal.i18n import DEFAULT_LANG, SUPPORTED_LANGS
from osmapp.internal.pwa import asset_manifest
from osmapp.internal.version import CLIENT_VERSION

PLURAL_CATEGORIES = {"zero", "one", "two", "few", "many", "other"}
JS_DIR = STATIC_DIR / "js"


def flatten(node: Any, prefix: str = "") -> dict[str, Any]:
    """Dotted key -> "str" or "plural". A plural map counts as one leaf."""
    if isinstance(node, dict):
        if node and set(cast(dict[str, Any], node)) <= PLURAL_CATEGORIES:
            return {prefix: "plural"}
        out: dict[str, Any] = {}
        for key, value in cast(dict[str, Any], node).items():
            out.update(flatten(value, f"{prefix}.{key}" if prefix else key))
        return out
    return {prefix: "str"}


DICTIONARIES = {
    code: json.loads((I18N_DIR / f"{code}.json").read_text(encoding="utf-8"))
    for code in SUPPORTED_LANGS
}
FLAT = {code: flatten(payload) for code, payload in DICTIONARIES.items()}


@pytest.mark.parametrize("code", SUPPORTED_LANGS)
def test_the_dictionaries_have_the_same_keys(code: str):
    """A missing key falls back to English with no warning; an extra key is dead."""
    assert set(FLAT[code]) == set(FLAT[DEFAULT_LANG]), (
        f"{code}.json differs: missing {sorted(set(FLAT[DEFAULT_LANG]) - set(FLAT[code]))[:5]}, "
        f"extra {sorted(set(FLAT[code]) - set(FLAT[DEFAULT_LANG]))[:5]}"
    )


@pytest.mark.parametrize(
    "content",
    [
        pytest.param('{"toolbar": {', id="truncated"),
        pytest.param('{"toolbar": {"draw": "Draw",}}', id="trailing-comma"),
        pytest.param("[1, 2, 3]", id="not-an-object"),
        pytest.param("", id="empty"),
    ],
)
def test_a_broken_dictionary_costs_the_translation_not_the_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str
):
    """A malformed dictionary must degrade to English, not raise.

    The dictionary is inlined into every render, so an exception here is a 500 on
    every route in every language — from a stray comma in a file the client is
    already built to survive the absence of. The four cases are the ways a hand
    edit actually breaks one: cut short, a trailing comma, the wrong top-level
    type, and empty.
    """
    monkeypatch.setattr(i18n_module, "I18N_DIR", tmp_path)
    monkeypatch.setattr(i18n_module, "_cache", {})
    (tmp_path / "pl.json").write_text(content, encoding="utf-8")

    assert i18n_module.load_dictionary("pl") == {}

    # And it recovers without a restart, because a failed read is not cached.
    (tmp_path / "pl.json").write_text(
        '{"toolbar": {"draw": "Rysuj"}}', encoding="utf-8"
    )
    assert i18n_module.load_dictionary("pl") == {"toolbar": {"draw": "Rysuj"}}


def test_every_inflecting_key_is_called_with_a_count():
    """`_resolve` picks a plural category from `vars.count` and nothing else.

    Called without one it returns undefined, `t()` drops through to the English
    fallback, and because that lookup *succeeds* there is no missing-translation
    warning — the bug is invisible until a Polish speaker reads the UI. This is
    exactly how `partition.calcBuildings` shipped English to Polish users.
    """
    plural_keys = {
        key for flat in FLAT.values() for key, kind in flat.items() if kind == "plural"
    }
    call = re.compile(r"\bT?t?\(\s*[\"']([\w.]+)[\"']\s*,\s*(\{[^{}]*\})")

    sites: dict[str, Any] = {}
    for path in sorted(JS_DIR.glob("*.js")):
        for key, args in call.findall(path.read_text(encoding="utf-8")):
            sites.setdefault(key, []).append(args)

    assert len(sites) > 5, "the scanner found nothing — check the regex"

    offenders = [
        f"{key} called with {args.strip()}"
        for key in sorted(plural_keys)
        for args in sites.get(key, [])
        if not re.search(r"\bcount\s*:", args)
    ]
    assert not offenders, "plural keys called without a count: " + "; ".join(offenders)


@pytest.fixture
def app_context():
    app = create_app()
    with app.app_context():
        yield app


def test_editing_an_asset_changes_the_version(
    app_context: Flask, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole update mechanism rests on this.

    Assets carry no fingerprint, so if the digest stops noticing an edit the
    service worker pins every visitor to an old build indefinitely.
    """
    _ = app_context  # silence unused variable warning

    static = tmp_path / "static"
    (static / "js").mkdir(parents=True)
    target = static / "js" / "main.js"
    target.write_text("var a = 1;")

    monkeypatch.setattr(pwa_module, "STATIC_DIR", static)
    monkeypatch.setattr(pwa_module, "_cache", {})
    before = asset_manifest()[0]

    monkeypatch.setattr(pwa_module, "_cache", {})
    target.write_text("var a = 2;")
    stat = target.stat()
    os.utime(target, (stat.st_atime, stat.st_mtime + 10))

    assert asset_manifest()[0] != before


def test_the_worker_carries_the_client_version(app_context: Flask):
    """The banner cannot be honest without it.

    Navigation is network-first and the assets are cache-first, so between a
    deploy and the reload the page is the new HTML running the old JavaScript.
    The banner is rendered into that HTML, so the only way it can name the
    build the browser is actually running is to ask the worker serving those
    assets - and the worker can only answer if the number is baked into it.
    """
    client = app_context.test_client()
    body = client.get("/sw.js").get_data(as_text=True)

    assert f'const CLIENT_VERSION = "{CLIENT_VERSION}"' in body
    # The reply the page reads in _reconcile(). Without `client` in it the
    # banner has nothing to correct itself with and silently stays wrong.
    assert "client: CLIENT_VERSION" in body


def test_a_version_bump_alone_changes_the_worker(app_context: Flask):
    """A release that touches nothing under static/ still has to be noticed.

    The cache digest covers the precached directories, and `package.json` is
    not one of them - so without the version in the worker's body, bumping the
    number alone would leave sw.js byte-identical, no update would be offered,
    and the freshly rendered banner would name a build nobody can reach.
    """
    client = app_context.test_client()
    before = client.get("/sw.js").get_data(as_text=True)

    with mock.patch.object(pwa_module, "CLIENT_VERSION", "99.0.0"):
        after = client.get("/sw.js").get_data(as_text=True)

    assert after != before
    assert 'const CLIENT_VERSION = "99.0.0"' in after


def test_every_precached_url_resolves(app_context: Flask):
    """A single 404 makes `cache.addAll` reject and the install fail entirely."""
    client = app_context.test_client()
    _, urls = asset_manifest()
    assert urls
    missing = [url for url in urls if client.get(url).status_code != 200]
    assert not missing, f"listed but not served: {missing[:5]}"
