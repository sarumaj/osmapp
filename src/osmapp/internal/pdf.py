"""PDF composition — stamps the rendered map onto an uploaded template."""

from __future__ import annotations

import logging
from io import BytesIO

from flask import Blueprint, Response, request
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

from .responses import error_

logger = logging.getLogger("osm_app")
bp = Blueprint("pdf", __name__)


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

    try:
        reader = PdfReader(template.stream)
    except Exception:
        logger.exception("compose_pdf: unreadable template")
        return error_("That template is not a readable PDF.")

    if not 0 <= page_index < len(reader.pages):
        return error_("The template has no page at that index.")

    page = reader.pages[page_index]
    page_w = float(page.mediabox.width)
    page_h = float(page.mediabox.height)

    try:
        art = ImageReader(image)
        img_w, img_h = art.getSize()
    except Exception:
        logger.exception("compose_pdf: unreadable image")
        return error_("The map image could not be read.")

    # Fix height to the placeholder; scale width to match aspect ratio and
    # centre horizontally so the image never overflows the box.
    draw_h = box_h
    draw_w = img_w / img_h * draw_h
    if draw_w > box_w:
        draw_w = box_w
        draw_h = img_h / img_w * draw_w
    draw_x = box_x + (box_w - draw_w) / 2
    draw_y = box_y + (box_h - draw_h) / 2

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
        overlay.setFont("Helvetica", 10)
        overlay.drawString(fx, fy, text)

    overlay.save()
    overlay_buf.seek(0)

    try:
        page.merge_page(PdfReader(overlay_buf).pages[0])
    except Exception:
        logger.exception("compose_pdf: merge failed")
        return error_("Could not stamp the map onto the template.", 500)

    writer = PdfWriter()
    for p in reader.pages:
        writer.add_page(p)

    out = BytesIO()
    writer.write(out)
    out.seek(0)

    return Response(
        out.read(),
        mimetype="application/pdf",
        headers={"Content-Disposition": 'inline; filename="teren.pdf"'},
    )
