"""Drawing the outer boundary, which is the way into everything else.

An empty app will let you do exactly one thing, and this is it: every other
tool in the toolbar is disabled until a boundary exists, and the two other ways
to get one — the Overpass download and the place search — both need the network
this suite deliberately cuts. Outside the tour's sample area, drawing is the
whole of the app's entrance.

It is also the part with the least standing in for it. Nothing in `tests/js/`
constructs a Leaflet.Editable, and main.js says why that matters: it checks for
the library twice and logs past both failures rather than stopping, so a build
that ships without it still starts, still renders a map, and never draws. `tests/e2e/test_boot.py` would not notice — the page boots.
"""

import pytest
from playwright.sync_api import Page, expect

# Fractions of the map box. The middle, because Leaflet's own controls sit in
# the corners and the info panel is bottom-right: the toolbar is a control too,
# and a vertex dropped on it lands on the toolbar rather than on the map.
CORNERS = ((0.35, 0.35), (0.62, 0.35), (0.62, 0.60), (0.35, 0.60))


@pytest.fixture
def boundary(app_page: Page) -> Page:
    """An app with a hand-drawn boundary and no OSM data behind it.

    Which is a state a real user reaches — the download is offered, not
    assumed — and the only one this suite can reach at all, since Overpass is
    unreachable here by design.
    """
    app_page.locator('.tb-item[data-action="draw"]').click()
    # The button opens a confirmation first when there is a boundary to
    # replace. There is not, so drawing starts on the next microtask; waiting
    # for the editor rather than for a timeout keeps that an implementation
    # detail.
    app_page.wait_for_function("() => window.App.state.leafletMap.editTools.drawing()")

    box = app_page.locator("#map").bounding_box()
    assert box, "the map has no box to click into"
    for dx, dy in CORNERS:
        app_page.mouse.click(
            box["x"] + box["width"] * dx, box["y"] + box["height"] * dy
        )

    # Closing the shape is `commitDrawing()` rather than the double-click a
    # user makes. The real gesture is a click on the vertex just placed, a
    # ten-pixel target whose position moves with the zoom — and missing it adds
    # a fifth corner instead of failing, which is a flake rather than a test.
    # Every vertex above is a real click; only the full stop is programmatic.
    app_page.evaluate("() => window.App.state.leafletMap.editTools.commitDrawing()")

    prompt = app_page.locator(".app-dialog.confirm-dialog")
    expect(prompt).to_be_visible()
    prompt.locator("[data-role='cancel']").click()
    expect(prompt).to_have_count(0)
    return app_page


def test_four_clicks_and_a_close_leave_a_boundary_behind(boundary: Page):
    """The click-to-commit-to-adopt chain, which spans three files.

    Leaflet.Editable raises `editable:drawing:commit`, main.js adopts the layer
    off that event, and polygons.js is what finally holds it. Asserting on the
    layer group rather than only on the flag because `setOuterLayer` clears it
    before adding: a second boundary must replace the first, not stack on it.
    """
    assert boundary.evaluate("() => window.App.state.outerPolygonDrawn") is True
    assert (
        boundary.evaluate(
            "() => window.App.state.outerPolygonLayerGroup.getLayers().length"
        )
        == 1
    )
    expect(boundary.locator("#map svg path").first).to_be_visible()


def test_declining_the_download_still_leaves_something_printable(boundary: Page):
    """ "Not now" is an answer, and main.js is explicit about what it buys.

    The whole area becomes a single cluster, so the boundary is printable and
    exportable without ever reaching Overpass — while partitioning, which has
    nothing to divide up but the streets that were not downloaded, stays off.
    Three buttons deriving three different answers from one state is the part
    worth pinning: a `refresh()` that enabled them together would look correct
    on the sample area, where all three are live at once.
    """
    assert boundary.evaluate("() => window.App.state.clusters.length") == 1

    for action in ("print", "export"):
        expect(boundary.locator(f'.tb-item[data-action="{action}"]')).to_have_attribute(
            "aria-disabled", "false"
        )

    expect(boundary.locator('.tb-item[data-action="partition"]')).to_have_attribute(
        "aria-disabled", "true"
    )


def test_reset_puts_the_app_back_to_empty(boundary: Page):
    """The destructive path, which has no non-browser equivalent.

    `clearAll()` tears down six layer groups, stops any drawing still running
    and clears IndexedDB, and it is reached through a confirmation the tour
    deliberately bypasses — so the button, the prompt and the teardown are only
    ever wired together here.
    """
    boundary.locator('.tb-item[data-action="reset"]').click()

    prompt = boundary.locator(".app-dialog.confirm-dialog")
    expect(prompt).to_be_visible()
    prompt.locator("[data-role='ok']").click()
    expect(prompt).to_have_count(0)

    assert boundary.evaluate("() => window.App.state.outerPolygonLayer") is None
    assert boundary.evaluate("() => window.App.state.outerPolygonDrawn") is False
    assert boundary.evaluate("() => window.App.state.clusters.length") == 0
    assert (
        boundary.evaluate("() => !!window.App.state.leafletMap.editTools.drawing()")
        is False
    )

    for action in ("print", "export", "reset"):
        expect(boundary.locator(f'.tb-item[data-action="{action}"]')).to_have_attribute(
            "aria-disabled", "true"
        )
