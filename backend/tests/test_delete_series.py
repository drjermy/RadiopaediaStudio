"""`/delete-series` refuses to delete anything that doesn't resolve to a
subpath of the caller-supplied `allowed_parent`. This blocks both
traversal attempts (`..`) and bare absolute paths the app never produced
— see issue #6.

We call the handler function directly (no httpx in test deps) and
inspect the raised `HTTPException`."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.main import DeleteSeriesRequest, delete_series


def _write_dicom_magic(path: Path) -> None:
    with open(path, 'wb') as f:
        f.write(b'\x00' * 128)
        f.write(b'DICM')
        f.write(b'\x00' * 32)


def test_delete_series_rejects_traversal(tmp_path):
    """`..` out of the allowed parent → 400, folder untouched."""
    allowed = tmp_path / 'anon-out'
    sibling = tmp_path / 'other'
    allowed.mkdir()
    sibling.mkdir()
    _write_dicom_magic(sibling / 'I1001000')

    # A path that textually looks like it's inside `allowed` but
    # `..` escapes to the sibling — .resolve() collapses it.
    traversal = allowed / '..' / 'other'

    req = DeleteSeriesRequest(folder=str(traversal), allowed_parent=str(allowed))
    with pytest.raises(HTTPException) as exc:
        delete_series(req)
    assert exc.value.status_code == 400
    assert 'not under allowed_parent' in exc.value.detail
    # Target still exists — the reject happened before rmtree.
    assert sibling.exists()
    assert (sibling / 'I1001000').exists()


def test_delete_series_rejects_path_outside_allowed_parent(tmp_path):
    """A plain absolute path outside allowed_parent → 400."""
    allowed = tmp_path / 'anon-out'
    outside = tmp_path / 'unrelated-series'
    allowed.mkdir()
    outside.mkdir()
    _write_dicom_magic(outside / 'I1001000')

    req = DeleteSeriesRequest(folder=str(outside), allowed_parent=str(allowed))
    with pytest.raises(HTTPException) as exc:
        delete_series(req)
    assert exc.value.status_code == 400
    assert 'not under allowed_parent' in exc.value.detail
    assert outside.exists()
    assert (outside / 'I1001000').exists()


def test_delete_series_accepts_subpath_of_allowed_parent(tmp_path):
    """Sanity: a legit series under allowed_parent is deleted."""
    allowed = tmp_path / 'anon-out'
    series = allowed / 'series-1'
    series.mkdir(parents=True)
    _write_dicom_magic(series / 'I1001000')

    req = DeleteSeriesRequest(folder=str(series), allowed_parent=str(allowed))
    result = delete_series(req)
    assert 'deleted' in result
    assert not series.exists()
    assert allowed.exists()  # parent itself is preserved


def test_delete_series_rejects_deleting_allowed_parent_itself(tmp_path):
    """Deleting the root itself is refused even though it trivially
    satisfies the subpath check."""
    allowed = tmp_path / 'anon-out'
    allowed.mkdir()
    _write_dicom_magic(allowed / 'I1001000')

    req = DeleteSeriesRequest(folder=str(allowed), allowed_parent=str(allowed))
    with pytest.raises(HTTPException) as exc:
        delete_series(req)
    assert exc.value.status_code == 400
    assert 'allowed_parent itself' in exc.value.detail
    assert allowed.exists()
