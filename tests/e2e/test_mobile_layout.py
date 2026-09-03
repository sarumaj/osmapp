"""What the map's furniture does on a screen the size of a phone.

Every control the app draws over the map positions itself against an edge or a
corner of that map, and on a desktop there is enough room that no two of them
have to agree about anything. On a phone there is not. The search field is
260 px and the toolbar panel is 334, so on a 390 px screen they cannot both sit
on the top row — and since Leaflet paints the top-right corner after the
top-left one, what "cannot" looked like was a search box drawn on top of the
panel's first row, hiding Draw, Locate, Reload, Trim and the chevron that
collapses the panel again. Nothing was broken and nothing threw; the controls
were simply on top of each other.

That is the class of failure these tests are about, and it is why they are
geometric rather than functional. A rule that puts one box over another still
mounts both boxes, still answers `to_be_visible()`, and still passes every
assertion about what the app can do. The only thing that says it is wrong is
where the two rectangles are, so the assertions here read rectangles: what
overlaps what, and what has left the screen.

They belong in the browser suite for the same reason. Which of two absolutely
positioned boxes ends up where is decided by the whole cascade — this file, the
vendored geocoder stylesheet, leaflet.css, and the media queries in all three —
against a viewport of a particular size. No amount of reading the stylesheet
answers it, and the Node suite has no viewport to ask about.

── The sizes ─────────────────────────────────────────────────────────────────

360×740 is the small end of what is still common (an iPhone SE is 375, a Galaxy
S-series 360), and 390×844 is the middle of the range. Both are below the 720 px
where style.css switches to the phone layout and controls.js starts a first
visit collapsed, which is the arrangement under test.

The context sets `has_touch`, which is what makes `pointer: coarse` match — the
other half of the phone styling, and the half that decides how big a tap target
is. The tests that care assert the media query holds before they measure
anything, so a browser that does not emulate it fails loudly rather than
quietly testing the desktop sizes.
"""

from typing import Any, cast

import pytest
from playwright.sync_api import Page, ViewportSize, expect

# Two phones, both below the 720 px breakpoint. Written as a list of pairs
# rather than a dict so a failure names the size it happened at.
PHONES = [(390, 844), (360, 740)]

# Everything that positions itself over the map and can therefore land on
# something else. The mode bars are mutually exclusive — at most one is mounted
# at a time — but listing all four costs nothing and means a bar added later is
# covered by whichever test mounts it.
FURNITURE = [
    ".tb-panel",
    ".leaflet-control-geocoder",
    "#info-panel",
    ".cut-toolbar",
    ".merge-toolbar",
    ".trim-toolbar",
    ".outline-toolbar",
    ".draw-hint",
    ".app-dialog",
    "#version-banner",
]

# Which of the above are on screen, and where. Returned as plain numbers rather
# than as Playwright locators: the assertions are arithmetic on rectangles, and
# a round trip per edge would make them unreadable.
BOXES = """(selectors) => {
    const out = {};
    for (const selector of selectors) {
        const node = document.querySelector(selector);
        // getClientRects() rather than offsetParent: a `position: fixed` box
        // has no offset parent by definition, and the info panel is one — the
        // check that reads as "is it laid out" would have quietly dropped it
        // from every assertion below.
        if (!node || !node.getClientRects().length) continue;
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        out[selector] = {
            left: box.left, top: box.top,
            right: box.right, bottom: box.bottom,
        };
    }
    return out;
}"""

OVERLAP = """([a, b]) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 1 && y > 1;
}"""


@pytest.fixture(params=PHONES, ids=lambda size: f"{size[0]}x{size[1]}")
def browser_context_args(
    browser_context_args: dict[str, Any], request: pytest.FixtureRequest
) -> dict[str, Any]:
    """Every context in this module is a phone, at each size in turn.

    Overriding the fixture rather than resizing the page afterwards, because
    half of what is under test is not a function of the viewport at all:
    `pointer: coarse` is a property of the context, and `set_viewport_size` on
    a desktop context leaves every tap-target rule switched off.

    Parametrizing here rather than on the tests means the size is part of the
    context that is built, so a test body never has to know which phone it is
    running on — and a failure is reported against the size in its id.
    """
    width, height = request.param
    return {
        **browser_context_args,
        "viewport": {"width": width, "height": height},
        # Not `is_mobile`, which Firefox refuses outright. Touch emulation is
        # what `pointer: coarse` is derived from, and it works everywhere.
        "has_touch": True,
    }


@pytest.fixture
def phone(app_page: Page) -> Page:
    """A booted app on a phone-sized screen, with the panel expanded.

    Expanded is the state the overlap was reported in and the larger of the
    two, so it is the one that has to fit; `collapsed` below covers the other.
    A first visit at this width starts collapsed, so saying so is not
    redundant.
    """
    assert app_page.evaluate("() => matchMedia('(pointer: coarse)').matches"), (
        "the context is not emulating touch, so none of the phone styling is on"
    )
    app_page.evaluate("() => window.App.controls.setCollapsed(false)")
    return app_page


