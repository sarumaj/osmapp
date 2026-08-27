"""The About dialog, which is the app's only answer to "what is this?".

It replaced a toolbar button that linked straight out to the repository. That
link answered "where is the code" and nothing else, while the questions people
actually arrive with are what the thing is, whether they may use it, and where
to say something is wrong — and the last of those wants the issue tracker,
which a bare repository link never reached.

So what is asserted here is that the four things the dialog exists to carry are
on it and reachable: the purpose, the licence, the copyright holder, and both
links. Read off the rendered page rather than off the template, because half of
this is i18n substitution and link attributes that only exist once the dialog
has been cloned and mounted.
"""

import re

from playwright.sync_api import Page, expect

REPO = "https://github.com/sarumaj/osmapp"


def _open(page: Page):
    page.locator('.tb-item[data-action="about"]').click()
    dialog = page.locator(".app-dialog.about-dialog")
    expect(dialog).to_be_visible()
    return dialog


def test_the_toolbar_offers_about_rather_than_a_bare_repository_link(app_page: Page):
    expect(app_page.locator('.tb-item[data-action="about"]')).to_be_visible()
    expect(app_page.locator('.tb-item[data-action="github"]')).to_have_count(0)


def test_the_dialog_says_what_the_app_is_and_who_owns_it(app_page: Page):
    dialog = _open(app_page)

    # Read the text out and match in Python rather than through to_have_text,
    # which compares a regex against the whole string — every assertion here is
    # about something being *somewhere* in a translated sentence.
    purpose = dialog.locator(".app-dialog__hint").inner_text()
    assert len(purpose) > 40, purpose
    assert not purpose.startswith("about."), "the key was rendered instead of the string"

    copyright_line = dialog.locator(".about-dialog__copyright").inner_text()
    assert re.search(r"©\s*\d{4}\s+\S+", copyright_line), copyright_line

    licence = dialog.locator(".about-dialog__license").inner_text()
    assert "BSD" in licence, licence


def test_both_links_go_where_they_say(app_page: Page):
    """The issue tracker is the half the old button could not reach."""
    dialog = _open(app_page)
    links = dialog.locator("a[href]")

    href_list = links.evaluate_all("nodes => nodes.map((n) => n.getAttribute('href'))")
    assert f"{REPO}/issues/new" in href_list, href_list
    assert REPO in href_list, href_list

    # Opening the repository must not hand it a live window.opener onto a page
    # holding somebody's unsaved territories.
    for i in range(links.count()):
        expect(links.nth(i)).to_have_attribute("target", "_blank")
        expect(links.nth(i)).to_have_attribute("rel", re.compile(r"noopener"))


def test_the_dialog_closes_both_ways(app_page: Page):
    dialog = _open(app_page)
    dialog.locator("[data-role='close']").click()
    expect(app_page.locator(".app-dialog.about-dialog")).to_have_count(0)

    # Escape comes from the context controls.js pushes, not from the browser:
    # a dialog that registers nothing leaves "?" answering for the map beneath.
    dialog = _open(app_page)
    app_page.keyboard.press("Escape")
    expect(app_page.locator(".app-dialog.about-dialog")).to_have_count(0)


def test_the_shortcut_sheet_answers_for_the_dialog_it_is_over(app_page: Page):
    _open(app_page)
    app_page.keyboard.press("?")

    sheet = app_page.locator(".app-dialog.shortcuts-dialog")
    expect(sheet).to_be_visible()
    # The group the About context registers, rather than the map's own keys.
    assert "Esc" in sheet.inner_text(), sheet.inner_text()
