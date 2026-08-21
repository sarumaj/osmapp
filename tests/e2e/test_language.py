"""Switching language, which is a navigation the app performs on itself.

`tests/test_template_lang_pwa.py` proves the dictionaries agree and that
`/<lang>` renders; `tests/js/` proves `t()` looks a key up. Neither can see the
part that actually breaks: the picker rewrites the URL with pushState and swaps
the dictionary in place, so a mistake there is a page that keeps the old words,
or one that reloads and throws away the boundary, the downloaded streets and
the territories along with it.
"""

import json
import re

from playwright.sync_api import Page, expect

from osmapp.internal.config import I18N_DIR

DICTIONARIES = {
    code: json.loads((I18N_DIR / f"{code}.json").read_text(encoding="utf-8"))
    for code in ("en", "de")
}


def draw_label(code: str) -> str:
    """The toolbar's first label, in that language."""
    return DICTIONARIES[code]["toolbar"]["labelDraw"]


def pick_language(page: Page, name: str):
    """Open the language tile's menu and choose a row by its endonym.

    The tile is a button over the app's own menu rather than a <select>, so
    there is no `select_option` to call — and the row is addressed by the name
    a reader would look for, which is the endonym rather than the code. Both
    halves of the label are the same string in every language, so this reads
    the same whichever language the page is currently in.
    """
    page.locator(".lang-select").click()
    page.locator(".polygon-context-menu-item", has_text=name).click()


def test_the_picker_swaps_the_language_without_reloading(app_page: Page):
    """A reload here would be a data-loss bug, not a cosmetic one.

    The session is written to IndexedDB on a debounce, so a navigation in the
    second after an edit loses that edit — and the undo stack, which lives in
    memory only, is lost either way. The sentinel is how the test tells a
    pushState apart from a reload: nothing else on the page would notice.
    """
    label = app_page.locator('.tb-item[data-action="draw"] .tb-item__label')
    expect(label).to_have_text(draw_label("en"))

    app_page.evaluate("() => { window.__stillHere = true; }")
    pick_language(app_page, "Deutsch")

    expect(label).to_have_text(draw_label("de"))
    expect(app_page).to_have_url(re.compile(r"/de$"))
    assert app_page.evaluate("() => window.__stillHere") is True, (
        "the page reloaded — switching language must not be a navigation"
    )
    assert app_page.evaluate("() => document.documentElement.lang") == "de"


def test_back_returns_to_the_language_you_came_from(app_page: Page):
    """pushState put the language in the history, so Back has to honour it."""
    label = app_page.locator('.tb-item[data-action="draw"] .tb-item__label')
    pick_language(app_page, "Deutsch")
    expect(label).to_have_text(draw_label("de"))

    app_page.go_back()

    expect(label).to_have_text(draw_label("en"))
    assert app_page.evaluate("() => document.documentElement.lang") == "en"


def test_a_localized_url_arrives_already_translated(page: Page):
    """The shareable half: /de has to be German before any JS decides so."""
    page.goto("/de?tour=0")

    expect(page.locator('.tb-item[data-action="draw"] .tb-item__label')).to_have_text(
        draw_label("de")
    )
    assert page.evaluate("() => document.documentElement.lang") == "de"
    assert page.evaluate("() => window.App.i18n.current()") == "de"
