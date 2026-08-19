"""The territory list, and the repair button on its rows."""

import pytest
from playwright.sync_api import Locator, Page, expect

# One territory per grid cell, clipped to the outer boundary. Cells out in the
# fields hold no buildings, and a cell the boundary re-enters comes out in
# several pieces — the two faults autoheal exists for, from one operation.
GRID = """() => {
  const A = window.App, G = A.geometry, s = A.state;
  const outer = G.getOuterFeature(s.outerPolygonLayer);
  const bb = turf.bbox(outer);
  const cols = 7, rows = 5;
  const out = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const cell = turf.bboxPolygon([
        bb[0] + ((bb[2] - bb[0]) * i) / cols,
        bb[1] + ((bb[3] - bb[1]) * j) / rows,
        bb[0] + ((bb[2] - bb[0]) * (i + 1)) / cols,
        bb[1] + ((bb[3] - bb[1]) * (j + 1)) / rows,
      ]);
      let piece = null;
      try { piece = G.intersect(outer, cell); } catch (e) { piece = null; }
      if (!piece || !piece.geometry) continue;
      out.push({ type: "Feature", properties: {}, geometry: piece.geometry });
    }
  }
  A.polygons.setClusters(out);
  return s.clusters.length;
}"""

# What is on the map, in a form that changes whenever any territory does.
SHAPES = """() => window.App.polygons.clusterFeatures()
  .map((f) => JSON.stringify(f.geometry).length).join(",")"""

WANDS = ".territory-row__fix:not([hidden])"
OUTCOME = "[data-role='outcome']"


def repair(page: Page, wand: Locator) -> None:
    """Click one repair button and wait for the rebuilt list.

    The outcome line is blanked first because it is the completion signal, and
    it still holds the previous repair's sentence until the next one lands —
    waiting on it without clearing it returns immediately and every assertion
    after that races the re-render.
    """
    page.locator(OUTCOME).evaluate("(node) => { node.textContent = ''; }")
    wand.click()
    expect(page.locator(OUTCOME)).not_to_be_empty()


@pytest.fixture
def gridded(app_page: Page) -> Page:
    """The sample village cut into a grid, with the list dialog open."""
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")

    assert app_page.evaluate(GRID) > 10, "the grid produced nothing to work with"
    app_page.evaluate("() => window.App.labels.openList()")
    expect(app_page.locator(".territory-list")).to_be_visible()
    return app_page


def test_every_repair_button_on_offer_actually_repairs(gridded: Page):
    """The complaint this file was written for.

    Each button is clicked and the map is compared with itself before and
    after. A button that leaves every territory exactly as it was is the bug:
    it is an offer the app cannot keep, and it teaches people to distrust the
    buttons that work.

    Bounded by a loop count rather than by `while`, so a repair that somehow
    re-offers itself fails as a timeout in the assertion below instead of
    hanging the suite.
    """
    idle: list[str] = []
    for _ in range(40):
        wands = gridded.locator(WANDS)
        if wands.count() == 0:
            break
        before = gridded.evaluate(SHAPES)
        repair(gridded, wands.first)
        if gridded.evaluate(SHAPES) == before:
            idle.append(gridded.locator(OUTCOME).inner_text())

    assert idle == [], f"buttons that changed nothing: {idle}"
    assert gridded.locator(WANDS).count() == 0, "the list never settled"


def test_repairing_a_row_keeps_the_reading_position(gridded: Page):
    """Scroll and focus belong to the person reading, not to the data."""
    rows = gridded.locator("[data-role='rows']")
    assert rows.evaluate("(r) => r.scrollHeight > r.clientHeight"), (
        "the list has to overflow for this to be a test"
    )

    rows.evaluate(
        "(r) => { r.scrollTop = Math.floor((r.scrollHeight - r.clientHeight) / 2); }"
    )

    # A button already inside the visible part of the box: clicking one below
    # the fold makes Playwright scroll the list itself, and the assertion would
    # then be measuring its own scrolling.
    visible = gridded.evaluate(
        """(sel) => {
            const r = document.querySelector("[data-role='rows']");
            const box = r.getBoundingClientRect();
            return [...document.querySelectorAll(sel)].findIndex((w) => {
                const b = w.getBoundingClientRect();
                return b.top >= box.top && b.bottom <= box.bottom;
            });
        }""",
        WANDS,
    )
    assert visible >= 0, "no repair button was in view to click"

    before = rows.evaluate("(r) => r.scrollTop")
    repair(gridded, gridded.locator(WANDS).nth(visible))

    assert rows.evaluate("(r) => r.scrollTop") == before, "the list jumped"
    assert gridded.evaluate(
        "() => !!(document.activeElement && document.activeElement.closest('.territory-list'))"
    ), "the focus fell out of the dialog, so the next Tab starts from the page"


