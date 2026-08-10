"""The project embedded in a printed card.

A territory card is the artefact that actually survives: it gets printed,
carried around, handed on and filed, while the browser tab it came from is
closed by the end of the afternoon. Embedding the project in it makes the
sheet a restore point — hand somebody last round's cards and they can rebuild
the map from one of them.

Two decisions carry the feature, and both are easy to get wrong in ways that
only show up much later:

  • It is a real PDF attachment (/Names /EmbeddedFiles), not bytes appended
    after %%EOF. Trailing bytes survive being read and do not survive being
    *rewritten*, and a PDF is rewritten by Preview's save, by Acrobat, by
    print-to-PDF, by plenty of mail gateways. The failure is silent and
    arrives weeks later on somebody else's copy.
  • The OSM cache is stripped before the payload is attached. It is the bulk
    of an export by an order of magnitude and it is the one part that can be
    downloaded again.

The size assertion below is the guard on the second one: it is not about
bytes for their own sake, it is about noticing the day somebody attaches
buildPayload() instead of buildAttachmentPayload().
"""

import base64
import gzip
import json
from io import BytesIO
from typing import Any, cast

import pytest
from flask import Flask
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas

from osmapp.internal import pdf as pdf_module
from osmapp.internal.config import FONT_PATH
from osmapp.internal.pdf import PROJECT_ATTACHMENT_NAME

# A 1×1 PNG — compose_pdf only has to be able to draw it.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

PLACEHOLDER = {"page": "0", "x": "60", "y": "400", "width": "300", "height": "250"}


@pytest.fixture
def pdf_client():
    """Only the pdf blueprint: this needs no Overpass and no osmnx settings."""
    app = Flask(__name__)
    app.register_blueprint(pdf_module.bp)
    return app.test_client()


def make_template() -> bytes:
    """A page with a placeholder box compose_pdf can stamp into."""
    buf = BytesIO()
    pdf = rl_canvas.Canvas(buf, pagesize=A4)
    pdf.setFont("Helvetica", 9)
    pdf.rect(60, 400, 300, 250)
    pdf.drawString(100, 500, "MIEJSCE NA MAPĘ")
    pdf.showPage()
    pdf.save()
    return buf.getvalue()


PROJECT: dict[str, Any] = {
    "version": 1,
    "exportedAt": "2026-01-01T00:00:00.000Z",
    "outerPolygon": {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": []},
    },
    "bounds": {"north": 1.0, "south": 0.0, "east": 1.0, "west": 0.0},
    "clusters": [{"type": "Feature", "properties": {"printed": True}, "geometry": {}}],
    "partial": True,
}


def compose(
    client: Any, project: bytes | None = None, info: list[str] | None = None
) -> Any:
    data: dict[str, Any] = {
        "template": (BytesIO(make_template()), "template.pdf"),
        "image": (BytesIO(PNG), "map.png"),
        **PLACEHOLDER,
    }
    if project is not None:
        data["project"] = (BytesIO(project), "osmapp-project.json")
    if info is not None:
        data["info"] = info
    return client.post("/compose_pdf", data=data, content_type="multipart/form-data")


def needs_font() -> None:
    """The Unicode font is a Git LFS object; a checkout without LFS has a
    131-byte pointer in its place and reportlab refuses it."""
    if FONT_PATH.stat().st_size < 10_000:
        pytest.skip("DejaVuSans.ttf is a Git LFS pointer — run `git lfs pull`")


def extract(client: Any, blob: bytes) -> Any:
    return client.post(
        "/extract_project",
        data={"pdf": (BytesIO(blob), "card.pdf")},
        content_type="multipart/form-data",
    )


# ── the round trip ────────────────────────────────────────────────────────────


def test_a_card_carries_the_project_it_was_printed_from(pdf_client: Any):
    composed = compose(pdf_client, json.dumps(PROJECT).encode())
    assert composed.status_code == 200

    read_back = extract(pdf_client, composed.data)
    assert read_back.status_code == 200
    assert read_back.get_json() == PROJECT


def test_the_project_is_a_real_attachment_not_trailing_bytes(pdf_client: Any):
    """The distinction the whole design rests on.

    Bytes after %%EOF read back fine and are destroyed by the first tool that
    rewrites the file. An embedded file is a catalog entry that a faithful
    rewrite carries across — so the test is that the payload survives being
    cloned by something that knows nothing about this app.
    """
    composed = compose(pdf_client, json.dumps(PROJECT).encode())
    assert PROJECT_ATTACHMENT_NAME in PdfReader(BytesIO(composed.data)).attachments

    rewritten = BytesIO()
    PdfWriter(clone_from=PdfReader(BytesIO(composed.data))).write(rewritten)
    rewritten.seek(0)

    assert extract(pdf_client, rewritten.getvalue()).get_json() == PROJECT