@pytest.fixture
def sample(phone: Page) -> Page:
    """The demo project, so the bars and dialogs have something to describe.

    Trim's toolbar is the widest thing the app mounts and it does not appear at
    all without an outer polygon to trim; the same goes for the territory list
    and for every count in the info panel.
    """
    assert phone.evaluate("() => window.App.demo.enter()") is True
    phone.wait_for_function("() => window.App.state.clusters.length > 0")
    return phone


def boxes(page: Page) -> dict[str, dict[str, float]]:
    return page.evaluate(BOXES, FURNITURE)


def overlaps(page: Page, one: dict[str, float], other: dict[str, float]) -> bool:
    """Do two rectangles share more than a hairline?

    A pixel of tolerance on each axis, because two boxes that merely touch —
    a panel whose bottom edge is a bar's top edge — are not on top of each
    other, and sub-pixel layout makes exact adjacency rare.
    """
    return page.evaluate(OVERLAP, [one, other])


def spills(box: dict[str, float], page: Page) -> list[str]:
    """Which viewport edges this rectangle has crossed, if any."""
    size = page.viewport_size
    assert size
    out: list[str] = []
    if box["left"] < -1:
        out.append(f"left by {-box['left']:.0f}")
    if box["right"] > size["width"] + 1:
        out.append(f"right by {box['right'] - size['width']:.0f}")
    if box["bottom"] > size["height"] + 1:
        out.append(f"bottom by {box['bottom'] - size['height']:.0f}")
    return out


# ══════════════════════════════════════════════════════════════════════════════
# THE TOP EDGE
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("collapsed", [False, True])
def test_the_search_field_never_covers_the_toolbar(phone: Page, collapsed: bool):
    """The reported bug, in both of the panel's shapes.

    Collapsed it fitted beside the field by accident — a 42 px strip leaves room
    for anything — so a fix that only moved the expanded panel would look right
    in the state where it was reported and leave the other one to break the next
    time a group gains a button. Both are asserted, and neither is allowed to
    depend on how wide the panel happens to be.
    """
    phone.evaluate("(c) => window.App.controls.setCollapsed(c)", collapsed)
    expect(phone.locator(".tb-panel")).to_be_visible()

    found = boxes(phone)
    panel, search = found[".tb-panel"], found[".leaflet-control-geocoder"]

    assert not overlaps(phone, panel, search), (
        f"the search field is drawn over the toolbar: {search} vs {panel}"
    )
    # Not merely disjoint — below. Two boxes side by side on a 360 px screen is
    # the arrangement that has just been established will not fit, so a pass
    # that came from the panel being pushed off to one side is not a pass.
    assert panel["top"] >= search["bottom"], (
        "the panel is beside the search field rather than below it"
    )


def test_the_search_field_takes_the_whole_top_edge(phone: Page):
    """It is the way into the workflow, and it is typed into rather than tapped.

    A 260 px field in the corner it shares with nothing is a field with 100 px
    of unused screen beside it, and a place name is long.
    """
    size = phone.viewport_size
    assert size
    search = boxes(phone)[".leaflet-control-geocoder"]

    assert search["right"] - search["left"] > size["width"] * 0.9
    assert not spills(search, phone)


# ══════════════════════════════════════════════════════════════════════════════
# THE SIDES
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize(
    ("name", "open_it"),
    [
        ("trim", "window.App.trim.toggle()"),
        ("merge", "document.querySelector('[data-action=merge]').click()"),
        ("cut", "document.querySelector('[data-action=cut]').click()"),
        ("shortcuts", "document.querySelector('[data-action=shortcuts]').click()"),
        ("territories", "document.querySelector('[data-action=print]').click()"),
        ("reset", "document.querySelector('[data-action=reset]').click()"),
    ],
)
def test_nothing_hangs_off_the_side_of_the_screen(
    sample: Page, name: str, open_it: str
):
    """Every bar and dialog, measured against the screen it opened on.

    The failure this catches is not a layout anyone chose. Each of these boxes
    already asks for "the viewport minus a margin" and each of them drew itself
    wider than the viewport, because the margin was subtracted from the content
    box and the padding and border were then added back on — 28 px for a mode
    bar, 44 for a dialog. On a desktop that is invisible. On a phone it is a
    slider whose right-hand end is off the screen, and a dialog whose Cancel
    button is under the bezel.

    Trim is the one worth naming: four slider rows, and the widest thing the
    app mounts.
    """
    sample.evaluate(f"() => {{ {open_it}; }}")
    found = None
    for _ in range(40):
        found = boxes(sample)
        if len(found) > 2:
            break
        sample.wait_for_timeout(100)
    assert found

    for selector, box in found.items():
        assert not spills(box, sample), (
            f"{name}: {selector} leaves the screen — {', '.join(spills(box, sample))}"
        )


# ══════════════════════════════════════════════════════════════════════════════
# THE MAP UNDER IT ALL
# ══════════════════════════════════════════════════════════════════════════════


