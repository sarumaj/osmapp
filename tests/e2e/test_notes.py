"""Drawing and correcting a mark, which is a thing only a real map can do.

The geometry these gestures produce is pinned in `tests/js/notes.test.mjs`,
where a skeleton can be handed to the module directly. What cannot be checked
there is the half of it that is Leaflet's: that a handle is on screen where the
point is, that dragging one moves that point and not the map underneath it, and
that a click on one is told apart from a drag of it.

Two more live here for the same reason, and they are about what the pen must
*not* draw: a cancelled line has to leave nothing behind, and a press on the
furniture the app lays over the map -- a toolbar, a banner, a dialog -- is not
a press on the ground under it. Both are questions about which element an
event reached, so neither has an answer outside a browser.
"""

import pytest
from playwright.sync_api import FloatRect, Page, expect

# Where the three points of the mark every test starts from are clicked,
# measured from the map's top-left corner. Far enough apart that no two
# handles overlap at the default zoom, and clear of the tool panel: that panel
# is mounted inside the map container, and a gesture on it is a gesture on the
# furniture rather than on the ground.
POINTS = ((420, 220), (620, 240), (720, 380))

# Where a freehand sweep is drawn, as a start and a step. Same rule: on the
# map, not on anything the app has laid over it.
SWEEP_FROM = (420, 300)
SWEEP_STEP = 14


def open_the_pen(page: Page) -> FloatRect:
    """Open the notes tool with the draw pen out, and return the map's box."""
    page.evaluate("() => window.App.notes.toggle()")
    page.wait_for_selector(".notes-toolbar")
    page.keyboard.press("3")
    box = page.locator("#map").bounding_box()
    assert box is not None
    return box


def click_out_a_line(page: Page, box: FloatRect) -> None:
    """Place the three points of POINTS, leaving the line open."""
    for x, y in POINTS:
        page.mouse.click(box["x"] + x, box["y"] + y)
        page.wait_for_timeout(120)


def draw_a_mark(page: Page) -> None:
    """Open the notes tool, pick the draw pen, click out a three-point mark."""
    click_out_a_line(page, open_the_pen(page))
    page.keyboard.press("Enter")
    page.fill(".note-dialog textarea", "Odd numbers")
    page.locator(".note-dialog [data-role=save]").click()
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
    box = open_the_pen(app_page)
    app_page.keyboard.press("F")

    snap = app_page.locator(".notes-toolbar [data-role='snap']")
    expect(snap).to_be_disabled()

    start_x, start_y = SWEEP_FROM
    app_page.mouse.click(box["x"] + start_x, box["y"] + start_y - 120)
    app_page.wait_for_timeout(200)
    assert app_page.evaluate("() => window.App.notes.count()") == 0

    app_page.mouse.move(box["x"] + start_x, box["y"] + start_y)
    app_page.mouse.down()
    for step in range(1, 20):
        app_page.mouse.move(
            box["x"] + start_x + step * SWEEP_STEP,
            box["y"] + start_y + (step % 4) * 10,
        )
    app_page.mouse.up()
    app_page.wait_for_timeout(300)
    app_page.fill(".note-dialog textarea", "Swept")
    app_page.locator(".note-dialog [data-role=save]").click()

    mark = app_page.evaluate("() => window.App.notes.all()[0]")
    assert len(mark["points"]) > 5
    assert len(mark["nodes"]) == 2
    expect(app_page.locator(".leaflet-vertex-icon")).to_have_count(0)


def test_escape_takes_the_half_drawn_line_off_the_map(app_page: Page):
    """A cancelled line leaves nothing behind, dots included.

    The dots live in a layer of their own, so that the pen can put them up and
    take them down without redrawing the marks underneath - which is also how
    a discard that only removed the dashed preview left a row of points on the
    map with no line through them and no record behind them.
    """
    box = open_the_pen(app_page)
    click_out_a_line(app_page, box)
    expect(app_page.locator(".note-handle--draft")).to_have_count(3)

    app_page.keyboard.press("Escape")
    app_page.wait_for_timeout(200)

    expect(app_page.locator(".note-handle--draft")).to_have_count(0)
    assert app_page.evaluate("() => window.App.notes.count()") == 0
    # One step, not two: Escape backs out of the line, not out of the pen.
    expect(app_page.locator(".notes-toolbar")).to_have_count(1)


def test_the_furniture_over_the_map_is_not_the_map(app_page: Page):
    """A press on the bar or on a dialog is not a press on the ground.

    Both are mounted inside the map container, which is where the pen listens
    for its pointer events, and Leaflet only silences the mouse events it
    knows about there. So reaching for Save was also a press on the map: it
    placed a vertex beneath the dialog, opened a line nobody started, and took
    the caret away from the textarea on the way past.
    """
    box = open_the_pen(app_page)
    click_out_a_line(app_page, box)
    app_page.keyboard.press("Enter")

    # Typed and saved with the mouse, the way somebody would.
    app_page.locator(".note-dialog textarea").click()
    app_page.keyboard.type("Odd numbers")
    app_page.locator(".note-dialog [data-role=save]").click()
    expect(app_page.locator(".note-dialog")).to_have_count(0)
    app_page.wait_for_timeout(200)

    assert app_page.evaluate("() => window.App.notes.count()") == 1
    assert app_page.evaluate("() => window.App.notes.all()[0].text") == "Odd numbers"
    expect(app_page.locator(".note-handle--draft")).to_have_count(0)
    # Which the bar says too: the Finish button is only up while a line is.
    expect(app_page.locator(".notes-toolbar [data-role=finish]")).to_be_hidden()

    # And the bar itself: every button on it is a press on the map behind it.
    app_page.locator(".notes-toolbar [data-role='tool-pin']").click()
    app_page.locator(".notes-toolbar [data-role='tool-draw']").click()
    app_page.wait_for_timeout(200)
    assert app_page.evaluate("() => window.App.notes.count()") == 1
    expect(app_page.locator(".note-handle--draft")).to_have_count(0)


