"""What the app keeps when the connection goes away.

Every other test in this directory runs with service workers blocked (see
`browser_context_args` in conftest): a worker's own fetches bypass page
routing, and nothing else asserted here needs one. That exemption is also why
a worker that never registered at all went unnoticed -- the suite had arranged
never to look.

So this module opts back in, in a context of its own, and asserts the two
things the offline story rests on: that a worker takes control of the page,
and that the face the PDF composer embeds is in its cache. The font is the
one asset fetched when a card is composed rather than when the page loads, so
it is the first thing to go missing and the last thing anyone connects to a
worker that is not there.
"""

from collections.abc import Iterator

import pytest
from playwright.sync_api import Browser, BrowserContext, Page


# Installing precaches the whole shell -- the vendor tree included -- over a
# loopback server, and a worker only claims the page once that has finished.
CLAIM_TIMEOUT_MS = 30_000


@pytest.fixture(scope="module")
def worker_page(browser: Browser, base_url: str) -> Iterator[Page]:
    """A page under a service worker that has installed and taken control."""
    context: BrowserContext = browser.new_context(service_workers="allow")
    page = context.new_page()
    page.goto(f"{base_url}/?tour=0", wait_until="load")
    page.wait_for_function(
        "() => !!navigator.serviceWorker.controller", timeout=CLAIM_TIMEOUT_MS
    )
    try:
        yield page
    finally:
        context.close()


@pytest.fixture(scope="module")
def font_url(worker_page: Page) -> str:
    """The card font's URL as the page names it, stamp included.

    Read off the page rather than written out here: a static URL carries a
    `?v=<digest>` that changes with any asset, and the Cache API matches on the
    whole URL. Hardcoding the unstamped path asserts against a URL nothing
    requests, which passes only while there is no stamp to miss.
    """
    url = worker_page.evaluate("() => window.VENDOR && window.VENDOR.font")
    assert url, "the page does not name the card font in window.VENDOR"
    return url


def test_a_worker_takes_control_of_the_page(worker_page: Page):
    """Registration happens even though start-up runs after the load event.

    pwa.js waits for `load` before registering, and start-up reaches it from a
    timer fired after DOMContentLoaded -- late enough that on a warm HTTP
    cache, which is every visit after the first, the event has already been.
    A listener added then is never called, and the app runs with no worker,
    no precache and no offline anything, saying nothing about it.
    """
    scopes = worker_page.evaluate(
        "async () => (await navigator.serviceWorker.getRegistrations())"
        ".map((r) => r.scope)"
    )
    assert scopes, "no service worker registered"
    assert any(scope.endswith("/") for scope in scopes)


def test_the_card_font_is_in_the_worker_s_cache(worker_page: Page, font_url: str):
    """The face pdfdoc.js embeds is precached, not fetched when it is needed.

    Composing a card is the one flow that reaches for an asset the page did
    not already load. Without this entry the composer fails at the font with
    the connection down, and the card -- the whole reason the app works
    offline -- is the thing that cannot be produced.
    """
    cached = worker_page.evaluate(
        """async (font) => {
          for (const name of await caches.keys()) {
            const hit = await (await caches.open(name)).match(font);
            if (hit) return (await hit.arrayBuffer()).byteLength;
          }
          return 0;
        }""",
        font_url,
    )
    assert cached > 0, "the card font is not in any cache"


def test_the_font_still_arrives_with_the_connection_down(
    worker_page: Page, font_url: str
):
    """The step the composer actually takes, taken offline.

    Asserted through `fetch` rather than by composing a card: this is the
    request that fails, and driving the print dialog to a finished PDF would
    put a template, a placement dialog and pdf-lib between the test and what
    it is about.
    """
    context = worker_page.context
    context.set_offline(True)
    try:
        size = worker_page.evaluate(
            """async (font) => {
              const response = await fetch(font);
              return response.ok ? (await response.arrayBuffer()).byteLength : 0;
            }""",
            font_url,
        )
    finally:
        context.set_offline(False)
    assert size > 0, "the font is unreachable offline"
