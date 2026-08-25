"""The two version numbers the page puts in its corner.

Two rather than one, because the app is two halves built by different
toolchains: the Flask server, versioned in `pyproject.toml`, and everything the
browser runs - `static/` and the libraries vendored under it - versioned in
`package.json`. A release stamps both with the tag (see the "Stamp the release
version" step in `ci.yml`), so the two agreeing is the ordinary case and them
disagreeing is the finding: an image that was not built from a release, or a
service worker still handing out last week's assets.

Neither file is readable from an installed app, which is what the fallbacks
below are for. A wheel carries `src/osmapp/` and nothing above it, so there the
server version arrives as package metadata and the client version as
`static/version.json`, which `npm run vendor` writes from `package.json` at the
moment it produces the assets that file names. A checkout has the originals and
they win: in development an edited `package.json` is the truth, while the
generated copy is however stale the last vendor run left it.

Resolved once, at import. Both files are build inputs - nothing rewrites them
under a running server - so re-reading them would put two file opens on the
path of every page load for a number that cannot have changed.
"""

import json
import tomllib
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as installed_version
from pathlib import Path
from typing import Any, cast

from .config import SCRIPT_DIR, STATIC_DIR

# Printed in place of a number rather than dropping the banner. "unknown" says
# the build cannot name itself, which is worth seeing; an absent banner says
# nothing, and looks exactly like a banner nobody ever added.
UNKNOWN = "unknown"

REPO_ROOT = SCRIPT_DIR.parent.parent  # src/osmapp -> src -> the checkout
CLIENT_VERSION_FILE = STATIC_DIR / "version.json"
DISTRIBUTION = "osmapp"  # the [project] name, which is what pip installs it as


def _json_version(path: Path) -> str | None:
    """The `version` string out of a JSON object, or None if it has none."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = cast(Any, payload).get("version") if isinstance(payload, dict) else None
    return value if isinstance(value, str) else None


def _pyproject_version(path: Path) -> str | None:
    """The `[project] version` out of a pyproject, or None if it has none."""
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    project = payload.get("project")
    value = cast(Any, project).get("version") if isinstance(project, dict) else None
    return value if isinstance(value, str) else None


def _metadata_version(distribution: str) -> str | None:
    """What pip recorded for an installed distribution, if it is installed."""
    try:
        return installed_version(distribution)
    except PackageNotFoundError:
        return None


SERVER_VERSION = (
    _pyproject_version(REPO_ROOT / "pyproject.toml")
    or _metadata_version(DISTRIBUTION)
    or UNKNOWN
)

CLIENT_VERSION = (
    _json_version(REPO_ROOT / "package.json")
    or _json_version(CLIENT_VERSION_FILE)
    or UNKNOWN
)

VERSIONS = {"server": SERVER_VERSION, "client": CLIENT_VERSION}
