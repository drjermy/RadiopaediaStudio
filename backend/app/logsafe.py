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
import re
from pathlib import Path
from typing import Union

PathLike = Union[str, os.PathLike, Path, None]

# Matches quoted POSIX (/abs/path) or Windows (C:\abs\path / C:/abs/path)
# absolute paths inside single or double quotes. Python's built-in
# exception messages quote the path, e.g.
#   FileNotFoundError: [Errno 2] No such file or directory: '/abs/path'
# and pydicom's EOF warnings use the bare absolute path at end-of-line —
# the quoted form is the common case and matches the Node-side regex.
_QUOTED_PATH_RE = re.compile(r"""(['"])((?:[A-Za-z]:)?[\/\\][^'"]+)\1""")

# Catches trailing bare absolute paths that pydicom embeds in user
# warnings (no quotes), e.g.
#   End of file reached before delimiter (FFFE,E0DD) found in file /abs/path/x.dcm
# Requires a `/` or `\\` start and at least one path separator so we don't
# accidentally match a keyword like `/tag` inside prose.
_BARE_PATH_RE = re.compile(r"""((?:[A-Za-z]:)?[\/\\][^\s'"]+[\/\\][^\s'"]+)""")


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


def redact_error_message(s: str) -> str:
    """Redact absolute filesystem paths embedded inside an exception or
    warning message.

    Python's built-in exception messages for ``FileNotFoundError``,
    ``PermissionError``, ``IsADirectoryError`` and friends embed the
    offending path verbatim — e.g.
    ``[Errno 2] No such file or directory: '/Volumes/phi/PATIENT_X/I1.dcm'``.
    When we format these as ``f'{type(e).__name__}: {e}'`` and stream them
    as NDJSON ``error`` events, the PHI-shaped ancestor directory leaks.

    Mirrors ``redactErrorMessage`` in ``backend-js/server.mjs``: replace
    any quoted absolute path with its :func:`redact_path` reduction, then
    catch any remaining bare absolute paths (pydicom's
    ``End of file reached ... found in file /abs/path`` warning shape).
    See GitHub issue #11.
    """
    if s is None:
        return ''
    text = str(s)
    if not text:
        return ''
    text = _QUOTED_PATH_RE.sub(
        lambda m: f'{m.group(1)}{redact_path(m.group(2))}{m.group(1)}',
        text,
    )
    text = _BARE_PATH_RE.sub(lambda m: redact_path(m.group(1)), text)
    return text