def test_fix_all_leaves_the_keyboard_where_it_was(gridded: Page):
    """The list-wide button is about the list, so it comes back to itself.

    Not to the first row: "Fix all" is one keystroke away from being pressed
    again, and after a repair that resolved some rows but not all of them,
    pressing it again is exactly what someone is about to do.
    """
    fix_all = gridded.locator("[data-role='fix-all']")
    expect(fix_all).to_be_visible()

    gridded.locator(OUTCOME).evaluate("(node) => { node.textContent = ''; }")
    fix_all.click()
    expect(gridded.locator(OUTCOME)).not_to_be_empty()

    landed = gridded.evaluate(
        "() => document.activeElement && document.activeElement.getAttribute('data-role')"
    )
    assert landed in ("fix-all", "close"), f"the focus went to {landed}"


def test_the_dialog_is_navigable_without_looking_at_it(gridded: Page):
    """The parts that only exist for somebody who cannot see the colors.

    The flags are the whole point of the row — a green check, an orange puzzle
    piece, a blue house — and every one of them is a color plus an <i> with no
    role, which is decoration as far as an accessibility tree is concerned.
    """
    dialog = gridded.locator(".territory-list")
    named_by = dialog.get_attribute("aria-labelledby")
    assert named_by, "a modal dialog with no accessible name"
    expect(gridded.locator(f"#{named_by}")).not_to_be_empty()

    expect(gridded.locator("[data-role='rows']")).to_have_attribute("role", "list")
    assert gridded.locator(
        ".territory-row-wrap[role='listitem']"
    ).count() == gridded.evaluate("() => window.App.state.clusters.length")

    flags = gridded.locator(".territory-row__flag")
    assert flags.count() > 0, "the grid was supposed to produce flagged rows"
    spoken = gridded.locator(".territory-row__flag[role='img']")
    assert flags.count() == spoken.count(), "a flag that is not a picture"
    for i in range(flags.count()):
        assert flags.nth(i).get_attribute("aria-label"), (
            "a flag with nothing to announce"
        )

    status = gridded.locator(OUTCOME)
    expect(status).to_have_attribute("role", "status")
    expect(status).to_be_empty()

    repair(gridded, gridded.locator(WANDS).first)


# ══════════════════════════════════════════════════════════════════════════════
# FINDING ONE ROW AMONG NINETY-NINE
# ══════════════════════════════════════════════════════════════════════════════


def flagged_rows(page: Page) -> Locator:
    return page.locator(".territory-row-wrap[data-flagged='1']")


def chip(page: Page, axis: str) -> Locator:
    return page.locator(f".territory-list__chip[data-axis='{axis}']")


def cycle(page: Page, axis: str, to: str) -> None:
    """Click a filter chip until it reaches `to` — any, only or not.

    Clicking rather than setting state, because the cycle is the interaction
    under test: three states on one control only works if each press lands
    where the last one implies.
    """
    for _ in range(4):
        if chip(page, axis).get_attribute("data-state") == to:
            return
        chip(page, axis).click()
    raise AssertionError(f"the {axis} chip never reached {to}")


def test_the_filter_narrows_the_list_to_what_needs_attention(gridded: Page):
    """The reason the filter exists.

    A real partition is ninety-nine territories with one fault in it, and the
    only way to reach that one row is to scroll looking for an orange icon.
    """
    rows = gridded.locator(".territory-row-wrap")
    everything = rows.count()
    with_issues = flagged_rows(gridded).count()
    assert 0 < with_issues < everything, (
        "the grid was supposed to flag some but not all"
    )

    cycle(gridded, "repair", "only")

    assert rows.count() == with_issues
    assert flagged_rows(gridded).count() == with_issues, "and they are the flagged ones"
    # The count above the list has to say that it is a filtered count.
    assert str(everything) in gridded.locator("[data-role='total']").inner_text()


