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