def test_the_payload_is_compressed(pdf_client: Any):
    """Coordinates are repetitive digits, and a card has to stay emailable."""
    composed = compose(pdf_client, json.dumps(PROJECT).encode())
    stored = PdfReader(BytesIO(composed.data)).attachments[PROJECT_ATTACHMENT_NAME][-1]

    # Stored gzipped: decompressing must work and must give the JSON back.
    assert json.loads(gzip.decompress(stored).decode("utf-8")) == PROJECT


def test_attaching_a_project_barely_changes_the_size(pdf_client: Any):
    """The guard against attaching the OSM cache by accident.

    buildAttachmentPayload strips `streets` and `buildings`; buildPayload does
    not. Swapping one for the other on the client is a one-word change that
    would multiply every card by an order of magnitude, and nothing on screen
    would say so.
    """
    plain = compose(pdf_client)
    with_project = compose(pdf_client, json.dumps(PROJECT).encode())

    overhead = len(with_project.data) - len(plain.data)
    assert 0 < overhead < 4096, f"attachment cost {overhead} bytes"


# ── what must not happen ──────────────────────────────────────────────────────


def test_a_card_printed_without_a_project_says_so(pdf_client: Any):
    """404 rather than a broken import: the file is fine, it just has no project."""
    plain = compose(pdf_client)
    response = extract(pdf_client, plain.data)
    assert response.status_code == 404
    assert "project" in response.get_json()["error"].lower()


def test_a_payload_that_is_not_json_is_refused_rather_than_embedded(pdf_client: Any):
    """This ends up in a file handed to other people.

    "Whatever bytes the browser sent" is not a thing to put in one, and a card
    that silently carried a corrupt project would only be discovered by the
    person trying to restore from it.
    """
    response = compose(pdf_client, b"<not json at all>")
    assert response.status_code == 400
    assert "json" in response.get_json()["error"].lower()


def test_a_payload_that_is_not_an_object_is_refused(pdf_client: Any):
    assert compose(pdf_client, b"[1, 2, 3]").status_code == 400


def test_something_that_is_not_a_pdf_is_reported_as_such(pdf_client: Any):
    response = extract(pdf_client, b"hello, I am not a PDF")
    assert response.status_code == 400
    assert "pdf" in response.get_json()["error"].lower()


def test_a_damaged_attachment_is_reported_rather_than_returned(pdf_client: Any):
    """A card can be edited by anything; the payload is not to be trusted."""
    writer = PdfWriter(clone_from=PdfReader(BytesIO(make_template())))
    writer.add_attachment(PROJECT_ATTACHMENT_NAME, gzip.compress(b"{ broken"))
    buf = BytesIO()
    writer.write(buf)

    response = extract(pdf_client, buf.getvalue())
    assert response.status_code == 422


def test_an_uncompressed_attachment_is_still_readable(pdf_client: Any):
    """Forward compatibility with anything written before compression."""
    writer = PdfWriter(clone_from=PdfReader(BytesIO(make_template())))
    writer.add_attachment(PROJECT_ATTACHMENT_NAME, json.dumps(PROJECT).encode())
    buf = BytesIO()
    writer.write(buf)

    assert extract(pdf_client, buf.getvalue()).get_json() == PROJECT


def test_a_missing_file_is_a_client_error(pdf_client: Any):
    response = pdf_client.post(
        "/extract_project", data={}, content_type="multipart/form-data"
    )
    assert response.status_code == 400


# ── the map actually reaching the page ────────────────────────────────────────
#
# Every test above asks what the card *carries*. None of them asked whether
# the card has a map on it, and for a while it did not: the overlay was merged
# into the reader's page while the writer took its copy of the document from
# the reader beforehand, so the merge landed on a page that was never written.
# The response was a valid PDF of the correct size with a 200 on it, the
# preview in the dialog was correct throughout, and the only symptom was a
# printed card that came out as the bare template.


def page_images(blob: bytes, index: int = 0) -> list[Any]:
    """The image XObjects on a page — the map is the only one a card has."""
    page = PdfReader(BytesIO(blob)).pages[index]
    resources = cast(dict[str, Any], page.get("/Resources") or {})
    xobjects = resources.get("/XObject")
    if xobjects is None:
        return []
    xobjects = xobjects.get_object()
    return [
        name
        for name in xobjects
        if xobjects[name].get_object().get("/Subtype") == "/Image"
    ]


