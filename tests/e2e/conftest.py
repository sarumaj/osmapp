"""End-to-end tests

`tests/*.py` exercises the Flask side with no browser; `tests/js/*.test.mjs`
compiles a client module under Node with every global it touches replaced by
a stub. Neither one can tell whether the page that ships actually starts:
a `<script>` dropped from the load order in `index.html.j2`, a vendored file
that stopped being copied or a module that throws on the real DOM rather than
the stubbed one — all of it passes both suites and leaves a blank map behind.

That is the gap these tests fill, and it bounds them too. They assert that the
page boots, that the pieces the rest of the app hangs off exist, and that the
few flows with no non-browser equivalent still work. Anything a stub can check
belongs in the Node suite, which is faster and does not need a browser.
"""

import base64
import logging
import re
import threading
import warnings
from collections.abc import Iterator
from pathlib import Path

import pytest
from playwright.sync_api import (
    BrowserContext,
    ConsoleMessage,
    Page,
    Playwright,
    Response,
    expect,
    sync_playwright,
)
from playwright.sync_api import Error as PlaywrightError
from werkzeug.serving import BaseWSGIServer, make_server

from osmapp import create_app
from osmapp.internal import geocode, headers, tiles

# A 1×1 transparent PNG. Leaflet only needs the image to decode; what it shows
# is irrelevant to every assertion here, and stubbing it keeps both the tile
# proxy and the provider behind it out of the test run.
BLANK_TILE = base64.b64decode(  # cSpell: disable-next-line
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

# The app's own answer for "Nominatim found nothing here", which is a case
# the client is written to expect and the print dialog treats as "no locality
# suggestion" rather than as a failure.
NO_PLACE = b'{"name": null, "display": null, "candidates": []}'

# Port 9 is discard, and nothing listens on it here: a connection is refused
# immediately rather than timing out.
NOWHERE = "http://127.0.0.1:9"

BROWSERS = ("chromium", "firefox", "webkit")


# ══════════════════════════════════════════════════════════════════════════════
# SKIPPING
# ══════════════════════════════════════════════════════════════════════════════


def missing_browsers(config: pytest.Config) -> set[str]:
    """Which of the requested browsers are not on this machine.

    One `sync_playwright()` block for all of them rather than one apiece.
    Opening it starts the Node driver and closing it tears that driver's event
    loop down underneath a task still waiting on it, which prints a `Task was
    destroyed but it is pending` and a stray `TargetClosedError` to stderr.
    Both are harmless and neither is ours to fix, but they land ahead of
    pytest's own header and read like a crash — once is enough of that.
    """
    if config.getoption("browser_channel", default=None):
        return set()

    wanted = config.getoption("browser", default=None) or ["chromium"]
    # Anything outside BROWSERS is not ours to judge; let Playwright report it.
    ours = [name for name in wanted if name in BROWSERS]
    if not ours:
        return set()

    with (
        warnings.catch_warnings(),
        sync_playwright() as playwright,
    ):
        return {name for name in ours if not is_installed(playwright, name)}


def is_installed(playwright: Playwright, name: str) -> bool:
    """Does this browser have an executable on disk?

    Asking Playwright rather than guessing at a path: the download directory
    moves with PLAYWRIGHT_BROWSERS_PATH and the build number changes with
    every release, and `executable_path` accounts for both.
    """
    try:
        return Path(getattr(playwright, name).executable_path).exists()
    except PlaywrightError:
        return False


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]):
    """Mark everything here as e2e, then skip what cannot run.

    The marker is unconditional, and applied before anything else can return.
    It says where a test lives, not whether it can run today: `-m e2e` has to
    select this directory and `-m "not e2e"` has to exclude it, identically on
    a machine with browsers and on one without. Deriving it from whether the
    browsers happen to be installed inverts that — the marker then exists only
    where the tests cannot run, so the CI job that installs Chromium selects
    nothing, and pytest exits 5 (no tests ran) on the one machine the suite
    was written for.

    Skipping is the conditional half. pytest-playwright parametrizes every
    test by browser, so `--browser chromium --browser webkit` with only one of
    them installed still runs everything it can: the missing half is skipped
    by name and the other half is tested.
    """
    here = Path(__file__).parent
    mine = [item for item in items if here in item.path.parents]
    if not mine:
        return

    for item in mine:
        item.add_marker(pytest.mark.e2e)

    missing = missing_browsers(config)
    if not missing:
        return

    for item in mine:
        callspec = getattr(item, "callspec", None)
        name = callspec.params.get("browser_name") if callspec else None
        if name is None or name in missing:
            item.add_marker(
                pytest.mark.skip(
                    reason=f"no browser installed — playwright install {name or ' '.join(sorted(missing))}"
                )
            )


# ══════════════════════════════════════════════════════════════════════════════
# THE SERVER
# ══════════════════════════════════════════════════════════════════════════════


