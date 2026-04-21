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


def is_dicom_file(path: Path) -> bool:
    """Detect a DICOM file by extension OR by peeking at the DICM magic
    at byte offset 128 — PACS exports often use extensionless filenames
    like `I1001000`, so extension alone is unreliable."""
    if not path.is_file():
        return False
    if path.name.startswith('.'):
        return False
    if path.suffix.lower() in ('.dcm', '.dicom'):
        return True
    try:
        with open(path, 'rb') as f:
            f.seek(128)
            return f.read(4) == b'DICM'
    except OSError:
        return False


def find_dicoms(input_dir: Path) -> list[Path]:
    return [p for p in input_dir.rglob('*') if is_dicom_file(p)]


def classify_orientation(iop) -> str | None:
    """Classify an ImageOrientationPatient vector as axial, coronal, or
    sagittal based on the dominant axis of the slice normal. Returns None
    if the IOP isn't valid."""
    if not iop or len(iop) != 6:
        return None
    try:
        r = [float(v) for v in iop[:3]]
        c = [float(v) for v in iop[3:]]
    except (ValueError, TypeError):
        return None
    # normal = row × col
    n = [
        r[1] * c[2] - r[2] * c[1],
        r[2] * c[0] - r[0] * c[2],
        r[0] * c[1] - r[1] * c[0],
    ]
    abs_n = [abs(x) for x in n]
    axes = ('sagittal', 'coronal', 'axial')  # index matches argmax of normal
    return axes[abs_n.index(max(abs_n))]


def _safe_float(v):
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def iter_scrub_folder(input_dir: Path, output_dir: Path, *, summary_out: dict | None = None):
    """Yield per-file results as they're processed. Per-file failures are
    yielded rather than raised. UIDs are remapped consistently across the
    whole folder: same original Study/Series/FrameOfRef UIDs map to the
    same new UIDs, so files that were in the same series stay in the
    same series. SOPInstanceUIDs are always regenerated fresh per file.

    If summary_out is provided, the dict is populated with study/series
    metadata collected during the pass — modality, body part, per-series
    orientation, slice counts, slice thickness. Caller can emit it after
    iteration as a UI-visible summary event.
    """
    remap = _make_group_remap()
    series_stats: dict[str, dict] = {}
    series_paths: dict[str, list[Path]] = {}
    study_info: dict = {'total_slices': 0}

    for src in find_dicoms(input_dir):
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        try:
            ds = pydicom.dcmread(src)

            # Capture study/series metadata BEFORE scrub — some fields
            # (StudyDescription, etc.) get stripped by strip_phi.
            orig_series = ds.get('SeriesInstanceUID', None)
            if 'modality' not in study_info and ds.get('Modality', None):
                study_info['modality'] = str(ds.Modality)
            if 'body_part' not in study_info and ds.get('BodyPartExamined', None):
                study_info['body_part'] = str(ds.BodyPartExamined)
            if 'description' not in study_info and ds.get('StudyDescription', None):
                study_info['description'] = str(ds.StudyDescription)
            study_info['total_slices'] += 1

            if orig_series and orig_series not in series_stats:
                series_stats[orig_series] = {
                    'description': (
                        str(ds.SeriesDescription).strip()
                        if ds.get('SeriesDescription', None) else None
                    ),
                    'modality': str(ds.Modality) if ds.get('Modality', None) else None,
                    'orientation': classify_orientation(
                        ds.get('ImageOrientationPatient', None)
                    ),
                    'slice_thickness': _safe_float(ds.get('SliceThickness', None)),
                    'slice_count': 0,
                }
            if orig_series:
                series_stats[orig_series]['slice_count'] += 1
                series_paths.setdefault(orig_series, []).append(dst)

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

    if summary_out is not None:
        from app.thumbnails import make_thumbnail

        study_info['series_count'] = len(series_stats)
        for orig_uid, stats in series_stats.items():
            paths = series_paths.get(orig_uid, [])
            stats['folder'] = str(_common_parent(paths)) if paths else None
            # Thumbnail: pick the middle written file (by sorted path) and
            # render a small PNG preview. Silently skip on failure — the UI
            # falls back to no thumbnail rather than breaking the summary.
            if paths:
                try:
                    middle = sorted(paths)[len(paths) // 2]
                    stats['thumbnail'] = make_thumbnail(pydicom.dcmread(middle))
                except Exception:
                    stats['thumbnail'] = None
        summary_out['study'] = study_info
        summary_out['series'] = list(series_stats.values())


def _common_parent(paths: list[Path]) -> Path:
    """Longest path that's an ancestor of every given path. For a single
    path, returns its parent directory."""
    if len(paths) == 1:
        return paths[0].parent
    parts_lists = [p.parts for p in paths]
    common: list[str] = []
    for group in zip(*parts_lists):
        if len(set(group)) == 1:
            common.append(group[0])
        else:
            break
    return Path(*common) if common else paths[0].parent