def test_a_filter_that_matches_nothing_says_so(gridded: Page):
    """ "There are none" and "none of them match" are different answers.

    Nothing in the sample has been printed, so filtering to the printed ones
    empties the list — and answering that with "No territories yet" sends
    somebody looking for territories that are sitting right there.
    """
    cycle(gridded, "printed", "only")

    assert gridded.locator(".territory-row-wrap").count() == 0
    expect(gridded.locator("[data-role='no-match']")).to_be_visible()
    expect(gridded.locator("[data-role='empty']")).to_be_hidden()


def test_the_jump_button_walks_the_flagged_rows(gridded: Page):
    """A locator for the list, so the keyboard lands where the eye would."""
    jump = gridded.locator("[data-role='jump']")
    expect(jump).to_be_visible()
    total = flagged_rows(gridded).count()
    assert jump.inner_text().strip() == str(total), "the button counts what it walks"

    visited: list[str] = []
    for _ in range(total + 1):
        jump.click()
        landed = gridded.evaluate(
            """() => {
                const a = document.activeElement;
                const row = a && a.closest && a.closest('.territory-row-wrap');
                return row ? row.dataset.territory : null;
            }"""
        )
        assert landed is not None, "the jump did not put the focus on a row"
        assert (
            gridded.locator(
                f".territory-row-wrap[data-territory='{landed}']"
            ).get_attribute("data-flagged")
            == "1"
        ), "it landed on a row with nothing wrong with it"
        visited.append(landed)

    assert len(set(visited[:total])) == total, "it visited the same row twice"
    assert visited[total] == visited[0], "and it wrapped instead of stopping"


def test_jumping_works_from_the_keyboard(gridded: Page):
    """J, registered in the list's own shortcut group next to N and Escape."""
    gridded.keyboard.press("j")

    landed = gridded.evaluate(
        """() => {
            const a = document.activeElement;
            const row = a && a.closest && a.closest('.territory-row-wrap');
            return row ? row.dataset.flagged : null;
        }"""
    )
    assert landed == "1"


def test_the_walk_follows_the_filter(gridded: Page):
    """The two compose rather than fight.

    Narrow to the printed ones and there is nothing flagged left to walk, so
    the button goes away instead of quietly jumping to a row the filter is
    hiding.
    """
    cycle(gridded, "printed", "only")
    expect(gridded.locator("[data-role='jump']")).to_be_hidden()


# ══════════════════════════════════════════════════════════════════════════════
# THREE ANSWERS PER QUESTION
# ══════════════════════════════════════════════════════════════════════════════


def test_a_chip_cycles_through_its_three_states(gridded: Page):
    """Don't care, only these, only the others, and back.

    The third state is the one a drop-down could not offer without a second
    entry per axis, and it is the one that answers "which of these have I not
    dealt with yet".
    """
    rows = gridded.locator(".territory-row-wrap")
    everything = rows.count()
    with_issues = flagged_rows(gridded).count()
    assert 0 < with_issues < everything

    expect(chip(gridded, "repair")).to_have_attribute("data-state", "any")
    expect(chip(gridded, "repair")).to_have_attribute("aria-pressed", "false")

    chip(gridded, "repair").click()
    expect(chip(gridded, "repair")).to_have_attribute("data-state", "only")
    expect(chip(gridded, "repair")).to_have_attribute("aria-pressed", "true")
    assert rows.count() == with_issues

    chip(gridded, "repair").click()
    expect(chip(gridded, "repair")).to_have_attribute("data-state", "not")
    expect(chip(gridded, "repair")).to_have_attribute("aria-pressed", "true")
    assert rows.count() == everything - with_issues

    chip(gridded, "repair").click()
    expect(chip(gridded, "repair")).to_have_attribute("data-state", "any")
    assert rows.count() == everything


def test_the_chips_combine(gridded: Page):
    """Separate questions, so the answers stack.

    "Not printed, and nothing wrong with it" is the set somebody works
    through, and no single-choice control can express it.
    """
    cycle(gridded, "repair", "not")
    healthy = gridded.locator(".territory-row-wrap").count()

    cycle(gridded, "printed", "not")
    both = gridded.locator(".territory-row-wrap").count()

    # Nothing in the sample is printed, so adding "not printed" cannot remove
    # anything — but it must still be the intersection rather than a reset.
    assert both == healthy
    expect(chip(gridded, "repair")).to_have_attribute("data-state", "not")
    expect(chip(gridded, "printed")).to_have_attribute("data-state", "not")


def test_a_chip_says_which_state_it_is_in(gridded: Page):
    """The label carries the state, so the color is not the only channel."""
    labels: list[str] = []
    for _ in range(3):
        labels.append(chip(gridded, "repair").inner_text().strip())
        chip(gridded, "repair").click()

    assert len(set(labels)) == 3, f"the label never changed: {labels}"
    assert all(labels), "a chip with no words on it"


