"""Allowlist-based DICOM scrub. Vendored from dicom-dev-kit (scrub_dcm.py).

Keep only tags in KEEP_TAGS, drop everything else including every sequence
and every private tag. Regenerate Study / Series / SOP Instance UIDs. Set
the standard de-identification flags. Default-deny: new PHI tags introduced
by scanner firmware updates can't sneak through just because nobody added
them to a blocklist.

Note: the runtime /anonymize path now goes through the Node sidecar
(backend-js/server.mjs) using Radiopaedia's `dicomanon`. This module is kept
as a reference implementation and to pin test invariants — see
tests/test_scrub.py and tests/test_uid_remap.py.
"""

from __future__ import annotations

from pathlib import Path

import pydicom
from pydicom.datadict import keyword_for_tag
from pydicom.uid import generate_uid

from app.classify import (
    classify_orientation,
    classify_transfer_syntax,
    median_spacing as _median_spacing,
    slice_normal as _slice_normal,
)
from app.logsafe import redact_path

__all__ = [
    'KEEP_TAGS',
    'classify_orientation',
    'find_dicoms',
    'is_dicom_file',
    'iter_scrub_folder',
    'scan_folder',
    'scrub',
    'scrub_file',
    'strip_phi',
]

KEEP_TAGS = {
    # File meta / identification
    'SpecificCharacterSet', 'ImageType', 'SOPClassUID', 'SOPInstanceUID',
    'Modality', 'Manufacturer', 'ManufacturerModelName',
    'AccessionNumber', 'ReferringPhysicianName',
    # Date / time tags are intentionally NOT in the allowlist — a
    # precise scan date can triangulate a patient via other records.
    # Revisit with date-shift (preserve relative timing, obscure absolute)
    # rather than adding tags back.
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
    ds.DeidentificationMethod = 'Radiopaedia Studio allowlist scrub'
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
    # Sort so callers get stable order — with rglob's filesystem ordering
    # the base series and its derived variants (folder name + suffix) can
    # land in any sequence, and the renderer just shows them in order.
    return sorted(p for p in input_dir.rglob('*') if is_dicom_file(p))


def _safe_float(v):
    try:
        return float(v) if v is not None else None
    except (ValueError, TypeError):
        return None


def _first_num(v):
    """Window Center/Width can be multi-valued — take the first number."""
    if v is None:
        return None
    try:
        if hasattr(v, '__iter__') and not isinstance(v, (str, bytes)):
            v = next(iter(v), None)
        return float(v) if v is not None else None
    except (TypeError, ValueError):
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
    # Keyed by original StudyInstanceUID; each study has its own series
    # dict keyed by original SeriesInstanceUID.
    studies: dict[str, dict] = {}
    # Per-series output paths, keyed by series UID. One flat map across
    # all studies is fine because Series UIDs are globally unique.
    series_paths: dict[str, list[Path]] = {}

    for src in find_dicoms(input_dir):
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        try:
            ds = pydicom.dcmread(src)

            # Capture study/series metadata BEFORE scrub — some fields
            # (StudyDescription, etc.) get stripped by strip_phi.
            orig_study = ds.get('StudyInstanceUID', None)
            orig_series = ds.get('SeriesInstanceUID', None)

            if orig_study and orig_study not in studies:
                studies[orig_study] = {
                    'description': (
                        str(ds.StudyDescription).strip()
                        if ds.get('StudyDescription', None) else None
                    ),
                    'modality': str(ds.Modality) if ds.get('Modality', None) else None,
                    'body_part': (
                        str(ds.BodyPartExamined)
                        if ds.get('BodyPartExamined', None) else None
                    ),
                    'study_date': (
                        str(ds.StudyDate) if ds.get('StudyDate', None) else None
                    ),
                    'total_slices': 0,
                    '_series': {},  # orig_series_uid -> series stats
                }

            if orig_study:
                studies[orig_study]['total_slices'] += 1
                series_map = studies[orig_study]['_series']
                if orig_series and orig_series not in series_map:
                    series_map[orig_series] = {
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
                    series_map[orig_series]['slice_count'] += 1
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
            yield {'input': redact_path(src), 'error': f'{type(e).__name__}: {e}'}

    if summary_out is not None:
        from app.thumbnails import make_thumbnail

        out_studies = []
        for study_uid, study in studies.items():
            series_map = study.pop('_series')
            out_series = []
            for series_uid, stats in series_map.items():
                paths = series_paths.get(series_uid, [])
                stats['folder'] = str(_common_parent(paths)) if paths else None
                # Thumbnail: middle file by path order. Silent on failure.
                if paths:
                    try:
                        middle = sorted(paths)[len(paths) // 2]
                        stats['thumbnail'] = make_thumbnail(pydicom.dcmread(middle))
                    except Exception:
                        stats['thumbnail'] = None
                out_series.append(stats)
            study['series_count'] = len(out_series)
            study['series'] = out_series
            out_studies.append(study)
        summary_out['studies'] = out_studies


def scan_folder(input_dir: Path) -> dict:
    """Read-only pass: group DICOMs by study/series, compute per-series
    metadata (orientation, thickness, computed spacing, transfer syntax,
    total bytes), render a middle-slice thumbnail. Returns the same
    summary shape the anonymiser produces, so the renderer reuses the
    study-summary view for both the 'Load' and 'Anonymise' flows."""
    from app.thumbnails import make_thumbnail

    studies: dict[str, dict] = {}
    series_paths: dict[str, list[Path]] = {}
    series_ipp: dict[str, list[tuple[float, float, float]]] = {}
    series_normal: dict[str, tuple[float, float, float] | None] = {}

    for src in find_dicoms(input_dir):
        try:
            ds = pydicom.dcmread(src, stop_before_pixels=True)
        except Exception:
            continue
        orig_study = ds.get('StudyInstanceUID', None)
        orig_series = ds.get('SeriesInstanceUID', None)
        if not orig_study or not orig_series:
            continue

        if orig_study not in studies:
            studies[orig_study] = {
                'description': (
                    str(ds.StudyDescription).strip()
                    if ds.get('StudyDescription', None) else None
                ),
                'modality': str(ds.Modality) if ds.get('Modality', None) else None,
                'body_part': (
                    str(ds.BodyPartExamined) if ds.get('BodyPartExamined', None) else None
                ),
                'study_date': str(ds.StudyDate) if ds.get('StudyDate', None) else None,
                'total_slices': 0,
                'total_bytes': 0,
                '_series': {},
            }
        studies[orig_study]['total_slices'] += 1
        file_size = src.stat().st_size
        studies[orig_study]['total_bytes'] += file_size

        series_map = studies[orig_study]['_series']
        if orig_series not in series_map:
            iop = ds.get('ImageOrientationPatient', None)
            series_map[orig_series] = {
                'description': (
                    str(ds.SeriesDescription).strip()
                    if ds.get('SeriesDescription', None) else None
                ),
                'modality': str(ds.Modality) if ds.get('Modality', None) else None,
                'orientation': classify_orientation(iop),
                'slice_thickness': _safe_float(ds.get('SliceThickness', None)),
                'slice_spacing': _safe_float(ds.get('SpacingBetweenSlices', None)),
                'slice_count': 0,
                'total_bytes': 0,
                'transfer_syntax': classify_transfer_syntax(
                    str(ds.file_meta.TransferSyntaxUID)
                    if getattr(ds, 'file_meta', None) else None
                ),
                'window_center': _first_num(ds.get('WindowCenter', None)),
                'window_width':  _first_num(ds.get('WindowWidth',  None)),
            }
            # Unit normal to the slice plane, reused for all slices in this series.
            series_normal[orig_series] = _slice_normal(iop)
            series_ipp[orig_series] = []

        series_map[orig_series]['slice_count'] += 1
        series_map[orig_series]['total_bytes'] += file_size
        series_paths.setdefault(orig_series, []).append(src)

        ipp = ds.get('ImagePositionPatient', None)
        normal = series_normal[orig_series]
        if ipp and normal and len(ipp) == 3:
            try:
                p = [float(x) for x in ipp]
                series_ipp[orig_series].append(
                    p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2]
                )
            except (ValueError, TypeError):
                pass

    out_studies = []
    for study_uid, study in studies.items():
        series_map = study.pop('_series')
        out_series = []
        for series_uid, stats in series_map.items():
            paths = series_paths.get(series_uid, [])
            stats['folder'] = str(_common_parent(paths)) if paths else None
            # Prefer spacing derived from IPP over the (often-missing)
            # SpacingBetweenSlices tag, same logic the anonymiser uses.
            computed = _median_spacing(series_ipp.get(series_uid, []))
            if computed is not None:
                stats['slice_spacing'] = computed
            if paths:
                try:
                    middle = sorted(paths)[len(paths) // 2]
                    stats['thumbnail'] = make_thumbnail(pydicom.dcmread(middle))
                except Exception:
                    stats['thumbnail'] = None
            out_series.append(stats)
        study['series_count'] = len(out_series)
        study['series'] = out_series
        out_studies.append(study)
    return {'studies': out_studies}


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
