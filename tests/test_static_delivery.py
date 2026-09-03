"""How static assets reach the browser: stamping, caching, and compression.

Server-level integration coverage through Flask's test client. No browser and
no network: every assertion is about the headers and bytes of one response.

The three mechanisms under test depend on each other, which is why they are
one module. The digest that `internal/pwa.py` versions the service worker
cache with is the stamp `internal/assets.py` puts on every static URL, and
that stamp is the only reason a year of `immutable` is safe to hand out. Break
the stamp and the caching turns from an optimization into a way to pin a
visitor to a stale build.
"""

import gzip
import json
import re
from pathlib import Path

import brotli  # type: ignore[reportMissingTypeStubs]
import pytest
from flask import Flask, request

from osmapp import create_app
from osmapp.internal import assets as assets_module
from osmapp.internal import pwa as pwa_module
from osmapp.internal.assets import APP_BUNDLE, APP_STYLESHEET, IMMUTABLE_MAX_AGE
from osmapp.internal.config import STATIC_DIR
from osmapp.internal.pwa import asset_manifest

# Always present, always over the compression threshold, and served whether or
# not the build step has run.
SAMPLE_ASSET = "css/style.css"


@pytest.fixture
def app() -> Flask:
    return create_app()


@pytest.fixture
def version(app: Flask) -> str:
    with app.app_context():
        return asset_manifest()[0]


def test_a_stamped_asset_is_cached_for_a_year(app: Flask, version: str):
    """The stamp is what makes this safe: a new build is a new URL.

    Without `immutable` a reload revalidates every asset the page names, which
    is the round trip this whole mechanism exists to remove.
    """
    response = app.test_client().get(f"/static/{SAMPLE_ASSET}?v={version}")

    assert response.status_code == 200
    assert response.cache_control.max_age == IMMUTABLE_MAX_AGE
    assert response.cache_control.immutable
    assert response.cache_control.public
    assert not response.cache_control.no_cache


def test_an_unstamped_asset_is_still_revalidated(app: Flask):
    """A bare URL names no particular build, so it keeps werkzeug's default.

    Anything else would hand a year of caching to a URL whose contents are
    free to change - a hand-typed path, or a page rendered before this
    mechanism existed.
    """
    response = app.test_client().get(f"/static/{SAMPLE_ASSET}")

    assert response.cache_control.no_cache
    assert response.cache_control.max_age is None


def test_the_page_stamps_every_asset_it_names(app: Flask, version: str):
    """A URL the page names without a stamp is a URL that revalidates forever.

    Checked over the rendered HTML rather than over `url_for` directly,
    because the interesting failures are the call sites that build a URL some
    other way.
    """
    body = app.test_client().get("/").get_data(as_text=True)
    named = set(re.findall(r'["\'](/static/[^"\'\s]+)["\']', body))

    assert named, "the page named no static assets - check the pattern"
    unstamped = [
        url
        for url in named
        # A directory prefix is not an asset; pdf.js appends its own font
        # names to this one, and a query would land in the middle.
        if not url.rstrip("/").endswith("standard_fonts") and f"?v={version}" not in url
    ]
    assert not unstamped, f"unstamped: {sorted(unstamped)}"


def test_the_font_directory_is_kept_unstamped(app: Flask, version: str):
    """pdf.js builds `<standardFontDataUrl><name>.pfb` by concatenation.

    Stamping the directory would put `?v=...` in front of the file name and
    every standard font would 404, which surfaces only as missing glyphs in an
    imported card.
    """
    body = app.test_client().get("/").get_data(as_text=True)
    directory = re.search(r'pdfjsStandardFonts:\s*"([^"]+)"', body)

    assert directory, "the page no longer names pdfjsStandardFonts"
    assert directory.group(1).endswith("standard_fonts/")
    assert "?v=" not in directory.group(1)


def test_brotli_is_served_and_decodes_to_the_file(app: Flask, version: str):
    """The bytes on the wire have to be the bytes on disk, encoded.

    `Vary` is asserted with them because a shared cache that ignores it will
    hand this body to the next client as an identity response.
    """
    response = app.test_client().get(
        f"/static/{SAMPLE_ASSET}?v={version}",
        headers={"Accept-Encoding": "br"},
    )

    assert response.headers["Content-Encoding"] == "br"
    assert "accept-encoding" in response.headers["Vary"].lower()
    raw = (STATIC_DIR / SAMPLE_ASSET).read_bytes()
    assert brotli.decompress(response.get_data()) == raw  # type: ignore[reportUnknownMemberType]
    assert len(response.get_data()) < len(raw)


def test_gzip_serves_the_client_that_does_not_offer_brotli(app: Flask, version: str):
    """A client offering gzip alone must not be answered with brotli or plain.

    Flask-Compress leaves gzip out of the encodings it will stream, and a
    static file is a streamed response, so at the default setting this asset
    came back uncompressed.
    """
    response = app.test_client().get(
        f"/static/{SAMPLE_ASSET}?v={version}",
        headers={"Accept-Encoding": "gzip, deflate"},
    )

    assert response.headers["Content-Encoding"] == "gzip"
    assert (
        gzip.decompress(response.get_data()) == (STATIC_DIR / SAMPLE_ASSET).read_bytes()
    )


def test_a_client_accepting_nothing_gets_the_file(app: Flask, version: str):
    response = app.test_client().get(
        f"/static/{SAMPLE_ASSET}?v={version}",
        headers={"Accept-Encoding": ""},
    )

    assert "Content-Encoding" not in response.headers
    assert response.get_data() == (STATIC_DIR / SAMPLE_ASSET).read_bytes()