# ══════════════════════════════════════════════════════════════════════════════
# PICKING SEVERAL
# ══════════════════════════════════════════════════════════════════════════════

SELECTED = ".territory-row-wrap[data-selected='1']"


def rows_of(page: Page) -> Locator:
    return page.locator(".territory-row-wrap .territory-row[data-role='go']")


def test_ctrl_click_picks_without_leaving_the_list(gridded: Page):
    """The modified click selects; the plain one still goes and looks."""
    rows_of(gridded).nth(2).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(5).click(modifiers=["ControlOrMeta"])

    assert gridded.locator(SELECTED).count() == 2
    expect(gridded.locator(".territory-list")).to_be_visible()
    expect(gridded.locator("[data-role='selection']")).to_be_visible()

    # And clicking one again takes it back out.
    rows_of(gridded).nth(2).click(modifiers=["ControlOrMeta"])
    assert gridded.locator(SELECTED).count() == 1


def test_shift_click_takes_the_range_between(gridded: Page):
    rows_of(gridded).nth(1).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(5).click(modifiers=["Shift"])

    assert gridded.locator(SELECTED).count() == 5, "one through five inclusive"


def test_select_all_takes_what_is_shown_and_gives_it_back(gridded: Page):
    """Ctrl/⌘+A over the filtered list, and again to put it down.

    Scoped to what is on screen because that is what makes it worth having
    next to the filters: narrow to the ones needing repair, take all of them,
    close, and the map is holding exactly those.
    """
    cycle(gridded, "repair", "only")
    shown = gridded.locator(".territory-row-wrap").count()
    assert shown > 1

    gridded.keyboard.press("ControlOrMeta+a")
    assert gridded.locator(SELECTED).count() == shown

    gridded.keyboard.press("ControlOrMeta+a")
    assert gridded.locator(SELECTED).count() == 0


def test_the_selection_survives_the_dialog_and_lands_on_the_map(gridded: Page):
    """What the picking is for.

    The list is a better place to choose fourteen territories out of ninety-
    nine than the map is, and the operations worth doing to fourteen of them
    live out there. So closing hands the selection over, and App.editing holds
    it from then on — one idea of "selected", painted once and counted once.
    """
    rows_of(gridded).nth(0).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(3).click(modifiers=["ControlOrMeta"])

    gridded.locator("[data-role='close']").click()
    expect(gridded.locator(".territory-list")).to_have_count(0)

    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == 2
    assert gridded.evaluate("() => window.App.state.mergeMode") is True
    expect(gridded.locator(".merge-toolbar")).to_be_visible()


def test_closing_with_nothing_picked_changes_nothing(gridded: Page):
    """No selection is not an empty selection, and must not open a mode."""
    gridded.locator("[data-role='close']").click()
    expect(gridded.locator(".territory-list")).to_have_count(0)

    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == 0
    assert gridded.evaluate("() => window.App.state.mergeMode") is False


def test_the_handed_over_selection_can_be_deleted_in_one_step(gridded: Page):
    """The other half of "merge/delete", and one Ctrl+Z to take back.

    A loop over the single delete would push a history entry per territory, so
    undoing a selection of twelve would be twelve presses and the eleventh
    would leave the map in a state nobody chose.
    """
    before = gridded.evaluate("() => window.App.state.clusters.length")
    rows_of(gridded).nth(0).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(1).click(modifiers=["ControlOrMeta"])
    gridded.locator("[data-role='close']").click()

    gridded.locator(".merge-toolbar [data-role='delete']").click()
    gridded.wait_for_function(
        "(n) => window.App.state.clusters.length === n - 2", arg=before
    )

    gridded.evaluate("() => window.App.history.undo()")
    gridded.wait_for_function(
        "(n) => window.App.state.clusters.length === n", arg=before
    )


def test_the_shortcut_sheet_lists_the_selection_keys(gridded: Page):
    """ "?" over the list, which is the only place these keys are written down.

    Note entries carry combos that are never dispatched — Ctrl-click is not a
    keystroke — so nothing else would notice a malformed one until somebody
    pressed "?" and got a sheet with a hole in it.
    """
    gridded.keyboard.press("?")

    body = gridded.locator("body")
    for phrase in (
        "Select every territory the list is showing",
        "Add one territory to the selection",
        "Select every territory up to this one",
    ):
        expect(body).to_contain_text(phrase)


