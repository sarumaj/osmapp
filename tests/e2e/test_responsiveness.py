"""Work that blocks the page, and whether the page says so.

The client does its geometry on the main thread, and on a town-sized project
the ordinary edits are not quick: re-testing twelve thousand building
centroids against a hundred territories is about a second, and it runs inside
every change to the map. A second of that is a page that has stopped
answering — the pointer does not change, clicks are swallowed, and nothing on
screen says why.

A synchronous job cannot be preceded by a repaint: the browser draws nothing
until the call stack unwinds. So saying anything at all means saying it first,
handing the frame back, and doing the work in the next task — which is what
`ui.busy` is, and what the trim toolbar now does with the debounce it was
already waiting out.

The cost of that is a spinner flashing for one frame on projects where the
work was never slow, so the decision is made from what the last change
actually cost rather than from a guess about the data. That decision is what
these tests are about; the second of geometry underneath it is not something
a test should be paying for.
"""

import pytest
from playwright.sync_api import Page, expect

OVERLAY = "#loading-overlay"

# What ui.busy consults. Pretending a full pass over the data is expensive is
# how a five-territory sample stands in for a town here.
EXPENSIVE = """(ms) => {
    window.App.polygons.refreshCostMs = () => ms;
}"""


@pytest.fixture
def sample(app_page: Page) -> Page:
    assert app_page.evaluate("() => window.App.demo.enter()") is True
    app_page.wait_for_function("() => window.App.state.clusters.length > 0")
    return app_page


def test_a_cheap_project_never_flashes_a_spinner(sample: Page):
    """The sample every first-time visitor sees is milliseconds of work.

    Deferring it to show a spinner would put a flash of overlay in front of
    something that was already instant, which is worse than saying nothing.
    """
    assert sample.evaluate("() => window.App.polygons.refreshCostMs()") < 120

    before = sample.evaluate("() => window.App.state.clusters.length")
    sample.evaluate("""() => {
        window.App.history.push();
        window.App.polygons.deleteCluster(window.App.state.clusters[0].layer);
    }""")
    # Synchronously done, with nothing shown: the work is over by the time the
    # next statement runs.
    assert sample.evaluate("() => window.App.state.clusters.length") == before - 1
    expect(sample.locator(OVERLAY)).to_be_hidden()

    sample.evaluate("() => window.App.history.undo()")
    assert sample.evaluate("() => window.App.state.clusters.length") == before
    expect(sample.locator(OVERLAY)).to_be_hidden()


def test_an_expensive_project_says_it_is_working(sample: Page):
    """Undo on a town rebuilds every territory and re-tests every building."""
    sample.evaluate(EXPENSIVE, 500)
    before = sample.evaluate("() => window.App.state.clusters.length")
    sample.evaluate("""() => {
        window.App.history.push();
        window.App.polygons.deleteClusters([window.App.state.clusters[0].layer]);
    }""")

    sample.evaluate("() => window.App.history.undo()")

    # Shown before the work starts, which is the whole point of deferring it.
    expect(sample.locator(OVERLAY)).to_be_visible()
    expect(sample.locator("#loading-box")).to_contain_text("back")

    expect(sample.locator(OVERLAY)).to_be_hidden()
    assert sample.evaluate("() => window.App.state.clusters.length") == before, (
        "the spinner came down but the work never happened"
    )


@pytest.mark.parametrize(
    "action",
    [
        "window.App.polygons.deleteCluster(window.App.state.clusters[0].layer)",
        "window.App.gaps.adopt(window.App.gaps.features()[0])",
    ],
)
def test_the_paths_that_rewrite_territories_are_covered(sample: Page, action: str):
    """Every one of them ends in the same second of point-in-polygon work."""
    # A gap to adopt, so both actions have something to do.
    sample.evaluate("""() => {
        window.App.history.push();
        window.App.polygons.deleteCluster(window.App.state.clusters[1].layer);
    }""")
    sample.wait_for_function("() => window.App.gaps.count() > 0", timeout=10000)

    sample.evaluate(EXPENSIVE, 500)
    sample.evaluate(f"() => {{ {action}; }}")

    expect(sample.locator(OVERLAY)).to_be_visible()
    expect(sample.locator(OVERLAY)).to_be_hidden()


def test_the_trim_toolbar_says_it_is_measuring(sample: Page):
    """A live preview cannot use a modal spinner — it would block the slider
    being dragged. The toolbar has had a word for this since it was written and
    could never show it: the proposal is computed on the tick that asks for it.
    Said when the slider moves instead, the debounce is the frame it gets.
    """
    sample.evaluate("() => window.App.trim.toggle()")
    status = sample.locator(".trim-toolbar [data-role='status']")
    expect(status).to_be_visible()
    # Let the first proposal land, so what follows is a change rather than a start.
    sample.wait_for_function(
        """() => {
            const n = document.querySelector(".trim-toolbar [data-role='status']");
            return n && n.textContent.trim().length > 0;
        }""",
        timeout=30000,
    )
    settled = status.inner_text()

    said = sample.evaluate("""() => {
        const bar = document.querySelector('.trim-toolbar');
        const slider = bar.querySelector("input[type=range]");
        slider.value = String(Number(slider.value) + 10);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
        // Read in the same tick: the debounce has not fired, so this is what
        // the browser is about to paint.
        return document.querySelector(".trim-toolbar [data-role='status']").innerText;
    }""")

    assert said != settled, "the toolbar went on showing the previous answer"
    assert said.strip(), "and it said nothing at all instead"
