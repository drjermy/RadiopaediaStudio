"""Absolute-path redaction for logs and streaming error events.

Regression test for GitHub issue #7. A pre-anonymisation folder name can
itself be PHI (e.g. ``PATIENT_SMITH_JOHN_2026``), so anywhere we surface
`input` on an error event or print() a path, the ancestor directories
must be stripped. We only keep parent-folder basename + file basename —
enough to triage a failure, not enough to dox the study's owner.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.anonymizer import iter_scrub_folder
from app.logsafe import redact_path


# -- unit: redact_path() --------------------------------------------------


def test_redact_path_keeps_parent_and_file_basename():
    assert redact_path('/Volumes/phi/PATIENT_SMITH_JOHN_2026/series-3/I1001000') == 'series-3/I1001000'


def test_redact_path_handles_bare_filename():
    assert redact_path('I1001000') == 'I1001000'


def test_redact_path_handles_none_and_empty():
    assert redact_path(None) == ''
    assert redact_path('') == ''


def test_redact_path_strips_user_home():
    # Must not leak the user name from a ~-style absolute path.
    out = redact_path('/Users/drsmith/Downloads/PATIENT_SMITH_JOHN/I1001000')
    assert '/Users/' not in out
    assert 'drsmith' not in out
    assert out == 'PATIENT_SMITH_JOHN/I1001000'


def test_redact_path_handles_forward_slash_drive_style():
    # We're POSIX in CI; pathlib treats `\` as regular chars here. Just
    # exercise the anchor-stripping codepath with a POSIX-shaped path
    # that looks like a Windows drive mounted at /Volumes/C.
    out = redact_path('/Volumes/C/phi/PATIENT_SMITH_JOHN/I1001000')
    assert out == 'PATIENT_SMITH_JOHN/I1001000'
    assert '/Volumes/' not in out


def test_redact_path_accepts_path_objects():
    assert redact_path(Path('/phi/PATIENT_SMITH_JOHN_2026/series-3/I1001000')) == 'series-3/I1001000'


# -- integration: /anonymize error events + stderr --------------------------


def _make_phi_tree_with_unreadable_file(tmp_path: Path) -> Path:
    """Build a folder whose name is PHI-shaped and contains a file that
    will trigger an anonymisation error (valid DICM magic but unparseable
    body). Returns the absolute input folder path."""
    in_dir = tmp_path / 'PATIENT_SMITH_JOHN_2026' / 'series-3'
    in_dir.mkdir(parents=True)
    bad = in_dir / 'I1001000.dcm'
    # DICM magic so find_dicoms() picks it up; body is garbage so
    # pydicom.dcmread() raises.
    bad.write_bytes(b'\x00' * 128 + b'DICM' + b'\xff' * 64)
    return tmp_path / 'PATIENT_SMITH_JOHN_2026'


def _assert_no_absolute_paths(text: str, phi_dir: Path) -> None:
    abs_str = str(phi_dir)
    assert abs_str not in text, f'absolute input path leaked: {abs_str!r} found in {text!r}'
    # Also make sure the PHI-shaped ancestor doesn't appear on its own.
    assert 'PATIENT_SMITH_JOHN_2026' not in text, (
        f'PHI-shaped ancestor folder leaked in {text!r}'
    )


def test_anonymize_error_events_redact_absolute_paths(tmp_path, capfd):
    """Drive the /anonymize streaming generator against a folder whose
    path contains PHI-shaped ancestors. On per-file error, neither the
    NDJSON error events nor captured stderr may contain the absolute
    input path or the PHI-shaped parent folder name.

    Uses iter_scrub_folder() directly (same generator /anonymize mounts)
    so the assertion runs without an HTTP client dependency.
    """
    phi_dir = _make_phi_tree_with_unreadable_file(tmp_path)
    out_dir = tmp_path / 'out'

    events = list(iter_scrub_folder(phi_dir, out_dir))
    captured = capfd.readouterr()

    errors = [e for e in events if 'error' in e]
    assert errors, 'expected at least one per-file error event'

    # The error must still identify the file — useful debug info — just
    # not via an absolute path or PHI-shaped ancestor.
    for e in errors:
        assert e.get('input'), f'error event missing input: {e!r}'
        assert 'I1001000' in e['input'], f'lost filename in error event: {e!r}'

    # Serialise the events as the server would (NDJSON) and check the
    # bytes we'd actually put on the wire.
    body = '\n'.join(json.dumps(e) for e in events)
    _assert_no_absolute_paths(body, phi_dir)
    _assert_no_absolute_paths(captured.err, phi_dir)
    _assert_no_absolute_paths(captured.out, phi_dir)
