"""Editing a mark by its handles, which is a thing only a real map can do.

The geometry these gestures produce is pinned in `tests/js/notes.test.mjs`,
where a skeleton can be handed to the module directly. What cannot be checked
there is the half of it that is Leaflet's: that a handle is on screen where the
point is, that dragging one moves that point and not the map underneath it, and
that a click on one is told apart from a drag of it.
"""

import pytest
from playwright.sync_api import Page, expect

# Where the three points of the mark every test starts from are clicked,
# measured from the map's top-left corner. Far enough apart that no two
# handles overlap at the default zoom.
POINTS = ((420, 220), (620, 240), (720, 380))


def draw_a_mark(page: Page) -> None:
    """Open the notes tool, pick the draw pen, click out a three-point mark."""
    page.evaluate("() => window.App.notes.toggle()")
    page.wait_for_selector(".notes-toolbar")
    page.keyboard.press("3")

    box = page.locator("#map").bounding_box()
    assert box
    for x, y in POINTS:
        page.mouse.click(box["x"] + x, box["y"] + y)
        page.wait_for_timeout(120)

    page.keyboard.press("Enter")
    page.fill(".note-dialog textarea", "Odd numbers")
    page.evaluate(
        "() => document.querySelector('.note-dialog [data-role=save]').click()"
    )
    expect(page.locator(".note-dialog")).to_have_count(0)


@pytest.fixture
def marked(app_page: Page) -> Page:
    draw_a_mark(app_page)
    return app_page


def nodes(page: Page) -> list[dict[str, float]]:
    return page.evaluate("() => window.App.notes.all()[0].nodes")


def test_a_mark_wears_a_handle_on_every_point(marked: Page):
    """One to move, and one between each pair to bend the hop.

    The handles are the polygon editor's own, which is the point: the same
    shape means the same gesture, and a mark is corrected the way a territory
    is.
    """
    assert len(nodes(marked)) == 3
    expect(marked.locator(".leaflet-vertex-icon")).to_have_count(3)
    expect(marked.locator(".leaflet-middle-icon")).to_have_count(2)

    # They belong to the pen, not to the map: another pen is not editing
    # geometry, and handles left behind would be handles for a gesture that no
    # longer does anything.
    marked.keyboard.press("1")
    expect(marked.locator(".leaflet-vertex-icon")).to_have_count(0)


def test_dragging_a_handle_moves_its_point(marked: Page):
    before = nodes(marked)

    handle = marked.locator(".leaflet-vertex-icon").nth(1).bounding_box()
    assert handle
    marked.mouse.move(
        handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
    )
    marked.mouse.down()
    marked.mouse.move(handle["x"] + 70, handle["y"] - 90, steps=10)
    marked.mouse.up()
    marked.wait_for_timeout(200)

    after = nodes(marked)
    assert after[1]["at"] != before[1]["at"]
    # And only that one: a drag moves a point, not the mark it is on.
    assert after[0]["at"] == before[0]["at"]
    assert after[2]["at"] == before[2]["at"]


def test_a_middle_handle_bends_its_hop(marked: Page):
    straight = marked.evaluate("() => window.App.notes.all()[0].points.length")

    handle = marked.locator(".leaflet-middle-icon").first.bounding_box()
    assert handle
    marked.mouse.move(
        handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
    )
    marked.mouse.down()
    # Upward: the notes bar sits along the bottom of the map, and a handle
    # dragged under it is a handle the next click cannot reach.
    marked.mouse.move(handle["x"], handle["y"] - 110, steps=10)
    marked.mouse.up()
    marked.wait_for_timeout(200)

    assert nodes(marked)[1]["bend"], "the hop kept no control point"
    # A curve is drawn as a run of short hops, so the geometry the card reads
    # grew even though nobody added a point.
    grown = marked.evaluate("() => window.App.notes.all()[0].points.length")
    assert grown > straight

    # And putting it back is one click on the same handle.
    marked.locator(".leaflet-middle-icon").first.click()
    marked.wait_for_timeout(200)
    assert not nodes(marked)[1]["bend"]


def test_a_click_on_a_handle_takes_its_point_out(marked: Page):
    marked.locator(".leaflet-vertex-icon").nth(1).click()
    marked.wait_for_timeout(200)
    assert len(nodes(marked)) == 2

    # Never below two, which is the fewest a line can be drawn between. A mark
    # is deleted from its own menu rather than dismantled.
    marked.locator(".leaflet-vertex-icon").first.click()
    marked.wait_for_timeout(200)
    assert len(nodes(marked)) == 2


def test_freeform_draws_only_what_the_hand_does(app_page: Page):
    """No click places anything, so no mark can come out with a straight hop.

    And nothing on a swept mark is a handle: the hop is a run of samples of
    where the hand went, and moving one end of it would leave the rest behind.
    """
    app_page.evaluate("() => window.App.notes.toggle()")
    app_page.wait_for_selector(".notes-toolbar")
    app_page.keyboard.press("3")
    app_page.keyboard.press("F")

    snap = app_page.locator(".notes-toolbar [data-role='snap']")
    expect(snap).to_be_disabled()

    box = app_page.locator("#map").bounding_box()
    assert box
    app_page.mouse.click(box["x"] + 300, box["y"] + 160)
    app_page.wait_for_timeout(200)
    assert app_page.evaluate("() => window.App.notes.count()") == 0

    app_page.mouse.move(box["x"] + 250, box["y"] + 200)
    app_page.mouse.down()
    for step in range(1, 20):
        app_page.mouse.move(
            box["x"] + 250 + step * 14, box["y"] + 200 + (step % 4) * 10
        )
    app_page.mouse.up()
    app_page.wait_for_timeout(300)
    app_page.fill(".note-dialog textarea", "Swept")
    app_page.evaluate(
        "() => document.querySelector('.note-dialog [data-role=save]').click()"
    )

    mark = app_page.evaluate("() => window.App.notes.all()[0]")
    assert len(mark["points"]) > 5
    assert len(mark["nodes"]) == 2
    expect(app_page.locator(".leaflet-vertex-icon")).to_have_count(0)
