"""The guided tour, which is the only thing a first-time visitor is shown.

It opens by itself, on a page with nothing on it, and it is suppressed by a
localStorage flag it writes on the way out. Both halves are only real in a
browser: the auto-start hangs off the session restore finishing, and the flag
means nothing until a second page load reads it back.

Getting either wrong is quiet and bad. A tour that stops opening was never
seen by anyone visiting for the first time; one that stops suppressing greets
a daily user with a modal every single morning.
"""

from playwright.sync_api import Page, expect


def test_a_first_visit_is_met_by_the_tour(page: Page):
    """Every browser context here is a visitor who has never been.

    Deliberately not `app_page`: that one passes `?tour=0` precisely so the
    other tests are not talking to a modal, which leaves this as the only
    place the auto-start is exercised at all.
    """
    page.goto("/")

    bubble = page.locator(".tour__bubble")
    expect(bubble).to_be_visible()
    expect(bubble.locator("[data-role='title']")).not_to_be_empty()
    expect(bubble.locator("[data-role='body']")).not_to_be_empty()
    expect(bubble.locator("[data-role='counter']")).not_to_be_empty()


def test_dismissing_the_tour_is_remembered_across_a_reload(page: Page):
    """The mute box is checked by default, and closing is an answer to it.

    Asserting on `shouldAutoStart()` rather than on the tour's absence is
    deliberate: the auto-start runs after the session restore resolves, so
    "the modal is not there yet" and "the modal will not come" look identical
    for a moment, and only one of them is the invariant.
    """
    page.goto("/")
    expect(page.locator(".tour__bubble")).to_be_visible()

    page.locator(".tour [data-role='skip']").click()
    expect(page.locator(".tour__bubble")).to_have_count(0)
    expect(page.locator("#info-panel [data-role='stats']")).to_be_hidden()

    page.reload()
    expect(page.locator(".tb-panel")).to_be_visible()
    assert page.evaluate("() => window.App.tour.isSuppressed()") is True
    assert page.evaluate("() => window.App.tour.shouldAutoStart()") is False


def test_the_url_can_force_the_tour_either_way(page: Page):
    """`?tour=1` and `?tour=0` are how the tour is linked to, or kept out of
    the way, without asking anyone to clear their site data first."""
    page.goto("/")
    page.locator(".tour [data-role='skip']").click()
    expect(page.locator(".tour__bubble")).to_have_count(0)

    page.goto("/?tour=1")
    expect(page.locator(".tour__bubble")).to_be_visible()

    page.goto("/?tour=0")
    expect(page.locator(".tb-panel")).to_be_visible()
    assert page.evaluate("() => window.App.tour.shouldAutoStart()") is False
