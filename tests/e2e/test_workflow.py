"""The sample territory, driven through the real app.

`tests/js/demo.test.mjs` checks the sample is well-formed before anything
receives it. What it cannot check is the receiving: applyPayload() building
Leaflet layers, the clustering module counting them, the info panel and the
toolbar re-deriving what is possible now, and the print dialog composing a
preview from them.

The sample is the only data this suite can use — everything else in the app
starts with an Overpass download — and it is also the data every first-time
visitor sees, so a failure here is a failure of the tour as well.

The whole sample-in / sample-out cycle is asserted rather than just the load:
`demo.leave()` is what puts a real user's afternoon of work back after the
tour, and a leak in it is the most expensive bug this app could have.
"""

import pytest
from playwright.sync_api import Page, expect


@pytest.fixture
def sample(app_page: Page) -> Page:
    """An app holding the tour's sample village, exactly as the tour loads it."""
    assert app_page.evaluate("() => window.App.demo.enter()") is True, (
        "the sample area refused to load"
    )
    expect(app_page.locator("#info-panel [data-role='stats']")).to_be_visible()
    return app_page


def test_the_sample_reaches_the_map_the_panel_and_the_toolbar(sample: Page):
    """One payload, three places that have to agree about it.

    The counts are read back from the sample itself rather than written down
    here: what is asserted is that nothing was lost between generating it and
    displaying it, which is a property of the pipeline and not of the village.
    """
    expected = sample.evaluate(
        """() => {
            const sample = window.App.demo.payload();
            return {
                streets: sample.streets.features.length,
                buildings: sample.buildings.features.length,
                clusters: sample.clusters.length,
            };
        }"""
    )
    assert min(expected.values()) > 0, "the sample itself is empty"

    panel = sample.locator("#info-panel")
    expect(panel.locator("[data-role='streets']")).to_have_text(
        str(expected["streets"])
    )
    expect(panel.locator("[data-role='buildings']")).to_have_text(
        str(expected["buildings"])
    )
    expect(panel.locator("[data-role='clusters']")).to_have_text(
        str(expected["clusters"])
    )
    assert (
        sample.evaluate("() => window.App.state.clusters.length")
        == expected["clusters"]
    )

    # Everything that needs a boundary and data underneath it is live now.
    for action in ("print", "partition", "export"):
        expect(sample.locator(f'.tb-item[data-action="{action}"]')).to_have_attribute(
            "aria-disabled", "false"
        )


def test_leaving_the_sample_puts_the_app_back_as_it_was(sample: Page):
    """A first-time visitor has nothing to restore, so empty is what "back" is."""
    assert sample.evaluate("() => window.App.demo.leave()") is True

    assert sample.evaluate("() => window.App.demo.isActive()") is False
    assert sample.evaluate("() => window.App.state.clusters.length") == 0
    assert sample.evaluate("() => window.App.state.outerPolygonLayer") is None

    expect(sample.locator("#info-panel [data-role='stats']")).to_be_hidden()
    expect(sample.locator('.tb-item[data-action="print"]')).to_have_attribute(
        "aria-disabled", "true"
    )


def test_a_card_is_two_clicks_from_a_loaded_territory(sample: Page):
    """The toolbar's print button opens the list, and the list prints a row.

    Which is the app's whole point — every other feature exists to get a
    territory into a state worth walking with. Only that the preview opens and
    composes is asserted; what ends up on the page is pdfdoc.js's business,
    and `tests/js/pdfdoc.test.mjs` can ask about it far more precisely than a
    canvas in a headless browser can answer.
    """
    sample.locator('.tb-item[data-action="print"]').click()

    rows = sample.locator(".territory-list .territory-row-wrap")
    expect(rows.first).to_be_visible()
    assert rows.count() == sample.evaluate("() => window.App.state.clusters.length")

    rows.first.locator("[data-role='print']").click()

    dialog = sample.locator(".app-dialog.print-dialog")
    expect(dialog).to_be_visible()
    expect(dialog.locator("canvas")).to_be_visible()
    # The preview draws once the tiles behind it are in; until then the dialog
    # shows a counter, which is the state a broken compose would stay in.
    expect(dialog.locator("[data-role='status']")).to_be_hidden(timeout=30_000)

    sample.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
