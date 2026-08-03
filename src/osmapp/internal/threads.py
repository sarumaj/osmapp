"""Lightweight periodic background-thread helper."""

import logging
import threading
from collections.abc import Callable

logger = logging.getLogger("osm_app")


def execute_in_thread(
    target: Callable[[], None],
    ev: threading.Event,
    interval: int,
    name: str | None = None,
    run_immediately: bool = True,
) -> threading.Thread:
    def loop() -> None:
        logger.info("Starting thread %s", threading.current_thread().name)
        first = run_immediately
        while not ev.is_set():
            if not first and ev.wait(interval):
                break

            first = False
            try:
                target()
            except Exception:
                logger.exception("Periodic job %s failed", name)

        logger.info("Stopping thread %s", threading.current_thread().name)

    job = threading.Thread(target=loop, daemon=True, name=name)
    job.start()
    return job