def test_the_list_shows_what_the_map_is_already_holding(gridded: Page):
    """The round trip. Two ideas of "selected" would drift the moment either
    changed, so there is one, and the list is where it is edited."""
    rows_of(gridded).nth(0).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(1).click(modifiers=["ControlOrMeta"])
    gridded.locator("[data-role='close']").click()
    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == 2

    gridded.evaluate("() => window.App.labels.openList()")
    expect(gridded.locator(".territory-list")).to_be_visible()
    assert gridded.locator(SELECTED).count() == 2, "the list did not read it back"

    # And putting it down in here puts it down out there.
    gridded.locator("[data-role='clear-selection']").click()
    assert gridded.locator(SELECTED).count() == 0
    gridded.locator("[data-role='close']").click()
    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == 0


# ══════════════════════════════════════════════════════════════════════════════
# THE SHAPE OF THE DIALOG, AND THE GESTURES ON IT
# ══════════════════════════════════════════════════════════════════════════════


def dialog_box(page: Page) -> tuple[int, int]:
    return tuple(
        page.evaluate(
            "() => { const b = document.querySelector('.territory-list')"
            ".getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }"
        )
    )


def test_a_small_project_gets_a_small_dialog(app_page: Page):
    """Frozen at the size it opened, not at one size for everybody.

    The first answer to "stop resizing" was a constant height in the
    stylesheet, and it made the five-territory sample every first-time visitor
    sees open a dialog four fifths of which was empty box. Nothing else in the
    app has a hard height — the shortcut sheet caps its scroller, print and
    place clamp to the viewport and let a flex body absorb the rest.
    """
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")
    app_page.evaluate("() => window.App.labels.openList()")
    expect(app_page.locator(".territory-list")).to_be_visible()
    small = dialog_box(app_page)[1]
    app_page.evaluate("() => window.App.ui.closeDialog()")

    assert app_page.evaluate(GRID) > 10
    app_page.evaluate("() => window.App.labels.openList()")
    expect(app_page.locator(".territory-list")).to_be_visible()
    many = dialog_box(app_page)[1]

    assert small < many, f"a five-row list opened as tall as a thirty-row one ({small})"


def test_nothing_matching_says_so_where_the_rows_would_be(gridded: Page):
    """Not at the bottom of a frozen dialog, resting on the action bar.

    The rows box is the flexible child, so when it is empty it has to stop
    being flexible or it holds the whole height and pushes the explanation
    down past everything.
    """
    cycle(gridded, "printed", "only")
    expect(gridded.locator("[data-role='no-match']")).to_be_visible()

    message = gridded.locator("[data-role='no-match']").bounding_box()
    chips = gridded.locator(".territory-list__find").bounding_box()
    actions = gridded.locator("[data-role='close']").bounding_box()
    assert message and chips and actions
    gap_above = message["y"] - (chips["y"] + chips["height"])
    gap_below = actions["y"] - (message["y"] + message["height"])
    assert gap_above < gap_below, (
        "the message sank to the bottom instead of staying with the rows"
    )


def test_the_dialog_is_the_same_size_whatever_the_filter_says(gridded: Page):
    """Sized by the window rather than by its contents, in both directions.

    A dialog sized by its contents shrinks when thirty-one rows narrow to a
    handful, which moves the chips out from under the pointer that has just
    clicked one — so the second click of a filtering session lands somewhere
    else. The width does the same thing more quietly: rows reading
    "Buildings: 141 · Streets: 42" are wider than rows reading
    "Buildings: 0 · Streets: 0", so the edge moves by eight pixels.
    """
    sizes = {dialog_box(gridded)}

    for axis in ("repair", "printed"):
        for state in ("only", "not", "any"):
            cycle(gridded, axis, state)
            sizes.add(dialog_box(gridded))

    assert len(sizes) == 1, f"the dialog resized: {sorted(sizes)}"


def test_a_plain_click_selects_and_stays(gridded: Page):
    """Click selects, and the list is still there to click again."""
    rows_of(gridded).nth(3).click()

    assert gridded.locator(SELECTED).count() == 1
    expect(gridded.locator(".territory-list")).to_be_visible()

    # And it replaces rather than adds, which is what "only this one" means.
    rows_of(gridded).nth(5).click()
    assert gridded.locator(SELECTED).count() == 1


