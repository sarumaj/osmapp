"""What /fetch_streets does with an area that has no streets in it.

Empty is not an error, but osmnx reports it as one - four different ones, three
of which are bare ValueErrors that read like a bug. Getting that wrong is
expensive in a way the size of the mistake does not suggest: an empty area
answered with a 502 is flagged retryable, so the client waits out five attempts
with backoff and then abandons the *whole* download. One field at the edge of a
twenty-tile boundary is enough to lose the nineteen tiles around it.

The tests drive the failures through the route rather than the helper. What is
being pinned is the status code and the body the client reads, and it is the
route that decides both - `_empty_area` returning True is of no use if the
handler above it has already logged and answered 502.
"""

from typing import Any, cast

import osmnx as ox
import pytest
from flask import Flask

from osmapp import create_app

# A square kilometer or so at 52°N: under the limit, so the guard is not what
# is being tested here.
AREA: dict[str, Any] = {
    "type": "Polygon",
    "coordinates": [
        [
            [21.0, 52.0],
            [21.01, 52.0],
            [21.01, 52.01],
            [21.0, 52.01],
            [21.0, 52.0],
        ]
    ],
}

# The three messages osmnx raises a plain ValueError with when the area came
# back empty, and one it raises for a caller's mistake - which has to keep
# reading as a failure.
EMPTY = (
    "Found no graph nodes within the requested polygon.",
    "Graph contains no nodes.",
    "Graph contains no edges.",
)
NOT_EMPTY = "The geometry of `polygon` is invalid."


@pytest.fixture
def app() -> Flask:
    application = create_app()
    application.config["TESTING"] = True
    return application


@pytest.fixture
def failing(monkeypatch: pytest.MonkeyPatch):
    """Make the Overpass call raise whatever a test needs it to."""

    def raising(exc: Exception):
        def fail(*args: Any, **kwargs: Any):
            raise exc

        monkeypatch.setattr(ox, "graph_from_polygon", fail)

    return raising


def post(app: Flask, tiled: bool):
    body: dict[str, Any] = {"type": "Feature", "geometry": AREA}
    if tiled:
        body["properties"] = {"tiled": True}
    return app.test_client().post("/fetch_streets", json=body)


@pytest.mark.parametrize("message", EMPTY)
def test_an_empty_tile_is_an_empty_answer(app: Flask, failing: Any, message: str):
    """200 and nothing in it, so the download carries on to the next tile."""
    failing(ValueError(message))
    response = post(app, tiled=True)
    payload = cast(dict[str, Any], response.get_json())

    assert response.status_code == 200
    assert payload["count"] == 0
    assert payload["streets"]["features"] == []


@pytest.mark.parametrize("message", EMPTY)
def test_an_empty_boundary_is_still_a_404(app: Flask, failing: Any, message: str):
    """Nobody divided this one: it is the area somebody drew, and "no streets
    here" is the answer to it rather than a step in a longer job."""
    failing(ValueError(message))

    assert post(app, tiled=False).status_code == 404


def test_the_same_answer_when_overpass_returns_nothing_at_all(app: Flask, failing: Any):
    """The one empty case osmnx does give an exception class of its own."""
    empty = ox._errors.InsufficientResponseError  # type: ignore[attr-defined]
    failing(empty("No data elements"))

    assert post(app, tiled=True).status_code == 200
    assert post(app, tiled=False).status_code == 404


@pytest.mark.parametrize("tiled", [True, False])
def test_a_valueerror_that_is_not_emptiness_stays_loud(
    app: Flask, failing: Any, tiled: bool
):
    """The message is the only thing separating these two, so the pair is
    tested together: a mistake on this end that starts answering 200 and an
    empty collection is a boundary that silently downloads nothing."""
    failing(ValueError(NOT_EMPTY))
    response = post(app, tiled=tiled)

    assert response.status_code == 502
    assert cast(dict[str, Any], response.get_json())["retryable"] is True


@pytest.mark.parametrize("tiled", [True, False])
def test_a_busy_overpass_is_still_worth_retrying(app: Flask, failing: Any, tiled: bool):
    failing(RuntimeError("connection reset"))
    response = post(app, tiled=tiled)

    assert response.status_code == 502
    assert cast(dict[str, Any], response.get_json())["retryable"] is True