def cut_the_upstream_lines():
    """Leave the app no way out to Overpass, Nominatim or the tile provider.

    The endpoints are module-level constants read from the environment at
    import time, so they are rebound here rather than set through it: by the
    time a fixture runs, `osmapp.internal.config` has long been imported, and
    whether it was imported before or after this file is not something a test
    should depend on.
    """

    geocode.NOMINATIM_URL = f"{NOWHERE}/search"
    geocode.NOMINATIM_LOOKUP_URL = f"{NOWHERE}/lookup"
    geocode.NOMINATIM_REVERSE_URL = f"{NOWHERE}/reverse"
    tiles.TILE_URL_TEMPLATE = NOWHERE + "/{z}/{x}/{y}.png"
    headers.init_osmnx(f"{NOWHERE}/api", timeout=1)


@pytest.fixture(scope="session")
def live_server() -> Iterator[str]:
    """The real app, on a real socket, for the whole session.

    Port 0 lets the OS pick, so parallel runs and a developer's own `flask run`
    cannot collide. Threaded because the page asks for several assets at once
    and a single-threaded server would serialize them.
    """
    cut_the_upstream_lines()
    app = create_app()

    # create_app() calls logging.basicConfig(INFO), which puts a line per
    # request into pytest's captured output — several hundred of them per test,
    # for assets no assertion is about. The requests that matter are watched
    # from the browser side instead, by the `broken_assets` fixture.
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    server: BaseWSGIServer = make_server("127.0.0.1", 0, app, threaded=True)
    thread = threading.Thread(
        target=server.serve_forever, name="e2e-server", daemon=True
    )
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)


@pytest.fixture(scope="session")
def base_url(live_server: str) -> str:
    """Point pytest-playwright's relative navigation at the fixture server."""
    return live_server


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args: dict[str, object]) -> dict[str, object]:
    """Service workers off.

    Nothing asserted here needs one, they are registered on `load` so they
    would come and go mid-test, and a worker's own fetches bypass page
    routing — which would put a hole in the interception below. pwa.js already
    treats a refused registration as a warning rather than a failure.
    """
    return {**browser_context_args, "service_workers": "block"}


@pytest.fixture(autouse=True)
def hermetic(context: BrowserContext, base_url: str):
    """Answer the two outward-facing calls locally, refuse the rest.

    Three narrow patterns rather than one catch-all: a matched route is handed
    to Python and back over the driver connection, which is several hundred
    assets per page load spent proving they were same-origin. The lookahead
    leaves every one of them to the browser and still leaves nothing a test
    can accidentally fetch — the page is entirely self-hosted, so a request
    that does not start with the server's own URL is a bug in a test or a
    dependency that grew a CDN.
    """
    context.route(
        re.compile(f"^(?!{re.escape(base_url)})"),
        lambda route: route.abort(),
    )
    context.route(
        re.compile(r"/tiles/"),
        lambda route: route.fulfill(
            status=200, content_type="image/png", body=BLANK_TILE
        ),
    )
    context.route(
        re.compile(r"/reverse_geocode"),
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=NO_PLACE
        ),
    )


# ══════════════════════════════════════════════════════════════════════════════
# THE PAGE
# ══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def console_errors(page: Page) -> list[str]:
    """Everything the page complained about, in order.

    Requested by `app_page` rather than only by the tests that read it, so
    the listeners are attached before the first navigation — an error thrown
    while the modules wire themselves up is exactly the kind this suite exists
    to catch, and it happens before any test body runs.
    """
    errors: list[str] = []

    def on_console(message: ConsoleMessage):
        if message.type == "error":
            errors.append(f"console: {message.text}")

    page.on("console", on_console)
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    return errors


@pytest.fixture
def broken_assets(page: Page) -> list[str]:
    """Same-origin responses the page did not get.

    A 404 on a stylesheet, an icon or a vendored library is not an error in
    any console and not a failure of anything asserted below — the page simply
    renders without it. That is exactly how a file dropped from the vendor
    tree or renamed in `static/` reaches production. Requests that leave the
    origin are aborted rather than answered, so they never appear here.
    """
    broken: list[str] = []

    def on_response(response: Response):
        if response.status >= 400:
            broken.append(f"{response.status} {response.url}")

    page.on("response", on_response)
    return broken


@pytest.fixture
def app_page(page: Page, console_errors: list[str], broken_assets: list[str]) -> Page:
    """A booted app, with the guided tour out of the way.

    `?tour=0` is the app's own override for the auto-start on a first visit —
    every context here is a first visit — and using it rather than seeding the
    localStorage flag keeps the tour's own test honest about the flag.

    Boot finishes asynchronously (a `setTimeout`, then the dictionary fetch),
    so waiting for the toolbar is what makes the rest of a test deterministic:
    controls.init() is the last thing to mount before the app is idle.
    """
    _ = (console_errors, broken_assets)

    page.goto("/?tour=0")
    expect(page.locator(".tb-panel")).to_be_visible()
    return page