def test_a_double_click_goes_to_the_map_and_leaves_the_picking_alone(gridded: Page):
    """One gesture, not two.

    The first click of the pair has already selected the row by the time the
    double click arrives, so the selection is put back — glancing at a
    territory should not silently replace a selection somebody spent a minute
    building.
    """
    rows_of(gridded).nth(1).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(6).click(modifiers=["ControlOrMeta"])
    picked = gridded.locator(SELECTED).count()
    assert picked == 2

    rows_of(gridded).nth(9).dblclick()

    expect(gridded.locator(".territory-list")).to_have_count(0)
    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == picked


def test_the_arrow_keys_move_and_take_the_row_they_land_on(gridded: Page):
    rows_of(gridded).nth(2).click()
    for _ in range(3):
        gridded.keyboard.press("ArrowDown")

    assert gridded.locator(SELECTED).count() == 1, "moving takes one row, not many"
    landed = gridded.evaluate(
        """() => {
            const a = document.activeElement;
            const row = a && a.closest && a.closest('.territory-row-wrap');
            return row ? Number(row.dataset.territory) : null;
        }"""
    )
    assert landed == 5, "three rows down from the third"
    expect(
        gridded.locator(f".territory-row-wrap[data-territory='{landed}']")
    ).to_have_attribute("data-selected", "1")


def test_shift_and_the_arrow_keys_drag_the_range_both_ways(gridded: Page):
    """The range is the selection, so walking back gives rows up again.

    A range that could only ever grow meant overshooting by two rows was
    fixed by starting the whole selection over.
    """
    rows_of(gridded).nth(2).click()
    for _ in range(4):
        gridded.keyboard.press("Shift+ArrowDown")
    assert gridded.locator(SELECTED).count() == 5

    for _ in range(2):
        gridded.keyboard.press("Shift+ArrowUp")
    assert gridded.locator(SELECTED).count() == 3


def test_a_double_click_puts_back_the_latest_selection_not_a_stale_one(gridded: Page):
    """The snapshot is only good while nothing else has picked anything.

    Click a row, then Ctrl-click another, then double-click a third: what
    comes back has to be both of the first two, not the one that was selected
    before the Ctrl-click happened.
    """
    rows_of(gridded).nth(1).click()
    rows_of(gridded).nth(4).click(modifiers=["ControlOrMeta"])
    assert gridded.locator(SELECTED).count() == 2

    rows_of(gridded).nth(8).dblclick()

    expect(gridded.locator(".territory-list")).to_have_count(0)
    assert gridded.evaluate("() => window.App.state.selectedClusters.length") == 2


# ══════════════════════════════════════════════════════════════════════════════
# THE ROW, AND WHAT IT COSTS TO TOUCH ONE
# ══════════════════════════════════════════════════════════════════════════════


def test_picking_a_row_does_not_rebuild_the_list(gridded: Page):
    """Why selecting must not go through the filter's path.

    A selection cannot change which rows exist, what they say, or what is wrong
    with them, so it must not rebuild every row and re-run an audit that
    rehearses a repair per empty territory — the better part of a second on a
    real partition. Row identity is the observable form of that: if the nodes
    survive the click, the work did not happen.
    """
    stamp = """() => {
        document.querySelectorAll("[data-territory]").forEach((n, i) => {
            n.dataset.stamp = String(i);
        });
        return document.querySelectorAll("[data-territory]").length;
    }"""
    count = gridded.evaluate(stamp)
    assert count > 5

    rows_of(gridded).nth(3).click()
    rows_of(gridded).nth(6).click(modifiers=["ControlOrMeta"])
    rows_of(gridded).nth(9).click(modifiers=["Shift"])
    gridded.keyboard.press("ControlOrMeta+a")

    survived = gridded.evaluate(
        """() => [...document.querySelectorAll("[data-territory]")]
             .filter((n) => n.dataset.stamp !== undefined).length"""
    )
    assert survived == count, "the rows were rebuilt to move a highlight"
    assert gridded.locator(SELECTED).count() == count, "and it still selected them"


def test_hovering_a_row_lights_all_of_it(gridded: Page):
    """As far as the first flag is not a row.

    The hover was on the button inside the wrap, which stops where the print
    and repair buttons begin — so against a selected row, colored across its
    whole width, a hovered one read as a rendering fault.
    """
    wrap = gridded.locator(".territory-row-wrap").nth(2)
    plain = wrap.evaluate("(n) => getComputedStyle(n).backgroundColor")
    wrap.hover()
    lit = wrap.evaluate("(n) => getComputedStyle(n).backgroundColor")

    assert lit != plain, "hovering the row changed nothing on the row itself"


