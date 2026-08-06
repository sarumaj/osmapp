"""Dictionary parity across languages.

Catches the whole class of "added a key in English, forgot the others" bugs,
plus placeholder drift, which surfaces as a literal {count} in the UI.
"""

import json
import re
from pathlib import Path
from typing import Any, Sequence, cast

import pytest

LANG_DIR = Path(__file__).parent.parent / "src" / "osmapp" / "static" / "lang"
REFERENCE = "en"
# Polish needs one/few/many; German and English do not. A key may therefore
# resolve to a string or to a plural map, and both are legitimate.
PLURAL_FORMS = {"zero", "one", "two", "few", "many", "other"}


def flatten(node: dict[str, str], prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in node.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict) and set(cast(Sequence[Any], value)) <= PLURAL_FORMS:
            out[path] = " ".join(
                cast(Sequence[str], value.values())
            )  # placeholders must appear in every form
        elif isinstance(value, dict):
            out.update(flatten(value, f"{path}."))
        else:
            out[path] = value
    return out


def load(code: str) -> dict[str, str]:
    return flatten(json.loads((LANG_DIR / f"{code}.json").read_text(encoding="utf-8")))


LANGUAGES = sorted(p.stem for p in LANG_DIR.glob("*.json"))
OTHERS = [c for c in LANGUAGES if c != REFERENCE]


def test_reference_dictionary_exists():
    assert REFERENCE in LANGUAGES
    assert OTHERS, "there should be at least one translation"


@pytest.mark.parametrize("code", OTHERS)
def test_same_keys_as_reference(code: str):
    reference, other = set(load(REFERENCE)), set(load(code))
    assert not reference - other, f"{code} is missing: {sorted(reference - other)}"
    assert not other - reference, f"{code} has extra: {sorted(other - reference)}"


@pytest.mark.parametrize("code", OTHERS)
def test_placeholders_match(code: str):
    reference, other = load(REFERENCE), load(code)
    for key in reference:
        expected = set(re.findall(r"\{(\w+)\}", reference[key]))
        actual = set(re.findall(r"\{(\w+)\}", other[key]))
        assert expected == actual, f"{code}.{key}: expected {expected}, got {actual}"


@pytest.mark.parametrize("code", LANGUAGES)
def test_no_empty_strings(code: str):
    empty = [k for k, v in load(code).items() if not v.strip()]
    assert not empty, f"{code} has empty values: {empty}"