def test_a_mode_bar_gets_the_map_to_itself(sample: Page):
    """The panel steps aside while a tool is running, and comes back after.

    Trim's bar is 250 px tall and the banner under it another 90; with a
    460 px panel above them there is no map left in between — on the one screen
    where the map is the thing being judged, since the bar is a live preview of
    a change to it. The info panel already retires here for the same reason and
    on the same flag.

    The second half is the half that would go unnoticed: a panel that steps
    aside and does not come back is a toolbar the user has lost, and the only
    way back to it is a reload.
    """
    sample.evaluate("() => window.App.trim.toggle()")
    expect(sample.locator(".trim-toolbar")).to_be_visible()
    expect(sample.locator(".tb-panel")).to_be_hidden()

    sample.evaluate("() => window.App.trim.toggle()")
    expect(sample.locator(".trim-toolbar")).to_have_count(0)
    expect(sample.locator(".tb-panel")).to_be_visible()


def test_a_closed_toolbar_costs_one_button(phone: Page):
    """Collapsed is supposed to be the compact form, and on a phone it was not.

    A column of icons is compact on a desktop, where it is 42 px wide against
    an 800 px height. On a phone the same column is 750 px of an 844 px screen:
    a wall down the left edge that scrolls, with every icon reachable and none
    of them visible. Wrapping the twenty-seven into a grid instead only moves
    that cost to the top of the screen — about a third of it either way, held
    permanently, for a toolbar nobody is using at that moment.

    So collapsed means closed here, and what is left is the button that
    reopens it. The size is asserted rather than the arrangement: what would
    undo this is a rule that puts the icons back, in whatever shape, and any
    of those shapes is bigger than a button.
    """
    phone.evaluate("() => window.App.controls.setCollapsed(true)")
    panel = boxes(phone)[".tb-panel"]

    assert panel["right"] - panel["left"] <= 56, (
        "the closed toolbar is wider than a button"
    )
    assert panel["bottom"] - panel["top"] <= 56, (
        "the closed toolbar is taller than a button"
    )
    # And it is that button: hit it and the toolbar comes back, which is the
    # half that makes the size above a saving rather than a loss.
    phone.locator(".tb-panel__collapse").click()
    expect(phone.locator(".tb-group__title").first).to_be_visible()


def test_an_open_toolbar_still_leaves_a_map(phone: Page):
    """Open, it is a menu over the map rather than a replacement for it.

    Half the screen is a floor rather than a target — a labelled toolbar of
    twenty-seven actions is not going to be small — but it has to end
    somewhere above the bottom edge, and what is past that edge has to be
    reachable by scrolling the panel rather than lost.
    """
    size = phone.viewport_size
    assert size
    panel = boxes(phone)[".tb-panel"]

    assert panel["bottom"] < size["height"] * 0.75, (
        "the open panel leaves less than a quarter of the screen"
    )
    assert (
        phone.evaluate(
            "() => { const n = document.querySelector('.tb-panel');"
            "        return getComputedStyle(n).overflowY; }"
        )
        == "auto"
    ), "a panel that outgrows its cap has to scroll, not clip"


# ══════════════════════════════════════════════════════════════════════════════
# TAP TARGETS
# ══════════════════════════════════════════════════════════════════════════════

# 44 px is Apple's published minimum and 48 dp is Android's; the number below is
# under both on purpose. These are dense bars over a map rather than a form, and
# what is being caught is the 20 px chevron and the 13 px checkbox — an order of
# magnitude away from the line — rather than a button that is 40.
TAPPABLE = 32

TARGETS = """(floor) => {
    const small = new Set();
    document.querySelectorAll(
        "button, .tb-item, input[type=checkbox], input[type=range]"
    ).forEach((node) => {
        // A checkbox is an 18 px box inside a label whose whole row toggles it,
        // so the box is not what a finger has to land on. Measure what is.
        const target = node.closest("label") || node;
        if (!target.offsetParent) return;
        const box = target.getBoundingClientRect();
        if (!box.width || !box.height) return;
        if (box.width >= floor && box.height >= floor) return;
        small.add(
            (target.className || target.tagName) + " " +
            Math.round(box.width) + "x" + Math.round(box.height)
        );
    });
    return [...small];
}"""


@pytest.mark.parametrize(
    ("name", "open_it"),
    [
        ("toolbar", ""),
        ("trim", "window.App.trim.toggle()"),
        ("territories", "document.querySelector('[data-action=print]').click()"),
        ("reset", "document.querySelector('[data-action=reset]').click()"),
    ],
)
def test_what_you_have_to_tap_is_big_enough_to_tap(
    sample: Page, name: str, open_it: str
):
    """A fingertip covers about 8 mm and hides what it is aiming at.

    It also gets no tooltip, so a control that is hard to hit is a control whose
    purpose is discovered by hitting the wrong one. The sizes this guards are in
    the Touch targets block at the end of style.css, keyed on `pointer: coarse`
    rather than on width — a tablet in landscape is 1024 px wide and still has
    no cursor.
    """
    if open_it:
        sample.evaluate(f"() => {{ {open_it}; }}")
        sample.wait_for_timeout(400)

    small = sample.evaluate(TARGETS, TAPPABLE)
    assert not small, f"{name}: under {TAPPABLE}px — {small}"


# ══════════════════════════════════════════════════════════════════════════════
# THE PRINT DIALOG
# ══════════════════════════════════════════════════════════════════════════════

# The one dialog that is taller than a phone by several screens, and the only
# one whose action bar is `position: sticky`. Everything below is about that
# combination.
A_CARD = """() => {
    const first = window.App.state.clusters[0];
    window.App.print.printCluster(first.feature || first.layer.toGeoJSON());
}"""


