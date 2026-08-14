"""Card composition: lays the finished map into a template the user supplied."""

import gzip
import json
import logging
import math
import time
from io import BytesIO

import pypdfium2 as pdfium  # type: ignore[reportMissingTypeStubs]
from flask import Blueprint, Response, request, send_file
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

from osmapp.internal.template import inspect_template

from .config import FONT_PATH
from .responses import BadRequest, error_, json_

logger = logging.getLogger("osm_app")
bp = Blueprint("pdf", __name__)

# Fixed filename for the embedded project state. Fixed so that recovering it
# later is one name lookup instead of a hunt through every attachment, and so a
# card that turns up carrying somebody else's file is not mistaken for ours.
PROJECT_ATTACHMENT_NAME = "osmapp-project.json.gz"

# Roomy enough for an outline plus a few hundred territories, and nowhere near
# the size that makes a card annoying to mail around. The browser drops the OSM
# cache before it uploads anything, so tripping this limit points at a bug
# rather than at a genuinely large project.
_PROJECT_MAX_BYTES = 8 * 1024 * 1024
_PROJECT_MAX_UNZIPPED = 32 * 1024 * 1024


_FONT_NAME = "OsmAppSans"
_font_ready = False


def _ensure_font() -> str:
    """Load a Unicode TTF, once per process. WinAnsi is all Helvetica offers and
    it has no ł ą ę ś ż ź ć ń, so half the place names in Poland come out wrong."""
    global _font_ready
    if not _font_ready:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(FONT_PATH)))  # type: ignore[reportUnknownMemberType]
        _font_ready = True
    return _FONT_NAME


@bp.route("/inspect_template", methods=["POST"])
def inspect_template_route() -> Response:
    template = request.files.get("template")
    if template is None:
        return error_("No template supplied.")
    try:
        return json_(inspect_template(template.stream))
    except Exception:
        logger.exception("inspect_template failed")
        return error_("The map area could not be found in that template.", 422)


@bp.route("/extract_project", methods=["POST"])
def extract_project() -> Response:
    """Pull the project state back out of a card that was printed with one.

    The other half of the attachment compose_pdf writes. static/js/pdfdoc.js
    does this in the browser now and drops through to here only when it cannot,
    so this route is the safety net rather than the usual path.
    """
    document = request.files.get("pdf")
    if document is None:
        return error_("No PDF supplied.")

    try:
        reader = PdfReader(document.stream)
        if reader.is_encrypted:
            return error_("Encrypted PDFs are not supported.")
        attachments = reader.attachments
    except Exception:
        logger.exception("extract_project: unreadable PDF")
        return error_("That file is not a readable PDF.")

    versions = attachments.get(PROJECT_ATTACHMENT_NAME)
    if not versions:
        return error_("That PDF does not carry a saved project.", 404)

    # A single name can cover several embedded files. Take the last one:
    # re-composing a card appends, so the newest copy sits at the end.
    blob = versions[-1]
    try:
        raw = gzip.decompress(blob)
    except (OSError, EOFError):
        # An older build wrote this, back when the payload went in as-is.
        raw = blob

    if len(raw) > _PROJECT_MAX_UNZIPPED:
        return error_("The saved project in that PDF is implausibly large.")

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return error_("The saved project in that PDF is damaged.", 422)
    if not isinstance(payload, dict):
        return error_("The saved project in that PDF is damaged.", 422)

    return json_(payload)  # type: ignore[reportUnknownArgumentType]


@bp.route("/template_preview", methods=["POST"])
def template_preview() -> Response:
    template = request.files.get("template")
    if template is None:
        return error_("No template supplied.")
    try:
        page_index = min(8, max(0, int(request.form.get("page", 0))))
    except ValueError:
        page_index = 0

    try:
        doc = pdfium.PdfDocument(template.stream.read())
        if page_index >= len(doc):
            return error_("The template has no page at that index.")
        buf = BytesIO()
        doc[page_index].render(scale=110 / 72).to_pil().save(  # type: ignore[reportUnknownMemberType,reportArgumentType]
            buf, "PNG", optimize=True
        )
    except Exception:
        logger.exception("template_preview failed")
        return error_("That template could not be rendered.", 422)

    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@bp.route("/compose_pdf", methods=["POST"])