def test_the_dialog_does_not_wear_the_map_cursor(gridded: Page):
    """Leaflet puts `grab` on its container and everything over the map
    inherits it, so a dialog invited a drag gesture that does nothing — most
    visibly over the flags, which are not buttons and never claimed a cursor
    of their own."""
    assert (
        gridded.evaluate(
            "() => getComputedStyle(document.querySelector('.territory-list')).cursor"
        )
        == "default"
    )
    assert (
        gridded.evaluate(
            """() => {
                const f = document.querySelector('.territory-row__flag');
                return f ? getComputedStyle(f).cursor : null;
            }"""
        )
        == "pointer"
    ), "a flag inside the row button should offer the row's own cursor"


def test_zooming_out_adds_no_flags(gridded: Page):
    """ "Too small to see at this zoom" is gone, and staying gone is the point.

    It described the viewport rather than the territory, emptied the moment
    you zoomed in, and autoheal could never repair it — so it sat among two
    flags that are real faults and made them look like housekeeping.
    """
    before = gridded.locator(".territory-row__flag").count()

    gridded.evaluate("() => window.App.state.leafletMap.setZoom(9)")
    gridded.wait_for_timeout(400)
    gridded.evaluate("() => window.App.labels.openList()")
    expect(gridded.locator(".territory-list")).to_be_visible()

    assert gridded.locator(".territory-row__flag").count() == before
    assert gridded.locator(".territory-list__chip[data-axis]").count() == 2


@pytest.fixture
def holed(app_page: Page) -> Page:
    """The sample village with one territory deleted, and the list open.

    The hole is exactly the shape that was deleted, so the map is left with a
    piece of ground in no territory at all — which is the one state the rows
    below are about.
    """
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")

    app_page.evaluate(
        "() => window.App.polygons.deleteCluster(window.App.state.clusters[1].layer)"
    )
    app_page.wait_for_function("() => window.App.gaps.count() > 0", timeout=10000)

    app_page.evaluate("() => window.App.labels.openList()")
    expect(app_page.locator(".territory-list")).to_be_visible()
    return app_page


def test_uncovered_ground_is_a_row_in_the_list(holed: Page):
    """Uncovered ground is named in the list, not in the info panel.

    A row of its own in the panel can only zoom to the largest patch, leaving
    everything a reader then wants — what it is, how big, adopt it, close it —
    somewhere else. So the panel carries one mark on the territory count, and the
    ground is a row in the list beside the territories, which is where the rest
    of the map's faults are named.
    """
    assert holed.locator("#info-panel [data-role='gaps-row']").count() == 0, (
        "the panel should no longer carry a row of its own"
    )
    expect(holed.locator("#info-panel [data-role='clusters-warn']")).to_be_visible()

    rows = holed.locator("[data-gap]")
    expect(rows).to_have_count(holed.evaluate("() => window.App.gaps.count()"))
    expect(holed.locator("[data-role='notes']")).to_be_visible()
    # It offers the two things that can be done to it, and neither of the two
    # that belong to a territory.
    expect(rows.first.locator(WANDS)).to_be_visible()
    expect(rows.first.locator(".territory-row__dissolve:not([hidden])")).to_be_visible()
    expect(rows.first.locator("[data-role='print']")).to_be_hidden()
    assert rows.first.evaluate("(n) => n.dataset.territory") is None, (
        "a gap is not a territory and must stay out of the selection"
    )


def test_the_wand_on_a_gap_makes_a_territory_and_then_repairs_it(holed: Page):
    """Adopt first, repair second — the order the whole feature turns on.

    The hole left by deleting a territory has buildings in it, so what comes
    back is a territory of its own. A strip with nothing on it would be
    absorbed by a neighbor instead, and that is the same repair reached the
    same way.
    """
    before = holed.evaluate("() => window.App.state.clusters.length")
    covered = holed.evaluate("() => window.App.gaps.count()")
    assert covered > 0

    repair(holed, holed.locator("[data-gap]").first.locator(WANDS))

    holed.wait_for_function("() => window.App.gaps.count() === 0", timeout=10000)
    assert holed.evaluate("() => window.App.state.clusters.length") > before
    expect(holed.locator("[data-gap]")).to_have_count(0)
    expect(holed.locator("[data-role='outcome']")).to_contain_text("1")