@pytest.fixture
def card(sample: Page) -> Page:
    sample.evaluate(A_CARD)
    expect(sample.locator(".print-dialog")).to_be_visible()
    # The preview renders asynchronously and the controls below it are what
    # make the dialog tall enough to scroll, which is the whole subject here.
    sample.wait_for_function(
        """() => {
            const d = document.querySelector('.print-dialog');
            return d && d.scrollHeight > d.clientHeight + 40;
        }""",
        timeout=20000,
    )
    return sample


def test_the_action_bar_sits_on_the_floor_of_the_dialog(card: Page):
    """Sticky pins a box to the content edge, and padding is below that.

    The dialog carries 16 px of bottom padding and the bar is `sticky;
    bottom: 0`, so the bar came to rest 16 px short of the dialog's inside
    edge — with the settings, which are what scrolls, still running through
    the strip underneath it. What that looks like is three buttons floating
    in a gap: dialog content above them, and the top of another fieldset
    showing below.

    Asserted as a relation between two edges rather than as a padding value,
    because what matters is that nothing can appear under the bar, and any
    number of rules could put a gap back.
    """
    edges = card.evaluate("""() => {
        const dialog = document.querySelector('.print-dialog');
        const bar = document.querySelector('.print-dialog__actions');
        const cs = getComputedStyle(dialog);
        const box = dialog.getBoundingClientRect();
        return {
            inside: box.bottom - parseFloat(cs.borderBottomWidth),
            bar: bar.getBoundingClientRect().bottom,
        };
    }""")

    assert edges["bar"] >= edges["inside"] - 1, (
        f"a {edges['inside'] - edges['bar']:.0f} px strip of scrolling content "
        "shows below the action bar"
    )


def test_the_action_bar_is_not_a_third_of_the_screen(card: Page):
    """Its buttons were a size up from every other dialog's, and stacked.

    15 px on 18 px of padding, against the shared 13 on 14, plus a rule that
    gave Cancel a line of its own: three verbs came to 111 px of a 844 px
    screen. The size said "these finish the job", which is worth a wide
    dialog's floor and is not worth this.
    """
    size = card.viewport_size
    assert size
    bar = card.evaluate("""() => {
        const n = document.querySelector('.print-dialog__actions');
        const r = n.getBoundingClientRect();
        const buttons = [...n.querySelectorAll('.btn')].filter(b => b.offsetParent);
        return {
            height: r.height,
            width: r.width,
            widest: Math.max(...buttons.map(b => b.getBoundingClientRect().width)),
            clipped: buttons.filter(b => b.scrollWidth > b.clientWidth + 1)
                         .map(b => b.textContent.trim()),
        };
    }""")

    assert bar["height"] <= size["height"] * 0.1, (
        f"the action bar is {bar['height']:.0f} px of a {size['height']} px screen"
    )
    # One row of three, not one full-width button and a row of two: a button as
    # wide as the bar is a button that has a line to itself.
    assert bar["widest"] < bar["width"] * 0.8, "a button has the row to itself"
    assert not bar["clipped"], f"the label does not fit its button: {bar['clipped']}"


# ══════════════════════════════════════════════════════════════════════════════
# THE INFO PANEL
# ══════════════════════════════════════════════════════════════════════════════


def test_the_counts_do_not_explain_a_mouse_to_a_phone(sample: Page):
    """The line under the counts names a right-click and a keyboard shortcut.

    Leaflet turns a long press into a `contextmenu`, so the menu it points at
    is reachable — but not by the gesture it names, and there is no Ctrl+Z on
    a phone at all. It is also two wrapped lines, which made it the tallest
    thing in a panel that already sits in the corner where the attribution and
    the mode bars are.
    """
    panel = boxes(sample)["#info-panel"]
    size = sample.viewport_size
    assert size

    assert (
        sample.evaluate(
            "() => getComputedStyle(document.querySelector('.info-panel__hint')).display"
        )
        == "none"
    )
    assert (panel["bottom"] - panel["top"]) < size["height"] * 0.2, (
        "the readout takes a fifth of the screen"
    )
    # The counts themselves stay — hiding the hint is not hiding the panel.
    expect(sample.locator(".info-panel__stats")).to_be_visible()


# ══════════════════════════════════════════════════════════════════════════════
# THE GUIDED TOUR
# ══════════════════════════════════════════════════════════════════════════════

# How much of the spotlight a step is allowed to hide behind its own card.
#
# Not zero, and it cannot be. Six of the steps point at something that fills the
# screen — the toolbar panel, the trim bar, the territory list, the print
# controls — and the card is 336 px wide and as tall as its paragraph, so on a
# 740 px phone there is no arrangement in which both fit whole. The trim bar is
# the worst of them at 449 px of that screen, and a card anywhere on it leaves
# about 36%.
#
# The number is deliberately low, because the alternative was worse and was
# measured: capping the card at 320 px lifted this to 66% and put 555 px of
# paragraph behind a scroll nobody would think to try. A subject three quarters
# visible is a step that works; a sentence cut mid-word is a step that does not.
#
# So the floor is a sanity check and AT_EDGE below is the real assertion: what
# the placement owes is the best of the available positions rather than the
# worst, and the worst was what it took.
VISIBLE = 0.35

