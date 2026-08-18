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
from playwright.sync_api import BrowserContext, Page, expect

OVERLAY = "#loading-overlay"

# What ui.busy consults. Pretending a full pass over the data is expensive is
# how a five-territory sample stands in for a town here.
EXPENSIVE = """(ms) => {
    window.App.polygons.refreshCostMs = () => ms;
}"""


# A project small enough to build in one statement and real enough to be saved:
# a boundary with two territories under it. The demo cannot stand in here — it
# suspends persistence for its whole visit, which is the point of the demo.
A_SAVED_PROJECT = """() => {
    const ring = (x, y, w, h) => [
        [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
    ];
    const poly = (x, y, w, h) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: ring(x, y, w, h) },
    });
    window.App.data.applyPayload({
        outerPolygon: poly(10, 50, 0.02, 0.01),
        clusters: [poly(10, 50, 0.01, 0.01), poly(10.01, 50, 0.01, 0.01)],
    });
}"""

POLL_FOR_THE_SAVE = """() => {
    window.__saved = false;
    const poll = () =>
        window.App.store.get("session:meta").then((meta) => {
            if (meta) window.__saved = true;
            else setTimeout(poll, 50);
        });
    poll();
}"""

# The spinner is recorded rather than looked for. A restore of two territories
# is over in a frame or two, which is a window a polling assertion can walk
# straight past — and "did not catch it" and "it was never shown" would then be
# the same result, which is the bug this is here for.
WATCH_BODY = """
    window.__overlay = { events: [], pendingAtHide: null };
    const watch = () => {
        const el = document.getElementById("loading-overlay");
        if (!el) return setTimeout(watch, 5);
        let shown = !el.hasAttribute("hidden");
        new MutationObserver(() => {
            const now = !el.hasAttribute("hidden");
            if (now === shown) return;
            shown = now;
            window.__overlay.events.push(now ? "shown" : "hidden");
            // Whatever puts the spinner up takes the gap recount down with it,
            // so by the time it comes down there is nothing left scheduled.
            if (!now) window.__overlay.pendingAtHide = window.App.gaps.flush();
        }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
    };
    watch();
"""

# An init script is source rather than a callable, and it runs before the app's
# own scripts — the only place the restore can be watched from, since it starts
# as soon as IndexedDB answers.
WATCH_FROM_THE_START = f"(() => {{{WATCH_BODY}}})();"
WATCH_FROM_NOW = f"() => {{{WATCH_BODY}}}"


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


def test_restoring_a_saved_project_says_it_is_working(
    app_page: Page, context: BrowserContext
):
    """The one blocking job that cannot be decided from a measurement.

    Applying a payload is the heaviest thing the app does, and it is what
    ui.busy's estimate is measured *from* — so on the load that restores a
    project there is no estimate yet, and asking for one gets a zero. The page
    is at its most convincing here, too: the map is drawn, the toolbar is up,
    and then it stops answering for a second and a half of geometry and
    another second of gap recount.
    """
    app_page.evaluate(A_SAVED_PROJECT)
    app_page.wait_for_function("() => window.App.state.clusters.length === 2")
    # The save is debounced, and waiting for it to land is what makes the
    # reload below a restore rather than a first visit. Polled through a flag
    # rather than awaited in the predicate: a predicate that returns a promise
    # returns something truthy on the first poll, which is how this test first
    # went green while reloading an empty store.
    app_page.evaluate(POLL_FOR_THE_SAVE)
    app_page.wait_for_function("() => window.__saved === true", timeout=15000)

    context.add_init_script(WATCH_FROM_THE_START)
    app_page.goto("/?tour=0")
    expect(app_page.locator(".tb-panel")).to_be_visible()
    app_page.wait_for_function(
        "() => window.App.state.clusters.length === 2", timeout=30000
    )

    probe = app_page.evaluate("() => window.__overlay")
    assert probe["events"][:2] == ["shown", "hidden"], (
        "the restore ran with nothing on screen to say so"
    )
    assert probe["pendingAtHide"] is False, (
        "the spinner came down with the gap recount still to come"
    )


def test_opening_a_project_says_it_is_working(app_page: Page):
    """The other way a whole payload arrives, and the same second of work.

    Import differs from the restore only in where the JSON came from: it lands
    on a page that is already up, which is if anything more convincing as a
    page that is not busy.
    """
    app_page.evaluate(A_SAVED_PROJECT)
    app_page.wait_for_function("() => window.App.state.clusters.length === 2")

    app_page.evaluate(WATCH_FROM_NOW)
    app_page.evaluate("""() => {
        const json = JSON.stringify(window.App.data.buildPayload());
        const file = new File([json], "project.json", { type: "application/json" });
        window.App.data.importData(file);
    }""")
    app_page.wait_for_function(
        "() => window.__overlay.events.length >= 2", timeout=15000
    )

    probe = app_page.evaluate("() => window.__overlay")
    assert probe["events"][:2] == ["shown", "hidden"], (
        "the import ran with nothing on screen to say so"
    )
    assert probe["pendingAtHide"] is False, (
        "the spinner came down with the gap recount still to come"
    )
    assert app_page.evaluate("() => window.App.state.clusters.length") == 2, (
        "the spinner came down but the project never arrived"
    )
