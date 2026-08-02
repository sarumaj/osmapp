"""Shared HTTP helpers and the BadRequest sentinel exception."""

import json
from typing import Any

from flask import Response


class BadRequest(Exception):
    """Client-side problem worth reporting verbatim."""


def json_(payload: dict[str, Any] | list[Any], status: int = 200) -> Response:
    return Response(json.dumps(payload), status=status, mimetype="application/json")


def error_(message: str, status: int = 400) -> Response:
    return json_({"error": message}, status)