# How close to a viewport edge counts as against it. tour.js keeps a 12 px
# margin (EDGE there), and sub-pixel layout does the rest.
AT_EDGE = 14

STEP = """() => {
    const spot = document.querySelector('.tour__spot:not(.tour__origin)');
    const bubble = document.querySelector('.tour__bubble');
    if (!bubble) return null;
    const shown = (n) => n && !n.hasAttribute('hidden') &&
                         getComputedStyle(n).display !== 'none' &&
                         !n.classList.contains('tour__spot--none');
    const box = bubble.getBoundingClientRect();
    const out = {
        title: (document.querySelector('.tour__title') || {}).textContent || '',
        last: document.querySelector('.tour__next').dataset.i18n === 'tour.finish',
        bubbleOnScreen: box.left >= -1 && box.top >= -1 &&
                        box.right <= innerWidth + 1 &&
                        box.bottom <= innerHeight + 1,
        atEdge: box.left <= 14 || box.top <= 14 ||
                box.right >= innerWidth - 14 || box.bottom >= innerHeight - 14,
        card: [box.left, box.top, box.width, box.height].map(Math.round),
        spotBox: null,
        visible: null,
    };
    if (!shown(spot)) return out;   // a step with no target is a centred card

    // Where the step put the frame, not where the frame has got to. The
    // spotlight eases into place over 0.2s and re-aims whenever its target
    // moves — the bars grow a line, the banner under them rewraps — so its
    // rendered box is a question about animation timing, and this is a
    // question about placement. _placeSpot writes the destination into
    // `style`; the card has no transition, so its own box already is one.
    const s = {
        left: parseFloat(spot.style.left), top: parseFloat(spot.style.top),
        width: parseFloat(spot.style.width), height: parseFloat(spot.style.height),
    };
    if ([s.left, s.top, s.width, s.height].some(isNaN)) return out;
    s.right = s.left + s.width;
    s.bottom = s.top + s.height;
    out.spotBox = [s.left, s.top, s.width, s.height].map(Math.round);
    const on = {
        left: Math.max(s.left, 0), top: Math.max(s.top, 0),
        right: Math.min(s.right, innerWidth), bottom: Math.min(s.bottom, innerHeight),
    };
    const area = Math.max(0, on.right - on.left) * Math.max(0, on.bottom - on.top);
    if (!area) { out.visible = 0; return out; }

    const wide = Math.min(box.right, on.right) - Math.max(box.left, on.left);
    const tall = Math.min(box.bottom, on.bottom) - Math.max(box.top, on.top);
    const hidden = wide > 0 && tall > 0 ? wide * tall : 0;
    out.visible = (area - hidden) / area;
    return out;
}"""


def test_every_tour_step_leaves_its_subject_in_view(phone: Page):
    """A walkthrough that covers what it is pointing at explains nothing.

    _placeBubble tries the step's preferred side, then the other three, and
    every one of those is beside the target by construction. What it did when
    all four failed — which on a phone is any step whose target is wider than
    the screen minus a card — was centre the card, which is the one position
    guaranteed to be on top of the target. It now falls back to the edge of the
    viewport that hides least of the spotlight instead, and the card is capped
    so that "least" is usually none.

    Every step is walked rather than a chosen few: the placement depends on the
    target's size and position and on how long the translated body turned out
    to be, and those vary per step in ways no sample of three would cover.
    """
    phone.evaluate("() => window.App.tour.start()")
    expect(phone.locator(".tour__bubble")).to_be_visible()

    seen = 0
    worst: list[str] = []
    while seen < 60:
        phone.wait_for_timeout(250)
        step = phone.evaluate(STEP)
        if step is None:
            break
        seen += 1
        assert step["bubbleOnScreen"], f'"{step["title"]}": the card is off screen'
        if step["visible"] is not None:
            if step["visible"] < VISIBLE:
                worst.append(f'"{step["title"]}" {step["visible"]:.0%} visible')
            # A card that has to overlap has to be out of the way as far as it
            # can go, which means against an edge of the screen. Anywhere else
            # — the middle, most of all — cuts the target in two and hides more
            # of it than any edge would.
            #
            # 99% rather than 100%: a card placed beside its target clears the
            # spotlight by 8 px, and the frame is still easing the last pixel
            # of a 0.2 s transition into place when this reads it. A sliver is
            # arithmetic, not a card in the way.
            elif step["visible"] < 0.99 and not step["atEdge"]:
                worst.append(
                    f'"{step["title"]}" overlaps from the middle '
                    f"({step['visible']:.0%} visible, card at {step['card']}, "
                    f"spot at {step['spotBox']})"
                )
        if step["last"]:
            break
        phone.locator(".tour__next").click()

    assert seen > 20, f"only walked {seen} steps — the tour stopped early"
    assert not worst, "the card is on top of what the step points at: " + "; ".join(
        worst
    )


