"""The English text written into index.html must match the English bundle.

Every translatable node in the template carries both: a `data-i18n` key, and
the English string spelled out as the element's own content. The second one is
what the page shows before i18n.apply() runs, what a screen reader gets if the
dictionary never arrives, and what anyone reading the template believes the
string says.

Nothing keeps the two in step at runtime — apply() overwrites the markup, so a
fallback can say something the app has not said for months and no page load
will ever reveal it. Nine of them had drifted by the time this test was
written, two of them into statements that were no longer true: the print
dialog's frame hint described an Alt-drag on the rotation slider where the
bundle documents Shift-drag on the preview, and a label read "Detail" where
the bundle had moved on to "Label size".

Only single-line, text-only elements are compared. Anything with a nested tag
is skipped: those are structural and their key is on the child.
"""

import html
import json
import re
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1] / "src" / "osmapp"

# <p data-i18n="a.b">text</p> — same tag name closing it, no nested markup.
NODE = re.compile(r"<(\w+)[^>]*\sdata-i18n=\"([\w.]+)\"[^>]*>(.*?)</\1>", re.S)


def bundle() -> dict[str, Any]:
    with open(ROOT / "static" / "lang" / "en.json", encoding="utf-8") as handle:
        return json.load(handle)


def lookup(tree: dict[str, Any], dotted: str) -> str | None:
    node: Any = tree
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = cast(dict[str, Any], node[part])
    return node if isinstance(node, str) else None


def collapse(text: str) -> str:
    """Markup is wrapped by the formatter; the string it stands for is not."""
    return " ".join(html.unescape(text).split())


def fallbacks() -> list[tuple[str, str]]:
    source = (ROOT / "templates" / "index.html.j2").read_text(encoding="utf-8")
    found: list[tuple[str, str]] = []
    for match in NODE.finditer(source):
        inner = match.group(3)
        if "<" in inner:
            continue
        text = collapse(inner)
        if text:
            found.append((match.group(2), text))
    return found


def test_the_template_is_actually_carrying_fallbacks():
    """A regex that silently matches nothing would make every test below pass."""
    assert len(fallbacks()) > 20


def test_every_key_written_into_the_template_exists():
    tree = bundle()
    missing = [key for key, _ in fallbacks() if lookup(tree, key) is None]
    assert missing == []


def test_no_fallback_disagrees_with_the_bundle():
    tree = bundle()
    drifted = [
        (key, text, collapse(lookup(tree, key) or ""))
        for key, text in fallbacks()
        if lookup(tree, key) is not None and collapse(lookup(tree, key) or "") != text
    ]
    assert drifted == []
