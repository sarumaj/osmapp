"""Shared HTTP helpers and the BadRequest sentinel exception."""

from typing import Any

from flask import Response, jsonify, make_response


class BadRequest(Exception):
    """Client-side problem worth reporting verbatim."""


def json_(payload: dict[str, Any] | list[Any], status: int = 200) -> Response:
    """JSON response with an explicit status."""
    return make_response(jsonify(payload), status)


def error_(message: str, status: int = 400, retryable: bool = False) -> Response:
    """Error body, optionally flagged as transient.

    The client retries on the status code alone for anything it did not ask
    about, but a 502 from us covers both "Overpass timed out" and "Overpass
    said no", and only one of those is worth waiting out. The flag lets this
    end decide instead of guessing from the status.
    """
    payload: dict[str, Any] = {"error": message}
    if retryable:
        payload["retryable"] = True
    return json_(payload, status)