# Whether the control the current step is about is inside everything that
# scrolls above it. Vertical only: nothing the tour points at sits in a
# sideways scroller, and the toolbar panel — which is the one that hides
# things — caps its height and lets its width wrap.
REACHED = """() => {
    const id = window.App.tour.stepId();
    if (!id) return null;
    const step = window.App.tour.steps().find((s) => s.id === id);
    const out = { id, done: false, hiddenBy: null, by: 0 };
    out.done = document.querySelector('.tour__next').dataset.i18n === 'tour.finish';
    if (!step || !step.target) return out;

    const node = document.querySelector(step.target);
    if (!node) return out;   // a step whose target is gone is another test's

    for (let el = node.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowY === 'visible') continue;
        if (el.scrollHeight <= el.clientHeight) continue;

        const view = el.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        // A target taller than the scroller it is in — the toolbar panel on a
        // short screen, the print dialog's settings column — can only ever be
        // partly in view, and every scroll position hides one end of it. What
        // it owes is that some of it is on screen.
        const short = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
        const enough = box.height <= view.height ? box.height - 1 : 1;
        if (short < enough) {
            out.hiddenBy = String(el.className || el.tagName).split(' ')[0];
            out.by = Math.round(Math.max(box.height, 1) - Math.max(short, 0));
            return out;
        }
    }
    return out;
}"""


def test_no_step_explains_a_control_that_is_scrolled_out_of_view(phone: Page):
    """The panel a step points into is a scroller, and it was scrolling.

    The toolbar caps at 72% of the height here and the groups past the cap are
    reached by swiping it, so the buttons the last third of the tour is about —
    Reset, the language picker, the shortcut list — are below the fold from the
    moment the panel opens. Nothing about those steps failed: the button has a
    box, so it is found, and the spotlight is then clipped away against the
    panel that is hiding it, leaving a card explaining a control that is
    nowhere on the screen. The reader cannot even swipe it into view, because
    the tour's veil is over the panel.

    Asserted on the target rather than on the spotlight, and per scroller
    rather than per viewport: a frame drawn inside a panel scrolled elsewhere
    is on the screen and is still pointing at nothing.
    """
    phone.evaluate("() => window.App.tour.start()")
    expect(phone.locator(".tour__bubble")).to_be_visible()

    seen = 0
    lost: list[str] = []
    while seen < 60:
        phone.wait_for_timeout(250)
        step = phone.evaluate(REACHED)
        if step is None:
            break
        seen += 1
        if step["hiddenBy"]:
            lost.append(f'"{step["id"]}" by {step["by"]} px inside .{step["hiddenBy"]}')
        if step["done"]:
            break
        phone.locator(".tour__next").click()

    assert seen > 20, f"only walked {seen} steps — the tour stopped early"
    assert not lost, "the step points at something scrolled out of sight: " + "; ".join(
        lost
    )


# A phone held sideways. Not in PHONES, because it is not a second phone to run
# every assertion in this file against — it is one arrangement, and the one that
# was broken: 844 px is wide enough to miss every `max-width: 720px` rule in the
# stylesheet while being 390 px tall.
LANDSCAPE: ViewportSize = {"width": 844, "height": 390}

# Where the card is, whether it fits, and whether its text does.
CARD = """() => {
    const card = document.querySelector('.tour__bubble');
    if (!card) return null;
    const body = document.querySelector('.tour__body');
    const box = card.getBoundingClientRect();
    const next = document.querySelector('.tour__next').getBoundingClientRect();
    return {
        title: (document.querySelector('.tour__title') || {}).textContent || '',
        last: document.querySelector('.tour__next').dataset.i18n === 'tour.finish',
        fits: box.top >= -1 && box.left >= -1 &&
              box.bottom <= innerHeight + 1 && box.right <= innerWidth + 1,
        box: [Math.round(box.left), Math.round(box.top),
              Math.round(box.width), Math.round(box.height)],
        // The one control that must never be off screen: without it the
        // walkthrough can be read and not continued.
        nextOnScreen: next.bottom <= innerHeight + 1 && next.top >= -1,
    };
}"""


# The step on screen is no longer the one that was on screen.
#
# Clicking Next returns as soon as the event is dispatched, and the predicate
# above can be satisfied by the *previous* step — which has been settled and
# quiet for as long as it took to read it. Waiting for the title to turn over
# first is what makes "settled" mean this step rather than the last one.
ARRIVED = """(was) => {
    const title = document.querySelector('.tour__title');
    return !title || title.textContent !== was;
}"""


def walk_the_tour(page: Page, probe: str) -> list[dict[str, Any]]:
    """Every step in order, with `probe` evaluated once each has settled."""
    page.evaluate("() => window.App.tour.start()")
    expect(page.locator(".tour__bubble")).to_be_visible()
    seen: list[dict[str, Any]] = []
    while len(seen) < 60:
        if seen:
            page.wait_for_function(ARRIVED, arg=seen[-1]["title"], timeout=5000)
        step = page.evaluate(probe)
        if step is None:
            break
        seen.append(step)
        if step["last"]:
            break
        page.locator(".tour__next").click()
    assert len(seen) > 20, f"only walked {len(seen)} steps — the tour stopped early"
    return seen


