"""Helpers to keep absolute filesystem paths out of logs and streaming
error events.

Motivation: several code paths surface `input: str(in_path)` on error events
and `print(...)` diagnostic lines. For a local-only anonymiser that's fine,
but once output is uploaded anywhere (logs, telemetry, a remote exception
reporter) a pre-scrub folder name like `PATIENT_SMITH_JOHN_2026` is PHI in
its own right. See GitHub issue #7.

`redact_path(p)` returns just enough context to identify which file failed
(series-folder basename + file basename, e.g. `series-3/I1001000`) without
leaking the parent directory tree. Stdlib only; no new deps.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Union

PathLike = Union[str, os.PathLike, Path, None]


def redact_path(p: PathLike) -> str:
    """Return a minimal, non-PHI-leaking representation of a path.

    - Keeps the file basename so error messages point at *which* file.
    - Keeps one level of parent folder basename (e.g. the series folder)
      when available, because `series-3/I1001000` is noticeably more
      useful for triage than a bare `I1001000`.
    - Strips everything above that — no absolute paths, no user home
      directory, no drive letter, no PHI-shaped ancestor folder names.
    """
    if p is None:
        return ''
    s = os.fspath(p)
    if not s:
        return ''
    # Normalise separators without resolving (don't touch the filesystem).
    parts = Path(s).parts
    if not parts:
        return ''
    # Drop the anchor ('/', 'C:\\', etc.) so it doesn't hint at location.
    anchor = Path(s).anchor
    if anchor and parts[0] == anchor:
        parts = parts[1:]
    if not parts:
        return ''
    if len(parts) == 1:
        return parts[0]
    # parent-basename / file-basename
    return f'{parts[-2]}/{parts[-1]}'
