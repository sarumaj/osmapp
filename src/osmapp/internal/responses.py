"""Shared HTTP helpers and the BadRequest sentinel exception."""

from typing import Any

from flask import Response, jsonify, make_response


class BadRequest(Exception):
    """Client-side problem worth reporting verbatim."""


def json_(payload: dict[str, Any] | list[Any], status: int = 200) -> Response:
    return make_response(jsonify(payload), status)


def error_(message: str, status: int = 400) -> Response:
    return json_({"error": message}, status)
