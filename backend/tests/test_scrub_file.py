"""Tests for the file-level wrapper scrub_file() — round-trips through
disk to catch save/load regressions."""

from __future__ import annotations

import pydicom

from app.anonymizer import scrub_file


def test_scrub_file_round_trips(file_ds, tmp_path):
    src = tmp_path / 'input.dcm'
    dst = tmp_path / 'output.dcm'
    result = scrub_file(src, dst)

    assert dst.exists()
    reloaded = pydicom.dcmread(dst)
    assert reloaded.PatientIdentityRemoved == 'YES'
    assert 'PatientName' not in reloaded
    assert result['kept'] > 0


def test_scrub_file_creates_parent_dir(file_ds, tmp_path):
    src = tmp_path / 'input.dcm'
    dst = tmp_path / 'nested' / 'deeper' / 'output.dcm'
    scrub_file(src, dst)
    assert dst.exists()


def test_scrub_file_result_shape(file_ds, tmp_path):
    src = tmp_path / 'input.dcm'
    dst = tmp_path / 'output.dcm'
    result = scrub_file(src, dst)
    assert set(result.keys()) == {'kept', 'dropped', 'dropped_tags'}
    assert isinstance(result['dropped_tags'], list)
