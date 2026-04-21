"""Fixture factories for building in-memory pydicom Datasets with known
tag content. Tests use these to exercise scrub() without depending on
external DICOM files.
"""

from __future__ import annotations

import pytest
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


DX_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.1'  # Digital X-Ray Image Storage


def _make_file_meta(sop_instance_uid: str) -> FileMetaDataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = DX_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop_instance_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    return meta


def _base_tags(ds: Dataset) -> None:
    ds.SOPClassUID = DX_SOP_CLASS
    ds.SOPInstanceUID = generate_uid()
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = 'DX'
    ds.PatientID = 'TEST-PID-001'
    ds.PatientName = 'Doe^John'            # PHI
    ds.PatientBirthDate = '19700101'       # PHI (not in KEEP_TAGS)
    ds.StudyDate = '20240101'
    ds.Rows = 8
    ds.Columns = 8
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.PixelData = b'\x00' * 8 * 8 * 2


@pytest.fixture
def minimal_ds() -> Dataset:
    """A Dataset with realistic PHI and a handful of allowlisted tags."""
    ds = Dataset()
    ds.file_meta = _make_file_meta(generate_uid())
    _base_tags(ds)
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    return ds


@pytest.fixture
def ds_with_private_tags(minimal_ds: Dataset) -> Dataset:
    # Private tag in a private group — pydicom emits a reservation
    # automatically when you add one.
    block = minimal_ds.private_block(0x0009, 'TEST^PRIVATE', create=True)
    block.add_new(0x01, 'LO', 'leaked-private-value')
    return minimal_ds


@pytest.fixture
def ds_with_ras_phi(minimal_ds: Dataset) -> Dataset:
    """RequestAttributesSequence containing PHI (mirrors
    dicom-dev-kit/definitions/01_ras_physician.py)."""
    item = Dataset()
    item.ReferringPhysicianName = 'TEST^REFERRER'
    item.RequestingPhysician = 'TEST^REQUESTER'
    item.AccessionNumber = 'TEST-ACC-0001'
    minimal_ds.RequestAttributesSequence = Sequence([item])
    return minimal_ds


@pytest.fixture
def ds_with_deep_nested_phi(minimal_ds: Dataset) -> Dataset:
    """3-level nested SQ with PN at the deepest level (mirrors
    dicom-dev-kit/definitions/05_deep_nested.py)."""
    ref_req = Dataset()
    ref_req.ReferringPhysicianName = 'TEST^DEEP^PHYS'
    ref_study = Dataset()
    ref_study.ReferencedRequestSequence = Sequence([ref_req])
    ras_item = Dataset()
    ras_item.ReferencedStudySequence = Sequence([ref_study])
    minimal_ds.RequestAttributesSequence = Sequence([ras_item])
    return minimal_ds


@pytest.fixture
def file_ds(tmp_path) -> FileDataset:
    """A saveable FileDataset on disk, with PHI included. Returns the
    dataset; caller uses `tmp_path / <name>.dcm` for output paths."""
    path = tmp_path / 'input.dcm'
    meta = _make_file_meta(generate_uid())
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b'\x00' * 128)
    _base_tags(ds)
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.save_as(path, enforce_file_format=True)
    return ds