def test_the_tour_card_fits_the_screen_in_both_orientations(page: Page):
    """Rotate the phone and the card ran off the bottom, Next with it.

    The cap that keeps the card on screen was written into the phone layout,
    which is keyed on width — and a phone on its side is 844 px wide, so it got
    the desktop treatment on a 390 px-tall screen. Two of the thirty-seven steps
    overflowed at 844x390 and five at 740x360, and what overflowed was the end
    of the card: Back, Next, and the checkbox that stops the tour coming back.

    Driving its own viewport rather than taking the module's fixture, because
    the assertion is about the pair of orientations, and a fixture parametrized
    on one size can only ever see half of it.
    """
    for size in (LANDSCAPE, cast(ViewportSize, {"width": 390, "height": 844})):
        page.set_viewport_size(size)
        page.goto("/?tour=0")
        expect(page.locator(".tb-panel")).to_be_visible()
        where = f"{size['width']}x{size['height']}"

        for step in walk_the_tour(page, CARD):
            assert step["fits"], (
                f'{where} "{step["title"]}": the card is {step["box"]} on this screen'
            )
            assert step["nextOnScreen"], (
                f'{where} "{step["title"]}": Next is off screen'
            )


def test_a_step_never_rings_a_control_you_cannot_see(sample: Page):
    """The second, dashed ring says "and this is the button that opened it".

    It was drawn wherever that button's box happened to be, which on a wide
    window is beside the dialog and on a phone is behind it — the dialog is the
    width of the screen there. What that draws is a dashed rectangle around a
    paragraph of dialog text, which is worse than drawing nothing: it says the
    control is there, and it is not.
    """
    for step in walk_the_tour(
        sample,
        """() => {
            if (!document.querySelector('.tour__bubble')) return null;
            const ring = document.querySelector('.tour__origin');
            const out = {
                title: (document.querySelector('.tour__title')||{}).textContent || '',
                last: document.querySelector('.tour__next').dataset.i18n === 'tour.finish',
                framed: null,
            };
            if (!ring || ring.hasAttribute('hidden') ||
                getComputedStyle(ring).display === 'none') return out;
            // What is painted inside the ring, ignoring the two see-through
            // layers: the tour's own click-catcher, and the dialog veil, which
            // is 18% black and hides nothing.
            const r = ring.getBoundingClientRect();
            out.framed = document.elementsFromPoint(
                    r.left + r.width / 2, r.top + r.height / 2)
                .filter(n => !n.closest('.tour') &&
                             !n.classList.contains('dialog-veil'))
                .map(n => (n.className || n.tagName).toString())[0] || '';
            return out;
        }""",
    ):
        if not isinstance(step["framed"], dict):
            continue

        assert "tb-" in step["framed"], (
            f'"{step["title"]}": the origin ring is drawn around '
            f"{step['framed']!r} rather than around a toolbar button"
        )


def test_the_spotlight_is_always_somewhere_on_the_screen(sample: Page):
    """The print view is three screens tall on a phone.

    A ring around all of it has its top edge above the fold and its bottom two
    screens below, so what is left on screen is a blue line down each side and
    nothing joining them — decoration rather than a highlight. Framing the part
    that is on screen closes the box at the edge and says the same thing.
    """
    for step in walk_the_tour(
        sample,
        """() => {
            if (!document.querySelector('.tour__bubble')) return null;
            const spot = document.querySelector('.tour__spot:not(.tour__origin)');
            const out = {
                title: (document.querySelector('.tour__title')||{}).textContent || '',
                last: document.querySelector('.tour__next').dataset.i18n === 'tour.finish',
                outside: null,
            };
            if (!spot || spot.hasAttribute('hidden') ||
                getComputedStyle(spot).display === 'none' ||
                spot.classList.contains('tour__spot--none')) return out;
            const s = spot.getBoundingClientRect();
            const on = Math.max(0, Math.min(s.right, innerWidth) - Math.max(s.left, 0)) *
                       Math.max(0, Math.min(s.bottom, innerHeight) - Math.max(s.top, 0));
            // A zero-area frame has not been drawn yet rather than left the
            // screen, and there is nothing to measure either way.
            if (!s.width || !s.height) return out;
            out.outside = +(1 - on / (s.width * s.height)).toFixed(2);
            return out;
        }""",
    ):
        if not isinstance(step["outside"], (int, float)):
            continue

        assert step["outside"] <= 0.02, (
            f'"{step["title"]}": {step["outside"]:.0%} of the spotlight is off '
            "the screen, so what it draws is not a frame round anything"
        )


# The four modal tool bars, which are the targets that are still moving when
# the step that points at them is drawn: each arrives with `mode-bar-in`, which
# starts it 10 px low, and trim then grows a status line a debounce later.
MOVERS = {".trim-toolbar", ".cut-toolbar", ".merge-toolbar", ".outline-toolbar"}

# The spotlight, its target, and the gap between them. tour.js inflates the
# frame by PAD on every side and clamps it to the screen, so a target that fits
# should be framed exactly and one that does not is not this test's business.
FRAME = """(selector) => {
    const spot = document.querySelector('.tour__spot:not(.tour__origin)');
    const node = selector ? document.querySelector(selector) : null;
    if (!spot || !node || spot.hasAttribute('hidden') ||
        getComputedStyle(spot).display === 'none' ||
        spot.classList.contains('tour__spot--none')) return null;
    const PAD = 6;
    const t = node.getBoundingClientRect();
    const s = spot.getBoundingClientRect();
    if (t.left < 0 || t.top < 0 ||
        t.right > innerWidth || t.bottom > innerHeight) return null;  // clamped
    return {
        dx: s.left - (t.left - PAD), dy: s.top - (t.top - PAD),
        dw: s.width - (t.width + 2 * PAD), dh: s.height - (t.height + 2 * PAD),
        target: [Math.round(t.left), Math.round(t.top),
                 Math.round(t.width), Math.round(t.height)],
        spot: [Math.round(s.left), Math.round(s.top),
               Math.round(s.width), Math.round(s.height)],
    };
}"""


