"""PDF composition — stamps the rendered map onto an uploaded template."""

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

# The name the project state is embedded under. Fixed, because reading it back
# is a lookup rather than a search — and because a card that arrives with an
# unrelated attachment should not be mistaken for one of ours.
PROJECT_ATTACHMENT_NAME = "osmapp-project.json.gz"

# Generous for a boundary and a few hundred territories, and far under
# anything that would make a card awkward to email. The client strips the OSM
# cache before sending, so hitting this means something is wrong rather than
# something is big.
_PROJECT_MAX_BYTES = 8 * 1024 * 1024
_PROJECT_MAX_UNZIPPED = 32 * 1024 * 1024


_FONT_NAME = "OsmAppSans"
_font_ready = False

# The hidden layer's type size, line spacing and inset from the map's edge, in
# points. Nothing is ever seen, so these decide only two things: how big a
# selection rectangle each line offers someone dragging across the map in a
# reader, and how much margin there is against straying out from under the
# image. Below _INFO_MIN_SIZE the layer is dropped rather than overflowed —
# text that escapes the map is text printed on the card.
_INFO_FONT_SIZE = 8.0
_INFO_LEADING = 1.25
_INFO_INSET = 4.0
_INFO_MIN_SIZE = 2.0


def _ensure_font() -> str:
    """Register a Unicode TTF once. Helvetica is WinAnsi and cannot render
    ł ą ę ś ż ź ć ń, which is every Polish locality name."""
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
    """Read the project state back out of a printed card.

    The counterpart to the attachment written by compose_pdf. Done here rather
    than in the browser because the parsing is already here: pypdf is a
    dependency, and a JavaScript PDF parser added for one lookup would be a
    second implementation of a format this app already reads.
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

    # A PDF may hold several files under one name. The last is the most
    # recently written, which is the one a re-composed card would have added.
    blob = versions[-1]
    try:
        raw = gzip.decompress(blob)
    except (OSError, EOFError):
        # Written by an older build, before the payload was compressed.
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

    # clone_from, not append(). append() copies the pages and rebuilds the
    # catalog, which silently drops /Names /EmbeddedFiles — so a template that
    # arrived with an attachment lost it, and anything attached below would
    # have to be added after a rebuild that no longer knows about it. Cloning
    # carries the whole document across, attachments included.
    #
    # Cloned here rather than after the merge, and the page taken from the
    # *writer*. The writer copies the document at the moment it is built, so
    # stamping the reader's page afterwards stamped a page that was never
    # written: the card came out as the bare template, with no map and no
    # locality on it, and nothing anywhere reported a failure. The preview was
    # correct throughout, which is what made it look like a rendering problem.
    writer = PdfWriter(clone_from=reader)
    page = writer.pages[page_index]

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

    # Before the map, and that ordering is the whole mechanism. See
    # _draw_hidden_layer.
    _draw_hidden_layer(
        overlay, request.form.getlist("info"), draw_x, draw_y, draw_w, draw_h
    )

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
            # A card that prints without its backup beats no card at all.
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


def _draw_hidden_layer(
    overlay: rl_canvas.Canvas,
    lines: list[str],
    x: float,
    y: float,
    width: float,
    height: float,
) -> None:
    """Write the territory's description under the map, where it cannot be seen.

    The map on a card is a photograph. `_paint` composites tiles and street
    names into pixels, so by the time a card exists "Territory 7" is a shape
    made of dark dots that no reader can tell from a rooftop. This puts the
    sentences back as real text.

    ── Why not invisible ink ──────────────────────────────────────────────

    The obvious way to hide text in a PDF is text render mode 3 — laid out and
    recorded, painted with no ink — which is what a scanner puts under a
    scanned page. It was tried here first and the bytes were right: `3 Tr` in
    the stream, a /ToUnicode map on the font, pypdf extracting it cleanly. It
    still could not be selected in a reader, because whether invisible text
    answers a selection is up to the viewer, and not all of them let it.

    So the text is ordinary, and it is hidden the way the template's own
    "map goes here" marker is hidden: by drawing it first and painting an
    opaque image over the top. That marker stays selectable under the finished
    card, which is the proof that this works in the reader that matters —
    whichever one somebody actually opens the card in.

    ── Staying underneath ────────────────────────────────────────────────

    Ordinary text is only invisible while something covers it, so the bounds
    given here are the *image's* rectangle rather than the placeholder's. The
    two are not the same: a map is centred inside its box at its own aspect
    ratio, and the bands that can leave above and below are page, not map.
    Text straying into one would be printed on the card.

    The type size is then shrunk until the longest line fits the width and all
    of them fit the height, and the layer is dropped entirely rather than
    drawn overflowing if that needs an absurd size. White ink is the second
    line of defense: should any of this ever be wrong, white on white paper is
    still nothing.

    Failures are logged and swallowed. The font is the one thing here that can
    be missing — it is a Git LFS object, and a checkout without LFS leaves a
    pointer file reportlab refuses — and a card that prints without a layer
    nobody can see beats no card at all.

    :param lines: the sentences, already translated by the client.
    :param x, y, width, height: the drawn image's rectangle, in page points.
    """
    lines = [line.strip() for line in lines if line and line.strip()]
    if not lines or width <= 0 or height <= 0:
        return

    try:
        font = _ensure_font()

        # Height first, then width, then take whichever is smaller.
        size = min(_INFO_FONT_SIZE, (height - 2 * _INFO_INSET) / (len(lines) * _INFO_LEADING))
        widest = max(overlay.stringWidth(line, font, size) for line in lines)
        room = width - 2 * _INFO_INSET
        if widest > room:
            size *= room / widest

        if size < _INFO_MIN_SIZE:
            logger.warning(
                "compose_pdf: no room for the hidden text layer in a %.0f×%.0f pt map",
                width,
                height,
            )
            return

        text = overlay.beginText()
        text.setFont(font, size)  # type: ignore[reportUnknownMemberType]
        text.setFillColorRGB(1, 1, 1)
        text.setTextOrigin(x + _INFO_INSET, y + height - _INFO_INSET - size)
        text.setLeading(size * _INFO_LEADING)
        for line in lines:
            text.textLine(line)
        overlay.drawText(text)  # type: ignore[reportUnknownMemberType]
    except Exception:
        logger.exception("compose_pdf: could not write the hidden text layer")


def _attach_project(writer: PdfWriter, raw: bytes) -> None:
    """Embed the project state so the printed card can rebuild the session.

    Stored gzipped under a fixed name. gzip because the payload is JSON full of
    repeated coordinate digits and compresses roughly four to one, and because
    the alternative — a PDF that is a megabyte of map and three megabytes of
    geometry — is a card nobody can email.

    Validated here rather than trusted: this ends up in a file that is handed
    to other people, and "whatever bytes the browser sent" is not a thing to
    put in one. A payload that is not JSON, or is too large, is a bug on the
    client rather than something to pass through silently.
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
