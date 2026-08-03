"""PDF composition — stamps the rendered map onto an uploaded template."""

from __future__ import annotations

import logging
import math
from io import BytesIO

from flask import Blueprint, Response, request
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

from .config import FONT_PATH
from .responses import error_

logger = logging.getLogger("osm_app")
bp = Blueprint("pdf", __name__)


_FONT_NAME = "OsmAppSans"
_font_ready = False


def _ensure_font() -> str:
    """Register a Unicode TTF once. Helvetica is WinAnsi and cannot render
    ł ą ę ś ż ź ć ń, which is every Polish locality name."""
    global _font_ready
    if not _font_ready:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(FONT_PATH)))  # type: ignore[reportUnknownMemberType]
        _font_ready = True
    return _FONT_NAME


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

    page = reader.pages[page_index]
    if int(page.get("/Rotate", 0) or 0) % 360:
        return error_("Rotated template pages are not supported.")

    box = page.mediabox
    page_w, page_h = float(box.width), float(box.height)
    # A non-zero mediabox origin shifts the whole coordinate system; the
    # overlay is drawn at 0,0 so the offset has to come back out.
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

    writer = PdfWriter()
    writer.append(reader)

    out = BytesIO()
    writer.write(out)
    out.seek(0)

    return Response(
        out.read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": 'inline; filename="teren.pdf"'},
    )
