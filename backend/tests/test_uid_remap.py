"""UID remapping invariants for folder-level operations.

Before: each file in a folder got its own fresh Study/Series UID —
Radiopaedia saw N single-image series instead of one stack. These tests
lock in the fix: files originally in the same series share a new series
UID; same for study; SOP UIDs are always unique.
"""

from __future__ import annotations

import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from app.anonymizer import iter_scrub_folder
from app.windowing import iter_apply_window_folder


DX_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.1'


def _write_slice(path, study_uid, series_uid, sop_uid, *, for_uid=None):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = DX_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b'\x00' * 128)
    ds.SOPClassUID = DX_SOP_CLASS
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    if for_uid:
        ds.FrameOfReferenceUID = for_uid
    ds.Modality = 'CT'
    ds.PatientID = 'TEST-PID'
    ds.PatientName = 'Doe^John'
    ds.Rows = 8
    ds.Columns = 8
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.PixelData = b'\x00' * 8 * 8 * 2
    ds.save_as(path, enforce_file_format=True)


def _build_two_series_study(root):
    """Write 5 files: 3 in Series A + 2 in Series B, all one study, all
    sharing one FrameOfReferenceUID."""
    study = generate_uid()
    series_a = generate_uid()
    series_b = generate_uid()
    for_uid = generate_uid()
    (root / 'seriesA').mkdir()
    (root / 'seriesB').mkdir()
    for i in range(3):
        _write_slice(
            root / 'seriesA' / f'{i:04d}.dcm',
            study, series_a, generate_uid(), for_uid=for_uid,
        )
    for i in range(2):
        _write_slice(
            root / 'seriesB' / f'{i:04d}.dcm',
            study, series_b, generate_uid(), for_uid=for_uid,
        )
    return {'study': study, 'series_a': series_a, 'series_b': series_b, 'for_uid': for_uid}


def _read_uids(dir_):
    return [
        {
            'path': p,
            'study': ds.StudyInstanceUID,
            'series': ds.SeriesInstanceUID,
            'sop': ds.SOPInstanceUID,
            'for_uid': ds.get('FrameOfReferenceUID', None),
        }
        for p in sorted(dir_.rglob('*.dcm'))
        for ds in [pydicom.dcmread(p)]
    ]


# -- scrub folder ----------------------------------------------------------


def test_scrub_folder_preserves_series_grouping(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    _build_two_series_study(src)
    dst = tmp_path / 'dst'
    list(iter_scrub_folder(src, dst))

    uids = _read_uids(dst)
    series_a = [u for u in uids if 'seriesA' in str(u['path'])]
    series_b = [u for u in uids if 'seriesB' in str(u['path'])]

    # Every file in Series A shares one new Series UID
    assert len({u['series'] for u in series_a}) == 1
    # Every file in Series B shares one (different) new Series UID
    assert len({u['series'] for u in series_b}) == 1
    assert series_a[0]['series'] != series_b[0]['series']


def test_scrub_folder_shares_study_uid(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    _build_two_series_study(src)
    dst = tmp_path / 'dst'
    list(iter_scrub_folder(src, dst))

    studies = {u['study'] for u in _read_uids(dst)}
    assert len(studies) == 1


def test_scrub_folder_unique_sop_per_file(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    _build_two_series_study(src)
    dst = tmp_path / 'dst'
    list(iter_scrub_folder(src, dst))

    uids = _read_uids(dst)
    sops = [u['sop'] for u in uids]
    assert len(sops) == len(set(sops))  # all unique


def test_scrub_folder_frame_of_reference_consistent(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    _build_two_series_study(src)
    dst = tmp_path / 'dst'
    list(iter_scrub_folder(src, dst))

    fors = {u['for_uid'] for u in _read_uids(dst)}
    assert len(fors) == 1  # all files share one (new) FrameOfReferenceUID
    assert next(iter(fors)).startswith('2.25.')


# -- window folder ---------------------------------------------------------


def test_window_folder_new_series_per_original(tmp_path):
    """Windowed output is a distinct series from the input, but files
    that were in the same input series stay together."""
    src = tmp_path / 'src'
    src.mkdir()
    orig = _build_two_series_study(src)
    dst = tmp_path / 'win'
    list(iter_apply_window_folder(src, dst, 40, 80))

    uids = _read_uids(dst)
    series_a = [u for u in uids if 'seriesA' in str(u['path'])]
    series_b = [u for u in uids if 'seriesB' in str(u['path'])]

    assert len({u['series'] for u in series_a}) == 1
    assert len({u['series'] for u in series_b}) == 1
    assert series_a[0]['series'] != series_b[0]['series']
    # New series UIDs are different from the originals (distinct series)
    assert series_a[0]['series'] != orig['series_a']
    assert series_b[0]['series'] != orig['series_b']


def test_window_folder_preserves_study_uid(tmp_path):
    """Windowed version belongs to the same case."""
    src = tmp_path / 'src'
    src.mkdir()
    orig = _build_two_series_study(src)
    dst = tmp_path / 'win'
    list(iter_apply_window_folder(src, dst, 40, 80))

    studies = {u['study'] for u in _read_uids(dst)}
    assert studies == {orig['study']}


def test_window_folder_preserves_frame_of_reference(tmp_path):
    """Windowed series still spatially registers with base."""
    src = tmp_path / 'src'
    src.mkdir()
    orig = _build_two_series_study(src)
    dst = tmp_path / 'win'
    list(iter_apply_window_folder(src, dst, 40, 80))

    fors = {u['for_uid'] for u in _read_uids(dst)}
    assert fors == {orig['for_uid']}


def test_window_folder_unique_sops(tmp_path):
    src = tmp_path / 'src'
    src.mkdir()
    _build_two_series_study(src)
    dst = tmp_path / 'win'
    list(iter_apply_window_folder(src, dst, 40, 80))

    sops = [u['sop'] for u in _read_uids(dst)]
    assert len(sops) == len(set(sops))
