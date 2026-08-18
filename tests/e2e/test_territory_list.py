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
    assert flags.count() == gridded.locator(".territory-row__flag[role='img']").count()
    for i in range(flags.count()):
        assert flags.nth(i).get_attribute("aria-label"), (
            "a flag with nothing to announce"
        )

    status = gridded.locator(OUTCOME)
    expect(status).to_have_attribute("role", "status")
    expect(status).to_be_empty()

    repair(gridded, gridded.locator(WANDS).first)
