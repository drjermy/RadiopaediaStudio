"""iter_scrub_folder honours an optional is_cancelled callable: once it
returns True, the generator stops yielding between files. Cancelled runs
intentionally leave partial output on disk and skip the summary emit —
this matches the semantics documented on the renderer's Cancel button."""

from __future__ import annotations

from pathlib import Path

from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from app.anonymizer import iter_scrub_folder


DX_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.1'


def _write_phi_dicom(path: Path) -> None:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = DX_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b'\x00' * 128)
    ds.SOPClassUID = DX_SOP_CLASS
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = 'DX'
    ds.PatientID = 'TEST-PID'
    ds.PatientName = 'Doe^John'
    ds.Rows = 4
    ds.Columns = 4
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.PixelData = b'\x00' * 4 * 4 * 2
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(path, enforce_file_format=True)


def test_iter_scrub_folder_stops_when_cancelled(tmp_path):
    in_dir = tmp_path / 'in'
    out_dir = tmp_path / 'out'
    for i in range(5):
        _write_phi_dicom(in_dir / f'slice-{i}.dcm')

    emitted = []
    # Flip the cancel flag as soon as the second file has been processed —
    # the third call to is_cancelled must return True before file 2 runs.
    cancel_after = 2

    def is_cancelled() -> bool:
        return len(emitted) >= cancel_after

    summary: dict = {}
    for evt in iter_scrub_folder(
        in_dir, out_dir, summary_out=summary, is_cancelled=is_cancelled,
    ):
        emitted.append(evt)

    assert len(emitted) == cancel_after, (
        f'expected {cancel_after} events before cancel, got {len(emitted)}: {emitted}'
    )
    # Summary is populated in-place during iteration; the generator's
    # contract is to skip the downstream summary *emit*, not to clear the
    # partial metadata. Just assert the emit didn't happen — i.e. no event
    # carries the summary payload shape.
    assert all('studies' not in e for e in emitted)


def test_iter_scrub_folder_runs_to_completion_without_cancel(tmp_path):
    """Sanity: without the hook, every file is processed."""
    in_dir = tmp_path / 'in'
    out_dir = tmp_path / 'out'
    for i in range(3):
        _write_phi_dicom(in_dir / f'slice-{i}.dcm')

    events = list(iter_scrub_folder(in_dir, out_dir))
    file_events = [e for e in events if 'error' not in e]
    assert len(file_events) == 3