def test_the_spotlight_lands_on_a_target_that_is_still_moving(page: Page):
    """The frame was drawn once, on the frame the step opened.

    Half of what a step can point at is not finished moving by then. The four
    mode bars arrive with `mode-bar-in`, which starts them 10 px low and slides
    them up over 0.18s, and getBoundingClientRect() reports the transformed box
    — so the frame was drawn 10 px below the bar and stayed there. Trim is
    worse: its status line arrives with the first proposal, a debounce later,
    and the bar is anchored to the bottom of the map, so its top edge moves up
    another 16 px after the tour has stopped looking. That frame was out by 26.

    A single viewport and only the steps that point at a bar: what is under
    test is whether the frame follows, and every other step's target is still
    by the time it is drawn.
    """
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto("/?tour=0")
    expect(page.locator(".tb-panel")).to_be_visible()

    # The running tour is a filtered copy of STEPS, so the two cannot be
    # walked by index. Key on the title each step actually shows.
    targets = page.evaluate("""() => {
        const out = {};
        window.App.tour.steps().forEach(s => {
            out[window.App.i18n.t(window.App.tour.titleKey(s))] = s.target || '';
        });
        return out;
    }""")

    page.evaluate("() => window.App.tour.start()")
    expect(page.locator(".tour__bubble")).to_be_visible()

    checked = 0
    for _ in range(60):
        title = page.evaluate(
            "() => { const n = document.querySelector('.tour__title');"
            "        return n ? n.textContent : null; }"
        )
        if title is None:
            break
        selector = targets.get(title, "")
        if selector in MOVERS:
            # Long enough for the slide to finish and for trim's first
            # proposal to land, which is what the frame has to follow.
            page.wait_for_timeout(1500)
            frame = page.evaluate(FRAME, selector)
            assert frame, f'"{title}": no spotlight on {selector}'
            assert max(abs(frame[d]) for d in ("dx", "dy", "dw", "dh")) < 1, (
                f'"{title}": the frame is at {frame["spot"]} and {selector} is '
                f"at {frame['target']}"
            )
            checked += 1
        else:
            page.wait_for_timeout(120)
        nxt = page.locator(".tour__next")
        last = nxt.get_attribute("data-i18n") == "tour.finish"
        nxt.click()
        if last:
            break

    assert checked >= 3, f"only reached {checked} of the mode-bar steps"


# ══════════════════════════════════════════════════════════════════════════════
# THE TOOLBAR'S TWO DROP-DOWNS
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("tile", [".lang-select", ".basemap-select"])
def test_a_drop_down_opens_the_app_s_own_menu_under_its_tile(sample: Page, tile: str):
    """Both of these were a <select> stretched invisibly over the tile.

    The list a <select> opens belongs to the browser, which places and sizes it
    from the control — and the control here is 80 px wide, 13 px in font and
    `opacity: 0`. What came of that varied by platform and was small on all of
    them; on the ones that align the current option with the control rather
    than hanging the list below it, it also appeared nowhere near the tile.

    So the assertions are the two halves of that complaint: the list is under
    the tile it belongs to, and its rows are the size a finger needs.
    """
    sample.locator(tile).click()
    menu = sample.locator(".polygon-context-menu")
    expect(menu).to_be_visible()

    shape = sample.evaluate(
        """(tile) => {
            const m = document.querySelector('.polygon-context-menu');
            const t = document.querySelector(tile).getBoundingClientRect();
            const r = m.getBoundingClientRect();
            const rows = [...m.querySelectorAll('.polygon-context-menu-item')]
                .map(n => n.getBoundingClientRect());
            return {
                dx: Math.abs(r.left - t.left),
                below: r.top >= t.bottom - 1,
                onScreen: r.left >= -1 && r.top >= -1 &&
                          r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
                rows: rows.length,
                shortest: Math.min(...rows.map(b => b.height)),
                narrowest: Math.min(...rows.map(b => b.width)),
            };
        }""",
        tile,
    )

    assert shape["rows"] >= 2, "a picker with fewer than two choices is not a picker"
    assert shape["dx"] <= 2, f"the menu starts {shape['dx']:.0f} px from its tile"
    assert shape["below"], "the menu is not under the tile it belongs to"
    assert shape["onScreen"], "the menu is off the screen"
    assert shape["shortest"] >= TAPPABLE, f"a row is {shape['shortest']:.0f} px tall"
    # Sized by its content rather than by the 80 px tile it hangs from, which
    # is the half of the old behavior that made it unreadable.
    assert shape["narrowest"] > 100, (
        f"the menu is {shape['narrowest']:.0f} px wide — as narrow as the tile"
    )
