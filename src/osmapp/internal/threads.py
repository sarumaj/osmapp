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
    """Run `target` on a daemon thread until `ev` is set.

    Exceptions from `target` are logged and swallowed, so one failed run does not
    end the schedule - these jobs are cache eviction and disk trimming, where
    stopping quietly is worse than failing loudly once.

    Args:
        ev: Set it to stop the thread; it is also what the sleep waits on, so a
            shutdown does not block for the rest of the interval.
        interval: Seconds between runs.
        run_immediately: Run once before the first wait rather than after it.

    Returns:
        The started thread, for a caller that wants to join it.
    """

    def loop():
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
