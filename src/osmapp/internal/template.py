"""Work out where the map belongs on a card template.

Both things needed here are genuinely drawn on the page: the placeholder is a
stroked rectangle in the content stream, and the field positions are runs of
leader dots. So they get measured. Hardcoding them meant that any edit to the
template put the map somewhere else at some other aspect ratio, quietly.
"""

import re
from typing import Any

from pypdf import PageObject, PdfReader
from pypdf.generic import ContentStream

# Wording that labels the map area. Add to it freely; where none of it shows
# up, detection falls back to the biggest rectangle with no text inside it.
MARKERS = re.compile(r"MIEJSCE NA MAP|MAPA TERENU|MAP AREA|KARTENFELD", re.IGNORECASE)
LEADER = re.compile(r"^[.\u2026]{4,}$")
MIN_SIDE_PT = 40.0  # anything thinner is a rule or a hairline, not a box
MAX_PAGE_FRACTION = 0.90  # anything bigger is the page frame, not the map box

# One PDF transformation matrix — (a b c d e f) — carried about as a tuple.
Matrix = tuple[float, float, float, float, float, float]

# A rectangle in points: x, y, width, height.
Rect = tuple[float, float, float, float]

# One run of text lifted off a page: x, y, font size, string.
TextItem = tuple[float, float, float, str]


def _mul(a: Matrix, b: Matrix) -> Matrix:
    return (
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    )


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _rectangles(page: PageObject, reader: PdfReader) -> list[Rect]:
    """Each `re` operator, pushed through whatever transform is in force.

    Following the CTM is not optional. Word processors like to wrap their
    output in a scale, and coordinates read straight off the stream come out
    wrong by exactly that factor — wrong quietly, which is the bad kind.
    """
    cs = ContentStream(page.get_contents(), reader)
    ctm: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    stack: list[Matrix] = []
    out: list[Rect] = []

    for operands, op in cs.operations:
        op = op.decode()
        if op == "q":
            stack.append(ctm)
        elif op == "Q":
            ctm = stack.pop() if stack else ctm
        elif op == "cm":
            ctm = _mul(tuple(float(v) for v in operands), ctm)  # type: ignore[arg-type]
        elif op == "re":
            x, y, w, h = (float(v) for v in operands)
            pts = [
                _apply(ctm, px, py)
                for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h))
            ]
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            out.append((min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)))
    return out


def _text_items(page: PageObject) -> list[TextItem]:
    items: list[TextItem] = []

    def visit(text: str, cm: Matrix, tm: Matrix, font: Any, size: float) -> None:
        stripped = text.strip()
        if stripped:
            items.append((float(tm[4]), float(tm[5]), float(size), stripped))

    page.extract_text(visitor_text=visit)
    return items


def _placeholder_for(page: PageObject, reader: PdfReader) -> dict[str, float] | None:
    pw, ph = float(page.mediabox.width), float(page.mediabox.height)
    page_area = pw * ph
    if page_area <= 0:
        return None

    seen: set[tuple[float, ...]] = set()
    candidates: list[Rect] = []
    for x, y, w, h in _rectangles(page, reader):
        key = tuple(round(v, 1) for v in (x, y, w, h))
        if key in seen:
            continue
        seen.add(key)
        if w < MIN_SIDE_PT or h < MIN_SIDE_PT:
            continue
        if w * h > MAX_PAGE_FRACTION * page_area:
            continue
        candidates.append((x, y, w, h))

    if not candidates:
        return None

    items = _text_items(page)
    marks: list[tuple[float, float]] = [
        (x, y) for x, y, _, t in items if MARKERS.search(t)
    ]

    def holds(rect: Rect, points: list[tuple[float, float]]) -> bool:
        x, y, w, h = rect
        return all(x <= px <= x + w and y <= py <= y + h for px, py in points)

    if marks:
        # More than one rectangle will enclose the marker; the card's own
        # frame does. Take the smallest of those and that is the map box.
        fitting = [c for c in candidates if holds(c, marks)]
        if fitting:
            best = min(fitting, key=lambda c: c[2] * c[3])
            return dict(zip(("x", "y", "width", "height"), best))

    # Nothing marked: fall back to the biggest rectangle holding no text.
    empties = [
        c for c in candidates if not any(holds(c, [(x, y)]) for x, y, _, _ in items)
    ]
    pool = empties or candidates
    best = max(pool, key=lambda c: c[2] * c[3])
    return dict(zip(("x", "y", "width", "height"), best))


def _fields_for(page: PageObject) -> dict[str, dict[str, float]]:
    """Runs of leader dots, read left to right, are where the fields get written."""
    leaders: list[tuple[float, float, float]] = sorted(
        ((x, y, size) for x, y, size, t in _text_items(page) if LEADER.match(t)),
        key=lambda item: item[0],
    )
    names = ("locality", "territory")
    return {
        name: {
            "x": round(x + 3, 2),
            "y": round(y + 5, 2),
            "size": round(size, 1),
        }
        for name, (x, y, size) in zip(names, leaders)
    }


def inspect_template(stream: Any) -> dict[str, Any]:
    """For one card template: page size, the map box, and where the fields go."""
    reader = PdfReader(stream)
    if reader.is_encrypted:
        raise ValueError("encrypted template")

    for index, page in enumerate(reader.pages):
        if int(page.get("/Rotate", 0) or 0) % 360:
            continue
        placeholder = _placeholder_for(page, reader)
        if not placeholder:
            continue
        return {
            "page": index,
            "pageWidth": round(float(page.mediabox.width), 2),
            "pageHeight": round(float(page.mediabox.height), 2),
            "placeholder": {k: round(v, 2) for k, v in placeholder.items()},
            "fields": _fields_for(page),
        }

    raise ValueError("no usable placeholder rectangle")
