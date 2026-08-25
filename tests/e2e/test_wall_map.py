"""Several projects on one map, and the sheet that prints them.

`tests/js/import-merge.test.mjs` checks the arithmetic of merging two projects
and `tests/js/wallcard.test.mjs` checks the sheet geometry, both over stubs.
Neither can check the two things that only exist in a browser: that a boundary
made of several areas survives the round trip through Leaflet layers that
applyPayload builds it into, and that a sheet with no template behind it
actually composes into a PDF - which is pdf-lib creating a document rather than
loading one, a path no card has ever taken.

The tour's sample is the only data this suite has, and one of it is one area.
A second copy of it, moved east, is what makes a two-village project out of the
data that exists.
"""

from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

# Far enough east that the two areas cannot touch, close enough that both fit
# on one sheet at a zoom the tile stub still answers for.
SHIFT_DEG = 0.05


@pytest.fixture
def two_villages(app_page: Page) -> Page:
    """The sample, plus a copy of it merged in a few kilometers away."""
    assert app_page.evaluate("() => window.App.demo.enter()") is True, (
        "the sample area refused to load"
    )

    app_page.evaluate(
        """(shift) => {
            const move = (node) =>
              typeof node[0] === "number"
                ? [node[0] + shift, node[1]]
                : node.map(move);

            const payload = JSON.parse(JSON.stringify(window.App.demo.payload()));
            const walk = (value) => {
              if (!value || typeof value !== "object") return;
              if (Array.isArray(value.coordinates)) {
                value.coordinates = move(value.coordinates);
                return;
              }
              Object.keys(value).forEach((key) => walk(value[key]));
            };
            walk(payload);
            if (payload.bounds) {
              payload.bounds.west += shift;
              payload.bounds.east += shift;
            }
            window.App.data.applyPayload(payload, { merge: true });
        }""",
        SHIFT_DEG,
    )
    return app_page


def test_two_projects_become_one_project_of_two_areas(two_villages: Page):
    """The boundary keeps both, and every territory of both comes with it.

    Losing an area is the failure the whole feature is about, and it is a
    silent one: the map simply does not show a village somebody imported.
    """
    state = two_villages.evaluate(
        """() => ({
            areas: window.App.geometry.outerParts(
              window.App.state.outerPolygonLayer
            ).length,
            type: window.App.geometry.outerFeature(
              window.App.state.outerPolygonLayer
            ).geometry.type,
            clusters: window.App.state.clusters.length,
            sample: window.App.demo.payload().clusters.length,
        })"""
    )
    assert state["areas"] == 2, state
    assert state["type"] == "MultiPolygon", state
    assert state["clusters"] == state["sample"] * 2, state


def test_a_one_ring_tool_gets_the_area_it_is_looking_at(two_villages: Page):
    """Both areas are the same size here, so only the anchor can tell them apart.

    Which is the point: without one, `the largest` answers first and answers
    the same way wherever the map is pointing.
    """
    picked = two_villages.evaluate(
        """(shift) => {
            const inside = (area, at) =>
              turf.booleanPointInPolygon(turf.point(at), area);
            const areas = window.App.geometry.outerParts(
              window.App.state.outerPolygonLayer
            );
            const home = window.App.geometry.interiorCoord(areas[0]);
            const away = [home[0] + shift, home[1]];
            return {
              home: inside(window.App.polygons.workingOuter(home), home),
              away: inside(window.App.polygons.workingOuter(away), away),
            };
        }""",
        SHIFT_DEG,
    )
    assert picked == {"home": True, "away": True}


def test_the_wall_map_offers_its_own_controls_and_not_a_card_s(two_villages: Page):
    two_villages.locator('.tb-item[data-action="wallcard"]').click()

    dialog = two_villages.locator(".app-dialog.print-dialog")
    expect(dialog).to_be_visible()
    expect(dialog.locator("[data-role='wall-only']")).to_be_visible()
    expect(dialog.locator("[data-role='card-only']")).to_be_hidden()
    # A wall map is always a PDF of this app's own, so there is always
    # somewhere to attach the project.
    expect(dialog.locator("[data-role='attach-group']")).to_be_visible()

    # A4 for the rest of this: every sheet is prefetched tile by tile through
    # the route interception, and the smallest one asks for a fraction of what
    # A2 does without changing anything being asserted.
    dialog.locator("[data-role='page-size']").select_option("a4")
    # The preview draws once the tiles behind it are in; until then the dialog
    # shows a counter, which is the state a broken compose would stay in.
    expect(dialog.locator("[data-role='status']")).to_be_hidden(timeout=60_000)
    upright = _canvas(two_villages)
    assert upright["height"] > upright["width"], upright

    dialog.locator("[data-role='landscape']").check()
    expect(dialog.locator("[data-role='status']")).to_be_hidden(timeout=60_000)
    turned = _canvas(two_villages)
    assert turned["width"] > turned["height"], turned
    # Not the portrait canvas with its sides swapped: the heading band comes
    # off the height either way, so turning the sheet gives the map a wider
    # box than the upright one was tall.
    assert turned["width"] > upright["height"], (upright, turned)