def test_closing_a_gap_from_the_list_leaves_no_row_behind(holed: Page):
    """The other outcome, and the more common one.

    Most uncovered ground is not worth a card. The droplet hands it to a
    neighbor or trims the boundary back — gaps.js decides which — and the row
    goes with it, because the recount pushes the list a new answer.
    """
    holed.locator("[data-gap]").first.locator(
        ".territory-row__dissolve:not([hidden])"
    ).click()
    holed.wait_for_function("() => window.App.gaps.count() === 0", timeout=10000)

    expect(holed.locator(".territory-list")).to_be_visible()
    expect(holed.locator("[data-gap]")).to_have_count(0)


def test_fix_all_takes_in_the_ground_nothing_covers(holed: Page):
    """"Fix all" is the button that makes the map right, and a strip nobody
    walks is not right. So it adopts the uncovered ground too, in the same one
    history entry as every other repair it makes.
    """
    holed.locator(OUTCOME).evaluate("(node) => { node.textContent = ''; }")
    holed.locator("[data-role='fix-all']").click()
    expect(holed.locator(OUTCOME)).not_to_be_empty()

    holed.wait_for_function("() => window.App.gaps.count() === 0", timeout=10000)
    expect(holed.locator("[data-gap]")).to_have_count(0)

    holed.evaluate("() => window.App.history.undo()")
    holed.wait_for_function("() => window.App.gaps.count() > 0", timeout=10000)
    assert holed.evaluate("() => window.App.gaps.count()") > 0, (
        "one Ctrl+Z, and the ground is uncovered again"
    )


def test_an_open_list_follows_the_recount(app_page: Page):
    """The count arrives two hundred milliseconds after the change.

    Every path that changes the coverage redraws the panel and the list
    synchronously and schedules the recount afterwards, so both read the answer
    from before the change — and nothing told them when the real one landed.
    Adopting a gap left the list offering the gap that had just become a
    territory.
    """
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")

    app_page.evaluate("() => window.App.labels.openList()")
    expect(app_page.locator(".territory-list")).to_be_visible()
    expect(app_page.locator("[data-gap]")).to_have_count(0)

    app_page.evaluate(
        "() => window.App.polygons.deleteCluster(window.App.state.clusters[1].layer)"
    )
    app_page.wait_for_function("() => window.App.gaps.count() > 0", timeout=10000)
    expect(app_page.locator("[data-gap]")).to_have_count(
        app_page.evaluate("() => window.App.gaps.count()")
    )

    app_page.evaluate("() => window.App.gaps.adopt(window.App.gaps.features()[0])")
    app_page.wait_for_function("() => window.App.gaps.count() === 0", timeout=10000)
    expect(app_page.locator("[data-gap]")).to_have_count(0)


def test_fix_all_leaves_no_work_behind_the_spinner(gridded: Page):
    """The freeze that came after the wait.

    Changing the territories schedules a recount of the uncovered remainder,
    which subtracts every territory from the boundary they tile — around a
    second of arithmetic on a real partition, and not divisible: unioning in
    halves and subtracting one at a time both measure worse. On a two hundred
    millisecond timer that second landed *after* the spinner came down, so the
    page looked finished and then stopped answering. It is now spent under the
    spinner that is already explaining the wait.
    """
    gridded.locator(OUTCOME).evaluate("(node) => { node.textContent = ''; }")
    gridded.locator("[data-role='fix-all']").click()
    expect(gridded.locator(OUTCOME)).not_to_be_empty()

    # The overlay is down by now — the outcome line is written after it.
    assert gridded.evaluate(
        "() => document.querySelector('#loading-overlay').hasAttribute('hidden')"
    ), "the spinner was still up"
    assert gridded.evaluate("() => window.App.gaps.flush()") is False, (
        "a recount was still pending when the page was handed back"
    )


def test_a_pending_recount_is_run_rather_than_dropped(app_page: Page):
    """flush() is not a cancel: what it skips is the waiting, not the work."""
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")
    app_page.wait_for_function("() => window.App.gaps.flush() === false")

    # Delete a territory and flush before the timer would have fired.
    ran = app_page.evaluate(
        """() => {
            window.App.polygons.deleteCluster(window.App.state.clusters[1].layer);
            return window.App.gaps.flush();
        }"""
    )
    assert ran is True, "nothing was pending, so this proves nothing"
    assert app_page.evaluate("() => window.App.gaps.count()") > 0, (
        "the hole left by the delete was not found"
    )
    assert app_page.evaluate("() => window.App.gaps.flush()") is False