def compose_pdf() -> Response:
    template = request.files.get("template")
    image = request.files.get("image")
    if template is None or image is None:
        return error_("Send both a template PDF and a map image.")

    try:
        box_x = float(request.form["x"])
        box_y = float(request.form["y"])
        box_w = float(request.form["width"])
        box_h = float(request.form["height"])
        page_index = int(request.form.get("page", 0))
    except (KeyError, ValueError):
        return error_("The placeholder rectangle is missing or malformed.")

    if not all(math.isfinite(v) for v in (box_x, box_y, box_w, box_h)):
        return error_("The placeholder rectangle is not a finite rectangle.")
    if box_w <= 0 or box_h <= 0:
        return error_("The placeholder rectangle has no area.")

    try:
        reader = PdfReader(template.stream)
        if reader.is_encrypted:
            return error_("Encrypted templates are not supported.")
        page_count = len(reader.pages)
    except Exception:
        logger.exception("compose_pdf: unreadable template")
        return error_("That template is not a readable PDF.")

    if not 0 <= page_index < page_count:
        return error_("The template has no page at that index.")

    # clone_from here, not append(). append() re-copies the pages and builds a
    # fresh catalog, and /Names /EmbeddedFiles does not survive that: a template
    # that showed up with an attachment lost it, and anything we wanted to add
    # below would be going into a catalog that had forgotten the tree existed.
    # Cloning brings the document over whole.
    #
    # Note where the clone happens — before the merge — and that the page is
    # taken off the *writer*. A writer copies the document when it is built, so
    # stamping the reader's page after that point stamped a page nobody was
    # going to write out. What came off the printer was the naked template: no
    # map, no locality, and not one error logged anywhere. The preview kept
    # working throughout, which is why this looked like a rendering fault.
    writer = PdfWriter(clone_from=reader)
    page = writer.pages[page_index]

    if int(page.get("/Rotate", 0) or 0) % 360:
        return error_("Rotated template pages are not supported.")

    box = page.mediabox
    page_w, page_h = float(box.width), float(box.height)
    # An origin away from 0,0 moves the entire coordinate system. The overlay
    # goes down at 0,0, so that shift has to be added back by hand.
    origin_x, origin_y = float(box.left), float(box.bottom)

    if not (
        0 <= box_x
        and 0 <= box_y
        and box_x + box_w <= page_w
        and box_y + box_h <= page_h
    ):
        return error_("The placeholder rectangle falls outside the page.")

    try:
        art = ImageReader(image)
        img_w, img_h = art.getSize()
    except Exception:
        logger.exception("compose_pdf: unreadable image")
        return error_("The map image could not be read.")

    if not img_w or not img_h:
        return error_("The map image has no pixels.")

    draw_h = box_h
    draw_w = img_w / img_h * draw_h
    if draw_w > box_w:
        draw_w = box_w
        draw_h = img_h / img_w * draw_w
    draw_x = origin_x + box_x + (box_w - draw_w) / 2
    draw_y = origin_y + box_y + (box_h - draw_h) / 2

    overlay_buf = BytesIO()
    overlay = rl_canvas.Canvas(overlay_buf, pagesize=(page_w, page_h))
    overlay.drawImage(  # type: ignore[reportUnknownMemberType]
        art,
        draw_x,
        draw_y,
        width=draw_w,
        height=draw_h,
        mask="auto",
    )

    for field in ("locality", "territory"):
        text = request.form.get(field, "").strip()
        if not text:
            continue
        try:
            fx = float(request.form[f"{field}_x"])
            fy = float(request.form[f"{field}_y"])
        except (KeyError, ValueError):
            continue
        overlay.setFont(_ensure_font(), 10)
        overlay.drawString(fx, fy, text)

    overlay.save()
    overlay_buf.seek(0)

    try:
        page.merge_page(PdfReader(overlay_buf).pages[0])
    except Exception:
        logger.exception("compose_pdf: merge failed")
        return error_("Could not stamp the map onto the template.", 500)

    project = request.files.get("project")
    if project is not None:
        try:
            _attach_project(writer, project.read())
        except BadRequest as exc:
            return error_(str(exc))
        except Exception:
            # Losing the backup is survivable. Losing the card is not.
            logger.exception("compose_pdf: could not attach the project state")

    out = BytesIO()
    writer.write(out)
    out.seek(0)

    return Response(
        out.read(),
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="territory_map_{int(time.time())}.pdf"'
        },
    )


def _attach_project(writer: PdfWriter, raw: bytes) -> None:
    """Tuck the project state into the card so a session can be rebuilt from it.

    Gzipped, under the fixed name above. Gzip because the payload is JSON made
    largely of repeated coordinate digits and shrinks by roughly four to one,
    and because the other outcome — one megabyte of map and three of geometry —
    is a file nobody can send to anyone.

    Checked rather than taken on faith. This lands in a document that gets
    handed to other people, and "whatever the browser posted" has no business
    being in one. Malformed JSON or an oversized payload means the client is
    broken, and waving it through would only hide that.
    """
    if len(raw) > _PROJECT_MAX_BYTES:
        raise BadRequest("The project state is too large to attach.")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BadRequest("The project state is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise BadRequest("The project state is not an object.")

    writer.add_attachment(PROJECT_ATTACHMENT_NAME, gzip.compress(raw))