def _canvas(page: Page) -> dict[str, int]:
    return page.evaluate(
        """() => {
            const canvas = document.querySelector('.print-preview canvas');
            return { width: canvas.width, height: canvas.height };
        }"""
    )


def test_a_wall_map_composes_a_pdf_and_marks_nothing_printed(
    two_villages: Page, tmp_path: Path
):
    """The one path no card takes: a PDF built rather than stamped.

    A4 rather than the default, so the composition under test is the smallest
    one that exercises it - what is being asserted is that pdf-lib creates a
    page, embeds the map and attaches the project, not how long A0 takes.
    """
    # The sample ships with one territory already marked, and the fixture
    # merges a copy of it - so what is asserted is that the count did not
    # move, not that it is zero.
    marked = two_villages.evaluate("() => window.App.polygons.printedCount()")

    two_villages.evaluate("() => window.App.print.printWallCard()")
    dialog = two_villages.locator(".app-dialog.print-dialog")
    expect(dialog).to_be_visible()
    dialog.locator("[data-role='page-size']").select_option("a4")
    expect(dialog.locator("[data-role='status']")).to_be_hidden(timeout=60_000)

    with two_villages.expect_download(timeout=120_000) as download:
        dialog.locator("[data-role='download']").click()
    sheet = tmp_path / "wall.pdf"
    download.value.save_as(sheet)

    body = sheet.read_bytes()
    assert body.startswith(b"%PDF-"), body[:16]

    # The sheet on the hall wall is also the backup, which is the reason the
    # attachment is ticked by default. Read back through the app's own reader
    # rather than by searching the bytes: pdf-lib writes with object streams,
    # so the attachment's own name is deflated inside one.
    restored = two_villages.evaluate(
        """async (bytes) => {
            const file = new File([Uint8Array.from(bytes)], "wall.pdf", {
              type: "application/pdf",
            });
            const project = await window.App.pdfdoc.extractProject(file);
            return {
              areas: window.App.geometry.polygonParts(project.outerPolygon).length,
              clusters: project.clusters.length,
              partial: !!project.partial,
            };
        }""",
        list(body),
    )
    assert restored["areas"] == 2, restored
    assert restored["clusters"] == two_villages.evaluate(
        "() => window.App.state.clusters.length"
    ), restored
    # Without the OSM cache, which is what a card leaves out too.
    assert restored["partial"] is True, restored

    # A poster of every territory is not a card of each: marking them all
    # would wipe the record of which cards have actually been handed out.
    after = two_villages.evaluate("() => window.App.polygons.printedCount()")
    assert after == marked, (marked, after)


def test_a_portrait_sheet_is_shown_whole(two_villages: Page):
    """The preview is the point of the dialog, so none of it may be off screen.

    A card is wider than it is tall and fills the column it is in. A sheet in
    portrait is half as tall again as the whole dialog at that width, and this
    layout does not scroll - the settings column beside it does - so a preview
    left at its natural size simply has its bottom third cut off, with the
    frame nobody can see being the part that decides what prints.
    """
    # Stated rather than inherited: the fit is what the two-column layout does,
    # and that layout starts at 900 px. Below it the dialog scrolls as one
    # piece and the sheet is reachable by scrolling instead.
    two_villages.set_viewport_size({"width": 1280, "height": 720})

    two_villages.locator('.tb-item[data-action="wallcard"]').click()
    dialog = two_villages.locator(".app-dialog.print-dialog")
    expect(dialog).to_be_visible()
    dialog.locator("[data-role='page-size']").select_option("a4")
    expect(dialog.locator("[data-role='status']")).to_be_hidden(timeout=60_000)

    fit = two_villages.evaluate(
        """() => {
            const box = document.querySelector('.app-dialog.print-dialog');
            const canvas = document.querySelector('.print-preview canvas');
            const outer = box.getBoundingClientRect();
            const inner = canvas.getBoundingClientRect();
            return {
              inside: inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1,
              // The border is on the canvas, so the ratio to compare against
              // the sheet is the one of the paper inside it.
              shown: (inner.height - 2) / (inner.width - 2),
              sheet: canvas.height / canvas.width,
              tall: canvas.height > canvas.width,
            };
        }"""
    )
    assert fit["tall"] is True, fit
    assert fit["inside"] is True, fit
    # Fitted rather than squashed: a preview that lies about the shape of the
    # sheet is worse than one that is cut off.
    assert abs(fit["shown"] - fit["sheet"]) < 0.02, fit
