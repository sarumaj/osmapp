"""Lightweight periodic background-thread helper."""

import logging
import threading
from collections.abc import Callable
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")
F = Callable[P, R]

logger = logging.getLogger("osm_app")


def execute_in_thread(  # noqa: UP047
    target: F[P, R],
    ev: threading.Event,
    interval: int,
    name: str | None = None,
    run_immediately: bool = True,
    *args: P.args,
    **kwargs: P.kwargs,
) -> threading.Thread:
    def loop() -> None:
        logger.info("Starting thread %s", threading.current_thread().name)
        first = run_immediately
        while not ev.is_set():
            if not first and ev.wait(interval):
                break

            first = False
            try:
                _ = target(*args, **kwargs)
            except Exception:
                logger.exception("Periodic job %s failed", name)

        logger.info("Stopping thread %s", threading.current_thread().name)

    job = threading.Thread(target=loop, daemon=True, name=name)
    job.start()
    return job
