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
from typing import Any

import pytest
from flask import Flask
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas

from osmapp.internal import pdf as pdf_module
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


def compose(client: Any, project: bytes | None = None) -> Any:
    data: dict[str, Any] = {
        "template": (BytesIO(make_template()), "template.pdf"),
        "image": (BytesIO(PNG), "map.png"),
        **PLACEHOLDER,
    }
    if project is not None:
        data["project"] = (BytesIO(project), "osmapp-project.json")
    return client.post("/compose_pdf", data=data, content_type="multipart/form-data")


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