def draft_dots(page: Page) -> int:
    return page.locator(".note-handle--draft").count()


def test_undo_steps_back_through_the_line_being_drawn(app_page: Page):
    """Ctrl+Z belongs to the mark under the hand, not to the ones behind it.

    Which is the cut tool's rule: a half-drawn line is not a document, it is
    the gesture that will make one, and taking back the point just placed must
    not reach past it into notes that are already finished.
    """
    box = open_the_pen(app_page)
    click_out_a_line(app_page, box)
    assert draft_dots(app_page) == 3

    app_page.keyboard.press("Control+z")
    app_page.keyboard.press("Control+z")
    assert draft_dots(app_page) == 1

    app_page.keyboard.press("Control+y")
    assert draft_dots(app_page) == 2

    # Back past the first point and forward again. The line is off the map in
    # between, and the steps that made it have to survive that: they are what
    # the next Ctrl+Y puts back.
    app_page.keyboard.press("Control+z")
    app_page.keyboard.press("Control+z")
    assert draft_dots(app_page) == 0
    app_page.keyboard.press("Control+y")
    assert draft_dots(app_page) == 1

    # Forward to all three and store the mark.
    app_page.keyboard.press("Control+y")
    app_page.keyboard.press("Control+y")
    assert draft_dots(app_page) == 3
    app_page.keyboard.press("Enter")
    app_page.fill(".note-dialog textarea", "Odd numbers")
    app_page.locator(".note-dialog [data-role=save]").click()
    expect(app_page.locator(".note-dialog")).to_have_count(0)
    assert app_page.evaluate("() => window.App.notes.count()") == 1

    # With no line in progress the same key answers for the note list again -
    # twice, because storing the mark and writing on it are two edits to it.
    app_page.keyboard.press("Control+z")
    app_page.keyboard.press("Control+z")
    app_page.wait_for_timeout(200)
    assert app_page.evaluate("() => window.App.notes.count()") == 0


def test_a_sweep_is_one_step_to_take_back(app_page: Page):
    """A hand-drawn hop goes back whole, under Ctrl+Z and under Backspace.

    It reaches the skeleton as one node or two depending on whether the line
    was already open, so a step that took back a node would sometimes take
    back half a sweep - a start point with nothing drawn from it, which is not
    a step anybody took.
    """
    box = open_the_pen(app_page)
    app_page.mouse.click(box["x"] + POINTS[0][0], box["y"] + POINTS[0][1])
    app_page.wait_for_timeout(120)

    start_x, start_y = SWEEP_FROM
    app_page.mouse.move(box["x"] + start_x, box["y"] + start_y)
    app_page.mouse.down()
    for step in range(1, 20):
        app_page.mouse.move(
            box["x"] + start_x + step * SWEEP_STEP,
            box["y"] + start_y + (step % 4) * 10,
        )
    app_page.mouse.up()
    app_page.wait_for_timeout(200)
    assert draft_dots(app_page) == 2

    app_page.keyboard.press("Control+z")
    assert draft_dots(app_page) == 1

    # And Backspace is the same step, not a smaller one.
    app_page.keyboard.press("Control+y")
    assert draft_dots(app_page) == 2
    app_page.keyboard.press("Backspace")
    assert draft_dots(app_page) == 1


def test_a_notes_words_reach_a_tooltip_as_words(app_page: Page):
    """Leaflet assigns tooltip content straight to innerHTML.

    Which makes a note's text markup unless something escapes it, and the text
    is not necessarily this user's: restore() takes it out of a project file,
    and a project file is handed around - it is what a printed card carries and
    what an export is for. So the check is that the tag arrives as the
    characters somebody typed rather than as an element.
    """
    app_page.evaluate(
        """() => window.App.notes.restore([
            {
              kind: "pin",
              points: [[8.54, 47.37]],
              text: "<img src=x onerror=\\"window.__ran = true\\">back gate",
              color: "#d40000",
              width: 2,
            },
        ])"""
    )
    app_page.locator(".note-marker--pin").first.hover()
    tooltip = app_page.locator(".note-tooltip")
    expect(tooltip).to_be_visible()

    assert tooltip.locator("img").count() == 0
    assert "back gate" in tooltip.inner_text()
    assert app_page.evaluate("() => window.__ran === true") is False


def test_changing_pen_hands_undo_back_to_the_note_list(app_page: Page):
    """A line stepped back to nothing still owns undo until it is given up.

    Which is right while the pen is still out - redo is what puts it back -
    and wrong the moment another tool is chosen: there the stacks are left
    holding a line with no preview, and Ctrl+Z steps that instead of taking
    back the note just placed.
    """
    box = open_the_pen(app_page)
    app_page.mouse.click(box["x"] + POINTS[0][0], box["y"] + POINTS[0][1])
    app_page.wait_for_timeout(120)
    assert draft_dots(app_page) == 1

    app_page.keyboard.press("Control+z")
    assert draft_dots(app_page) == 0

    # The pin tool, and then a pin.
    app_page.keyboard.press("2")
    app_page.mouse.click(box["x"] + POINTS[1][0], box["y"] + POINTS[1][1])
    app_page.fill(".note-dialog textarea", "back gate")
    app_page.locator(".note-dialog [data-role=save]").click()
    expect(app_page.locator(".note-dialog")).to_have_count(0)
    assert app_page.evaluate("() => window.App.notes.count()") == 1

    app_page.keyboard.press("Control+z")
    app_page.wait_for_timeout(200)
    assert app_page.evaluate("() => window.App.notes.count()") == 0
