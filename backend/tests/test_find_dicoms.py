"""Detect DICOM files with and without the .dcm extension. Many PACS
exports use numeric / extensionless filenames (I1001000, 00000001.DCM,
etc.) — we fall back to peeking at the DICM magic."""

from __future__ import annotations

from pathlib import Path

from app.anonymizer import find_dicoms, is_dicom_file


def _write_dicom_magic(path: Path) -> None:
    """Write a minimal file with the DICM marker at byte 128."""
    with open(path, 'wb') as f:
        f.write(b'\x00' * 128)
        f.write(b'DICM')
        f.write(b'\x00' * 32)  # some trailing bytes


def _write_non_dicom(path: Path, content: bytes = b'not a dicom') -> None:
    path.write_bytes(content)


def test_is_dicom_by_extension(tmp_path):
    p = tmp_path / 'study.dcm'
    _write_non_dicom(p)  # extension wins; content not checked
    assert is_dicom_file(p)


def test_is_dicom_by_magic_no_extension(tmp_path):
    p = tmp_path / 'I1001000'
    _write_dicom_magic(p)
    assert is_dicom_file(p)


def test_is_dicom_uppercase_extension(tmp_path):
    p = tmp_path / 'SCAN.DCM'
    _write_non_dicom(p)
    assert is_dicom_file(p)


def test_dotdicom_extension(tmp_path):
    p = tmp_path / 'scan.dicom'
    _write_non_dicom(p)
    assert is_dicom_file(p)


def test_non_dicom_rejected(tmp_path):
    p = tmp_path / 'notes.txt'
    _write_non_dicom(p)
    assert not is_dicom_file(p)


def test_hidden_file_rejected(tmp_path):
    p = tmp_path / '.DS_Store'
    _write_dicom_magic(p)  # even if it has the magic, skip hidden files
    assert not is_dicom_file(p)


def test_find_dicoms_mixed_folder(tmp_path):
    """A realistic PACS export: nested dirs, extensionless files."""
    (tmp_path / 'seriesA').mkdir()
    (tmp_path / 'seriesB').mkdir()
    _write_dicom_magic(tmp_path / 'seriesA' / 'I1001000')
    _write_dicom_magic(tmp_path / 'seriesA' / 'I1002000')
    _write_dicom_magic(tmp_path / 'seriesB' / 'SCAN.dcm')
    _write_non_dicom(tmp_path / 'README.txt')
    _write_non_dicom(tmp_path / '.DS_Store')

    found = find_dicoms(tmp_path)
    names = {p.name for p in found}
    assert names == {'I1001000', 'I1002000', 'SCAN.dcm'}
