"""Allowlist-based DICOM scrub. Vendored from dicom-dev-kit (scrub_dcm.py).

Keep only tags in KEEP_TAGS, drop everything else including every sequence
and every private tag. Regenerate Study / Series / SOP Instance UIDs. Set
the standard de-identification flags. Default-deny: new PHI tags introduced
by scanner firmware updates can't sneak through just because nobody added
them to a blocklist.
"""

from __future__ import annotations

from pathlib import Path

import pydicom
from pydicom.datadict import keyword_for_tag
from pydicom.uid import generate_uid

KEEP_TAGS = {
    # File meta / identification
    'SpecificCharacterSet', 'ImageType', 'SOPClassUID', 'SOPInstanceUID',
    'Modality', 'Manufacturer', 'ManufacturerModelName',
    'AccessionNumber', 'ReferringPhysicianName',
    'StudyDate', 'SeriesDate', 'AcquisitionDate', 'ContentDate',
    'StudyTime', 'SeriesTime', 'AcquisitionTime', 'ContentTime',
    'SeriesDescription',
    # Patient (coarse demographics only; values pass through from source)
    'PatientID', 'PatientSex', 'PatientAge', 'PatientWeight',
    # De-id flags
    'PatientIdentityRemoved', 'DeidentificationMethod',
    # Acquisition — X-ray / DX / CR
    'ContrastBolusAgent', 'BodyPartExamined',
    'KVP', 'SoftwareVersions',
    'DistanceSourceToDetector', 'DistanceSourceToPatient',
    'ExposureTime', 'XRayTubeCurrent',
    'Exposure', 'ExposureInuAs', 'ImageAndFluoroscopyAreaDoseProduct',
    'ImagerPixelSpacing',
    'DetectorType', 'DetectorDescription',
    'ExposureControlMode', 'ExposureControlModeDescription',
    # Acquisition — CT
    'SliceThickness', 'DataCollectionDiameter', 'ReconstructionDiameter',
    'GantryDetectorTilt', 'TableHeight', 'RotationDirection',
    'FilterType', 'GeneratorPower', 'FocalSpots', 'ConvolutionKernel',
    'SingleCollimationWidth', 'TotalCollimationWidth',
    'TableSpeed', 'TableFeedPerRotation', 'SpiralPitchFactor',
    'ReconstructionTargetCenterPatient', 'ExposureModulationType',
    'CTDIvol',
    # Relationship / geometry
    'StudyInstanceUID', 'SeriesInstanceUID',
    'StudyID', 'SeriesNumber', 'InstanceNumber', 'AcquisitionNumber',
    'PatientOrientation', 'PatientPosition',
    'Laterality', 'ImageLaterality',
    'ImagePositionPatient', 'ImageOrientationPatient',
    'FrameOfReferenceUID', 'PositionReferenceIndicator', 'SliceLocation',
    # Image pixel / presentation (required for valid image display)
    'SamplesPerPixel', 'PhotometricInterpretation', 'PlanarConfiguration',
    'Rows', 'Columns', 'PixelSpacing',
    'BitsAllocated', 'BitsStored', 'HighBit', 'PixelRepresentation',
    'SmallestImagePixelValue', 'LargestImagePixelValue',
    'BurnedInAnnotation',
    'PixelIntensityRelationship', 'PixelIntensityRelationshipSign',
    'WindowCenter', 'WindowWidth',
    'RescaleIntercept', 'RescaleSlope', 'RescaleType',
    'WindowCenterWidthExplanation', 'VOILUTFunction',
    'LossyImageCompression', 'LossyImageCompressionRatio',
    'LossyImageCompressionMethod',
    'PresentationLUTShape',
    # Pixel data itself
    'PixelData',
}


