"""Start-up, in a browser that runs the page as shipped."""

import re

from playwright.sync_api import Page, expect


def test_the_start_up_sequence_reaches_its_last_step(app_page: Page):
    """main.js initializes two dozen modules in a row, with nothing guarding it.

    Each init() ends by pushing its own name onto `App._loaded`, and the call
    sequence in `_startTranslated()` is straight-line: the first one to throw
    takes every module after it with it. So the tail of that sequence is the
    only thing worth asserting — if the toolbar, the undo stack, the tour and
    the service worker all registered, everything they were ordered after ran
    too.

    `tests/js/modules.test.mjs` covers the other half — that each file
    *registers* — but it does so with stubbed globals and without calling a
    single init(), which is where the real DOM and the real Leaflet come in.
    """
    loaded = app_page.evaluate("() => window.App._loaded")

    assert {"controls", "history", "demo", "tour", "pwa"} <= set(loaded), (
        f"start-up stopped early — it got as far as {loaded}"
    )
    assert len(loaded) == len(set(loaded)), f"a module initialized twice: {loaded}"


def test_the_page_asks_for_nothing_it_does_not_get(
    app_page: Page, broken_assets: list[str]
):
    """Missing assets are silent: the CSS, the icons and the fonts all fail soft.

    The vendor tree is regenerated from `package.json` by a CI job rather than
    committed by hand, so a renamed file inside a dependency drops an asset
    from the page without changing a line of this repository.
    """
    _ = app_page
    assert broken_assets == []


def test_booting_logs_nothing_to_the_console(app_page: Page, console_errors: list[str]):
    """main.js reports every start-up failure it survives to the console.

    A missing `#map`, a Leaflet that did not load, an Editable that refused to
    initialize — none of them stop the page, and all of them leave the app
    half-built. So does any uncaught throw from a module's own init(), which
    arrives here as a pageerror.
    """
    _ = app_page
    assert console_errors == []


def test_the_map_is_a_leaflet_map_with_ground_under_it(app_page: Page):
    """Panes, layer groups and every drawing tool hang off this one object."""
    expect(app_page.locator("#map.leaflet-container")).to_be_visible()
    expect(app_page.locator("#map img.leaflet-tile").first).to_be_visible()

    assert app_page.evaluate(
        "() => !!(window.App.state && window.App.state.leafletMap)"
    )


def test_the_toolbar_knows_what_is_not_possible_yet(app_page: Page):
    """An empty app can only be drawn on.

    controls.refresh() decides this from state on every change, and a button
    that stays enabled opens a dialog with nothing behind it. Drawing is the
    entry point and must be live; printing and partitioning need a boundary
    and downloaded data, so on a fresh page both must be off.
    """
    draw = app_page.locator('.tb-item[data-action="draw"]')
    expect(draw).to_be_visible()
    expect(draw).to_have_attribute("aria-disabled", "false")

    for action in ("print", "partition", "export"):
        expect(app_page.locator(f'.tb-item[data-action="{action}"]')).to_have_attribute(
            "aria-disabled", "true"
        )


def test_the_boot_splash_hands_the_page_over(app_page: Page):
    """The splash is in the markup and starts visible, so something must clear it.

    The failure guarded against is a page that boots perfectly and is then
    unusable behind a spinner. `app_page` waits for the same thing, so this is
    not the only place it would surface — but it is the one that says what
    broke rather than timing out in a fixture every other test shares.

    The count assertion is half the point: the element stays in the document
    and is retired by `visibility`, so a reveal that removed it instead would
    be a different mechanism passing the same visibility check.
    """
    splash = app_page.locator("#boot-splash")
    expect(splash).to_have_count(1)
    expect(splash).to_be_hidden()


def test_the_splash_does_not_wait_for_tiles(page: Page):
    """Tiles are excluded from readiness, and that is the point of the design.

    They arrive over the network in their own time and again on every pan, so
    gating the page on them would make the map undraggable for exactly as long
    as the slowest tile server felt like taking. Here none of them ever answer
    at all, and the app still has to hand the page over.

    The timeout is the assertion. `index.html.j2` arms a 10 s fail-safe that
    clears the splash whatever happens, so a deadline comfortably under that
    is what distinguishes "the app decided it was ready" from "the fail-safe
    fired". The bare `page` fixture rather than `app_page`, because the route
    has to be in place before the navigation, and `app_page` navigates itself.

    The page-level route overrides the context-level one in `hermetic`, which
    would otherwise answer every tile with a blank PNG.
    """
    page.route(re.compile(r"/tiles/"), lambda route: None)

    page.goto("/?tour=0")
    expect(page.locator(".tb-panel")).to_be_visible()
    expect(page.locator("#boot-splash")).to_be_hidden(timeout=6000)


