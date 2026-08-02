"""Lightweight periodic background-thread helper."""

import logging
import threading
import time
from typing import Callable

logger = logging.getLogger("osm_app")


def execute_in_thread(
    target: Callable[[], None],
    ev: threading.Event,
    interval: int,
    name: str | None = None,
) -> threading.Thread:
    def loop() -> None:
        logger.info("Starting thread %s", threading.current_thread().name)
        while not ev.is_set():
            time.sleep(interval)
            target()
        logger.info("Stopping thread %s", threading.current_thread().name)

    job = threading.Thread(target=loop, daemon=True, name=name)
    job.start()
    return job