def test_a_compressed_asset_still_revalidates_to_304(app: Flask, version: str):
    """An encoded body is a different representation, so it needs its own ETag.

    Reusing the identity ETag makes every revalidation answer 200 with the
    whole file, which is the cost `immutable` hides until something
    revalidates anyway - a shared cache, or a forced reload.
    """
    client = app.test_client()
    headers = {"Accept-Encoding": "br"}
    first = client.get(f"/static/{SAMPLE_ASSET}?v={version}", headers=headers)

    assert first.headers.get("ETag")

    again = client.get(
        f"/static/{SAMPLE_ASSET}?v={version}",
        headers={**headers, "If-None-Match": first.headers["ETag"]},
    )

    assert again.status_code == 304


def test_the_page_itself_is_compressed(app: Flask):
    """The page inlines two dictionaries, which is most of its ~175 KB.

    It is also the one response that cannot be precompressed, so if the
    dynamic path ever stops compressing, this is where it shows.
    """
    response = app.test_client().get("/", headers={"Accept-Encoding": "br"})

    assert response.headers["Content-Encoding"] == "br"
    body = brotli.decompress(response.get_data())  # type: ignore[reportUnknownMemberType]
    assert b"<!doctype html>" in body
    assert len(response.get_data()) < len(body) / 2  # type: ignore[reportUnknownArgumentType]


def test_a_post_body_is_never_served_from_the_compressed_cache(app: Flask):
    """The cache is keyed by URL, and `/service/data` answers a POST.

    Two polygons arrive at one path, so caching by path there would hand the
    second caller the first one's territory. Only a stamped static URL, which
    names one immutable file, may be kept.
    """
    with app.test_request_context("/service/data", method="POST"):
        assert assets_module._cache_key(request) == assets_module.UNCACHEABLE  # type: ignore[reportPrivateUsage]

    with app.test_request_context(f"/static/{SAMPLE_ASSET}?v=abc123"):
        assert assets_module._cache_key(request) == f"/static/{SAMPLE_ASSET}?v=abc123"  # type: ignore[reportPrivateUsage]


def test_the_page_loads_the_bundle_where_the_build_step_ran(
    app: Flask, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """One request instead of thirty-seven, and the sources are not also named.

    The switch is a filesystem probe, so this stands in a tree that has the
    built files and nothing else.
    """
    for name in (APP_BUNDLE, APP_STYLESHEET):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("/* built */")
    monkeypatch.setattr(assets_module, "STATIC_DIR", tmp_path)

    body = app.test_client().get("/").get_data(as_text=True)

    assert body.count("<script defer src=") == 1
    assert APP_BUNDLE in body
    assert APP_STYLESHEET in body
    assert "js/main.js" not in body


def test_the_page_loads_the_sources_where_it_did_not(
    app: Flask, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A checkout that has only ever run `pip install .` still serves a page."""
    monkeypatch.setattr(assets_module, "STATIC_DIR", tmp_path)

    body = app.test_client().get("/").get_data(as_text=True)

    assert body.count("<script defer src=") > 30
    assert "js/main.js" in body
    assert APP_BUNDLE not in body


def test_the_precache_follows_the_build_that_is_served(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Precaching both halves spends 1.2 MB of an install on unused files.

    Built against a constructed tree rather than the real one, because which
    half exists here depends on whether the build step has run.
    """
    (tmp_path / "js").mkdir()
    (tmp_path / "js/main.js").write_text("var a = 1;")
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor/leaflet.js.map").write_text("{}")
    monkeypatch.setattr(pwa_module, "STATIC_DIR", tmp_path)
    monkeypatch.setattr(assets_module, "STATIC_DIR", tmp_path)

    app = create_app()
    with app.app_context():
        monkeypatch.setattr(pwa_module, "_cache", {})
        _, sources = asset_manifest()

        # Devtools fetches a source map from a comment inside the file it
        # belongs to; no visitor ever asks for one.
        assert not [url for url in sources if url.endswith(".map")]
        assert any("js/main.js" in url for url in sources)

        target = tmp_path / APP_BUNDLE
        target.parent.mkdir(parents=True)
        target.write_text("/* built */")
        monkeypatch.setattr(pwa_module, "_cache", {})
        _, bundled = asset_manifest()

    assert any(APP_BUNDLE in url for url in bundled)
    assert not [url for url in bundled if "js/main.js" in url]


def test_every_precached_url_is_stamped(app: Flask):
    """The worker has to precache the URL the page will request.

    Precaching the unstamped form fetches everything twice: once into the
    shell cache on install, and again from the network for a URL nothing
    cached.
    """
    with app.app_context():
        version, urls = asset_manifest()

    assert urls
    assert all(url.endswith(f"?v={version}") for url in urls)


def test_the_manifest_is_valid_json_after_compression(app: Flask):
    """The manifest is small enough to fall under the compression threshold.

    Which is fine, and worth pinning: a body that is sometimes encoded and
    sometimes not is the shape of bug that only appears on one asset size.
    """
    response = app.test_client().get(
        "/manifest.webmanifest", headers={"Accept-Encoding": "br"}
    )
    body = response.get_data()
    if response.headers.get("Content-Encoding") == "br":
        body = brotli.decompress(body)  # type: ignore[reportUnknownMemberType]

    assert json.loads(body)["scope"] == "/"  # type: ignore[reportUnknownArgumentType]