def test_the_composed_card_has_the_map_on_it(pdf_client: Any):
    composed = compose(pdf_client)
    assert composed.status_code == 200
    assert page_images(composed.data), "the card came out as the bare template"


def test_the_map_survives_attaching_the_project(pdf_client: Any):
    # The attachment is written through the same writer the merge has to
    # reach, so the two are one question rather than two.
    composed = compose(pdf_client, json.dumps(PROJECT).encode())
    assert page_images(composed.data)
    assert PROJECT_ATTACHMENT_NAME in PdfReader(BytesIO(composed.data)).attachments


def test_the_card_carries_the_fields_it_was_given(pdf_client: Any):
    """The locality is drawn onto the same overlay as the map.

    It is worth asserting separately because it is the half somebody notices:
    a card with no map is obviously broken, and a card with the map but no
    locality on it gets filled in by hand and never reported.

    The font is a Git LFS object. A checkout without LFS leaves a 131-byte
    pointer in its place, reportlab refuses it, and `_ensure_font` raises out
    of compose_pdf as a 500 — worth skipping loudly here rather than failing
    with a font error that says nothing about this test.
    """
    needs_font()

    response = pdf_client.post(
        "/compose_pdf",
        data={
            "template": (BytesIO(make_template()), "template.pdf"),
            "image": (BytesIO(PNG), "map.png"),
            "locality": "Zażółć",
            "locality_x": "100",
            "locality_y": "760",
            **PLACEHOLDER,
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    text = PdfReader(BytesIO(response.data)).pages[0].extract_text() or ""
    assert "Zażółć" in text


def test_a_template_that_arrived_with_an_attachment_keeps_it(pdf_client: Any):
    # The reason the writer clones rather than appends. Cloning is also what
    # made the merge miss, so the two belong next to each other: a fix for
    # either one that breaks the other is the bug coming back.
    reader = PdfReader(BytesIO(make_template()))
    writer = PdfWriter(clone_from=reader)
    writer.add_attachment("supplier-notes.txt", b"keep me")
    carried = BytesIO()
    writer.write(carried)

    response = pdf_client.post(
        "/compose_pdf",
        data={
            "template": (BytesIO(carried.getvalue()), "template.pdf"),
            "image": (BytesIO(PNG), "map.png"),
            "project": (BytesIO(json.dumps(PROJECT).encode()), "project.json"),
            **PLACEHOLDER,
        },
        content_type="multipart/form-data",
    )
    assert response.status_code == 200

    attachments = PdfReader(BytesIO(response.data)).attachments
    assert "supplier-notes.txt" in attachments
    assert PROJECT_ATTACHMENT_NAME in attachments
    assert page_images(response.data), "the map went missing on the cloned page"


# ── the invisible layer ───────────────────────────────────────────────────────
#
# The map on a card is a photograph. `_paint` composites tiles and street names
# into pixels, so "Territory 7" arrives at the server as a shape made of dark
# dots that no reader can tell from a rooftop — which is why the sentences
# travel beside the picture as text and are written into the page in the render
# mode that paints nothing.
#
# The failure this pins is specific and silent: render mode 3 is one number in
# a content stream, and getting it wrong gives either a card with the text
# stamped visibly across the map, or a card with nothing in it at all. Both
# look fine from the server's side — 200, correct size, no exception.

INFO = ["Territory 7", "Buildings: 42", "Streets: 12", "Area: 1.2 km²"]


def test_the_card_carries_the_territory_as_extractable_text(pdf_client: Any):
    needs_font()
    composed = compose(pdf_client, info=INFO)
    assert composed.status_code == 200

    text = PdfReader(BytesIO(composed.data)).pages[0].extract_text() or ""
    for line in INFO:
        assert line in text, f"{line!r} did not reach the page"


def content(blob: bytes) -> str:
    page = PdfReader(BytesIO(blob)).pages[0]
    return page.get_contents().get_data().decode("latin-1")  # type: ignore[union-attr]


def test_the_text_is_painted_before_the_map_covers_it(pdf_client: Any):
    """Ordinary text, hidden by the image on top of it — not invisible ink.

    Render mode 3 was tried first and produced bytes that were right in every
    respect a test can check, and text a reader still would not select:
    whether invisible text answers a selection is the viewer's decision. So
    the layer is hidden the way the template's own "map goes here" marker is,
    which is the one arrangement observed to work in a real reader.

    That makes the painting order load-bearing, and nothing else in the file
    would notice it changing: the same text drawn after the image is stamped
    across the middle of the finished card.
    """
    needs_font()
    stream = content(compose(pdf_client, info=INFO).data)

    text_at = stream.index("Territory 7")
    image_at = stream.index(" Do", text_at - 4000 if text_at > 4000 else 0)
    assert text_at < stream.rindex(" Do"), "the text would be printed on the card"
    assert image_at > text_at or " Do" not in stream[:text_at], (
        "the map is painted before the text it is supposed to cover"
    )


def test_the_layer_is_not_written_in_ink_that_would_show(pdf_client: Any):
    # The second line of defense. If the layer ever escapes from under the
    # image, white on white paper is still nothing.
    needs_font()
    stream = content(compose(pdf_client, info=INFO).data)
    before = stream[: stream.index("Territory 7")]
    assert "1 1 1 rg" in before, "the hidden text is being drawn in visible ink"


def test_a_card_with_nothing_to_say_gets_no_layer(pdf_client: Any):
    needs_font()
    for info in (None, [], ["", "   "]):
        composed = compose(pdf_client, info=info)
        assert composed.status_code == 200
        assert "Territory" not in content(composed.data), f"a layer for {info!r}"


def test_the_layer_speaks_whatever_the_browser_was_speaking(pdf_client: Any):
    """The sentences are translated client-side and sent as-is.

    Rebuilding them here would mean a second copy of the dictionary on the
    server and a Polish congregation printing English cards. The diacritics
    are the assertion: they are the reason the font is a TTF rather than
    Helvetica in the first place.
    """
    needs_font()
    polish = ["Teren 7", "Budynki: 42", "Powierzchnia: 1,2 km²", "Zażółć gęślą jaźń"]
    composed = compose(pdf_client, info=polish)
    text = PdfReader(BytesIO(composed.data)).pages[0].extract_text() or ""
    for line in polish:
        assert line in text


def placed(blob: bytes, needle: str) -> list[tuple[float, float]]:
    found: list[tuple[float, float]] = []

    def visitor_text(text: str, cm: Any, tm: Any, *_: Any) -> None:
        discard = cm
        del discard
        if needle in text:
            found.append((tm[4], tm[5]))

    PdfReader(BytesIO(blob)).pages[0].extract_text(visitor_text=visitor_text)
    return found


def test_the_layer_lands_under_the_map_itself(pdf_client: Any):
    """Inside the *image*, which is not the same rectangle as the placeholder.

    A map is centred in its box at its own aspect ratio, so a box that is not
    the same shape leaves bands above and below that are page rather than map.
    Text straying into one of those is text printed on the card, and the
    placeholder in this file is deliberately a different shape from the
    1×1 image so that the difference is exercised rather than assumed.
    """
    needs_font()
    spot = placed(compose(pdf_client, info=["Territory 7"]).data, "Territory 7")
    assert spot, "the line was not placed at all"

    box_x, box_y = float(PLACEHOLDER["x"]), float(PLACEHOLDER["y"])
    box_w, box_h = float(PLACEHOLDER["width"]), float(PLACEHOLDER["height"])
    # The image is square, so it fits to the shorter side and is centred.
    side = min(box_w, box_h)
    left = box_x + (box_w - side) / 2
    bottom = box_y + (box_h - side) / 2

    x, y = spot[0]
    assert left <= x <= left + side, f"x={x} escaped the map [{left}, {left + side}]"
    assert bottom <= y <= bottom + side, f"y={y} escaped the map"


def test_a_long_line_is_shrunk_rather_than_allowed_to_escape(pdf_client: Any):
    needs_font()
    long_line = "Territory 7 — " + "Nowa Wieś Królewska " * 8
    composed = compose(pdf_client, info=[long_line])
    assert composed.status_code == 200

    spot = placed(composed.data, "Territory 7")
    if not spot:
        return  # dropped entirely rather than overflowed, which is also correct

    box_x, box_w, box_h = (
        float(PLACEHOLDER["x"]),
        float(PLACEHOLDER["width"]),
        float(PLACEHOLDER["height"]),
    )
    side = min(box_w, box_h)
    left = box_x + (box_w - side) / 2
    stream = content(composed.data)
    size = float(stream.split("Tf")[-2].split()[-1])
    assert size <= 8.0, "the type was not shrunk"
    assert spot[0][0] >= left, "the line starts outside the map"


def test_the_map_and_the_layer_both_survive(pdf_client: Any):
    # They ride on the same overlay and through the same merge, so a fix to
    # either one that loses the other is the missing-map bug coming back.
    needs_font()
    composed = compose(pdf_client, json.dumps(PROJECT).encode(), info=INFO)
    assert page_images(composed.data), "the card came out as the bare template"
    text = PdfReader(BytesIO(composed.data)).pages[0].extract_text() or ""
    assert "Territory 7" in text
    assert PROJECT_ATTACHMENT_NAME in PdfReader(BytesIO(composed.data)).attachments