def test_a_module_that_throws_still_hands_the_page_over(page: Page):
    """The failure mode the splash introduced, and the one it must not have.

    `_startTranslated()` wires two dozen modules in a straight line with
    nothing guarding it, so the first init() to throw takes the rest of the
    sequence with it. A half-built page is the accepted outcome of that; a
    half-built page with a spinner parked over it, unreachable until the
    fail-safe expires ten seconds later, is not.

    demo.js is replaced with a module that throws from init(), which lands
    after controls.init() — so the toolbar exists and the page is genuinely
    usable, which is the whole argument for revealing it.
    """
    page.route(
        re.compile(r"/js/demo\.js$"),
        lambda route: route.fulfill(
            content_type="application/javascript",
            body=(
                "window.App = window.App || {};"
                "App.demo = { init: function () { throw new Error('boom'); } };"
            ),
        ),
    )

    page.goto("/?tour=0")
    expect(page.locator(".tb-panel")).to_be_visible()
    expect(page.locator("#boot-splash")).to_be_hidden(timeout=6000)


def test_the_info_panel_asks_for_a_polygon(app_page: Page):
    """The only instruction a first-time visitor gets once the tour is gone."""
    expect(app_page.locator("#info-panel [data-role='title']")).to_have_text(
        re.compile(r"\S")
    )
    expect(app_page.locator("#info-panel [data-role='stats']")).to_be_hidden()


def test_the_shortcut_sheet_answers_for_the_mode_you_are_in(app_page: Page):
    """The sheet is reached by a symbol, which is what makes it worth a test.

    "?" is Shift+/ on English layout and Shift+ß on a German one, and the browser
    reports the symbol with shiftKey still true either way — so the binding
    accepts Shift for symbols and rejects it everywhere else. Pressed here as
    the physical gesture rather than as a character, which is the half a
    keydown built by hand in a Node test cannot check.
    """
    app_page.keyboard.press("Shift+Slash")

    sheet = app_page.locator(".app-dialog.shortcuts-dialog")
    expect(sheet).to_be_visible()
    expect(sheet.locator(".shortcuts-item").first).to_be_visible()

    app_page.keyboard.press("Escape")
    expect(sheet).to_have_count(0)


def test_the_page_says_which_build_it_is(app_page: Page):
    """Both numbers, on the page, without a console.

    The banner is the answer to "which version are you on" in a bug report, so
    it has to survive the trip those numbers make to get there: two files read
    at import, a dict handed to the template, and markup rendered before any of
    the client's scripts run. A number lost anywhere along that path renders as
    an empty span, which is exactly the kind of nothing nobody notices.

    Read as text rather than against the versions themselves — what the server
    resolved is `tests/test_version.py`'s subject, and this one is about the
    corner of the screen.
    """
    banner = app_page.locator("#version-banner")
    expect(banner).to_be_visible()

    for part, label in (("server", "Server"), ("client", "Client")):
        row = banner.locator(f".version-banner__part:has([data-i18n='version.{part}'])")
        expect(row.locator(".version-banner__label")).to_have_text(label)
        expect(row.locator(".version-banner__value")).to_have_text(re.compile(r"^\S+$"))


def test_the_build_number_does_not_cost_a_pan(app_page: Page):
    """The map is dragged from anywhere on it, and the banner is on it.

    A fixed box over the bottom-left corner takes the pointer events landing
    there unless it is told not to, and a drag that starts on it then does
    nothing at all — a corner of the map that has quietly stopped working, with
    nothing on screen to say why. `pointer-events: none` in style.css is the
    only thing between here and that, and it is one line that a later edit can
    drop without any other test noticing.
    """
    box = app_page.locator("#version-banner").bounding_box()
    assert box

    hit = app_page.evaluate(
        "point => { const node = document.elementFromPoint(point.x, point.y);"
        " return node && node.closest('#version-banner') ? 'banner' : 'map'; }",
        {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2},
    )
    assert hit == "map", "the banner is taking the pointer events over the map"