def strip_phi(ds) -> tuple[int, int, list[str]]:
    """Drop non-allowlisted tags and set de-id flags. Does NOT regenerate
    UIDs — caller is responsible for that, so folder-level callers can
    use a consistent remap and single-file callers can generate fresh."""
    ds.remove_private_tags()

    kept = 0
    dropped: list[str] = []
    for elem in list(ds):
        kw = keyword_for_tag(elem.tag)
        if kw and kw in KEEP_TAGS:
            kept += 1
        else:
            dropped.append(kw or f'{elem.tag}')
            del ds[elem.tag]

    ds.PatientIdentityRemoved = 'YES'
    ds.DeidentificationMethod = 'pacs-anonymizer allowlist scrub'
    if 'BurnedInAnnotation' not in ds:
        ds.BurnedInAnnotation = 'NO'

    return kept, len(dropped), dropped


def _make_group_remap():
    """Return a function that maps each distinct original UID to a
    stable fresh 2.25.* UID. Same input → same output on repeat calls,
    so files originally sharing a UID share the new one."""
    cache: dict[str, str] = {}
    def remap(original):
        if original is None:
            return None
        if original not in cache:
            cache[original] = generate_uid(prefix='2.25.')
        return cache[original]
    return remap


def scrub(ds) -> tuple[int, int, list[str]]:
    """Single-file scrub: strip PHI + regenerate every UID independently.
    Folder-level scrubbing uses shared remapping — see iter_scrub_folder."""
    kept, n_dropped, dropped = strip_phi(ds)
    ds.SOPInstanceUID = generate_uid(prefix='2.25.')
    if 'StudyInstanceUID' in ds:
        ds.StudyInstanceUID = generate_uid(prefix='2.25.')
    if 'SeriesInstanceUID' in ds:
        ds.SeriesInstanceUID = generate_uid(prefix='2.25.')
    if 'FrameOfReferenceUID' in ds:
        ds.FrameOfReferenceUID = generate_uid(prefix='2.25.')
    if hasattr(ds, 'file_meta'):
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    return kept, n_dropped, dropped


def scrub_file(input_path: Path, output_path: Path) -> dict:
    ds = pydicom.dcmread(input_path)
    kept, n_dropped, dropped = scrub(ds)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(output_path, enforce_file_format=True)
    return {'kept': kept, 'dropped': n_dropped, 'dropped_tags': dropped}


def find_dicoms(input_dir: Path) -> list[Path]:
    return [p for p in input_dir.rglob('*') if p.is_file() and p.suffix.lower() == '.dcm']


def iter_scrub_folder(input_dir: Path, output_dir: Path):
    """Yield per-file results as they're processed. Per-file failures are
    yielded rather than raised. UIDs are remapped consistently across the
    whole folder: same original Study/Series/FrameOfRef UIDs map to the
    same new UIDs, so files that were in the same series stay in the
    same series. SOPInstanceUIDs are always regenerated fresh per file.
    """
    remap = _make_group_remap()

    for src in find_dicoms(input_dir):
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        try:
            ds = pydicom.dcmread(src)
            kept, n_dropped, dropped = strip_phi(ds)
            # SOP UID always fresh; Study/Series/FrameOfRef remapped consistently.
            ds.SOPInstanceUID = generate_uid(prefix='2.25.')
            if 'StudyInstanceUID' in ds:
                ds.StudyInstanceUID = remap(ds.StudyInstanceUID)
            if 'SeriesInstanceUID' in ds:
                ds.SeriesInstanceUID = remap(ds.SeriesInstanceUID)
            if 'FrameOfReferenceUID' in ds:
                ds.FrameOfReferenceUID = remap(ds.FrameOfReferenceUID)
            if hasattr(ds, 'file_meta'):
                ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID

            dst.parent.mkdir(parents=True, exist_ok=True)
            ds.save_as(dst, enforce_file_format=True)
            yield {
                'input': str(src),
                'output': str(dst),
                'kept': kept,
                'dropped': n_dropped,
                'dropped_tags': dropped,
            }
        except Exception as e:
            yield {'input': str(src), 'error': f'{type(e).__name__}: {e}'}
