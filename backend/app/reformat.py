"""Thick-slab MPR reformat. Ported from dicom-dev-kit/reformat_series.py.

Reads a series, builds a 3-D volume, resamples to a target orientation
(axial/coronal/sagittal), reduces each thick slab with MIP / MinIP / Avg,
and writes a new DICOM series. Optionally sets WindowCenter/WindowWidth.

Adapted from the original:
  - no JPEG 2000 lossy branch (dropped `_encode` dependency)
  - raises exceptions instead of sys.exit
  - walks input recursively with rglob
  - a generator wrapper emits phase / file / done events for streaming progress
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from app.logsafe import redact_error_message


ORIENTATIONS = ('axial', 'coronal', 'sagittal')
MODES = ('mip', 'minip', 'avg')

OUTPUT_IOP = {
    'axial':    (1.0, 0.0, 0.0,  0.0, 1.0, 0.0),
    'coronal':  (1.0, 0.0, 0.0,  0.0, 0.0, -1.0),
    'sagittal': (0.0, 1.0, 0.0,  0.0, 0.0, -1.0),
}

# Context tags copied from the template slice into each reformat output.
# Everything else on the output is freshly set by write_series() below.
_TEMPLATE_TAGS = (
    'SpecificCharacterSet',
    'PatientID', 'PatientAge', 'PatientSex', 'PatientWeight',
    'PatientIdentityRemoved', 'DeidentificationMethod', 'BurnedInAnnotation',
    'StudyInstanceUID', 'StudyID',
    'AccessionNumber', 'ReferringPhysicianName',
    'Modality', 'Manufacturer', 'ManufacturerModelName', 'SoftwareVersions',
    'BodyPartExamined', 'ContrastBolusAgent',
    'KVP', 'XRayTubeCurrent', 'Exposure', 'ExposureTime',
    'ConvolutionKernel', 'FilterType', 'PatientPosition',
)


def _ds(v: float) -> str:
    """Format a float as a DICOM Decimal String (DS) — VR limit is 16 chars.

    Default `float()` -> DSfloat in pydicom keeps the full Python repr, which
    overflows DS for typical mm-scale values (e.g. -191.30984871962332 = 19
    chars, 2.000360804591878 = 17 chars). Strict DICOM readers reject those;
    Radiopaedia's downstream tooling silently truncates and produces wrong
    values. 6 significant figures is plenty for clinical spacing / position
    in mm and always fits in 16 chars within ±999_999.
    """
    return f'{v:.6g}'


def _ds_list(vs) -> list[str]:
    return [_ds(float(v)) for v in vs]


def read_series(input_dir: Path) -> list[Dataset]:
    """Read every DICOM slice in input_dir (recursive), skipping unreadable
    or non-image files. Returns in file-name order (sorted later)."""
    slices: list[Dataset] = []
    for entry in sorted(input_dir.rglob('*')):
        if not entry.is_file() or entry.name.startswith('.'):
            continue
        try:
            ds = pydicom.dcmread(str(entry))
        except pydicom.errors.InvalidDicomError:
            continue
        except Exception:
            continue
        if 'PixelData' not in ds or 'ImagePositionPatient' not in ds:
            continue
        slices.append(ds)
    if not slices:
        raise ValueError(f'No DICOM slices with PixelData + ImagePositionPatient found in {input_dir}')
    return slices


def apply_rescale(ds: Dataset) -> np.ndarray:
    """Slice pixels in real-world units (HU for CT)."""
    pixels = ds.pixel_array.astype(np.float32)
    slope = float(ds.get('RescaleSlope', 1) or 1)
    intercept = float(ds.get('RescaleIntercept', 0) or 0)
    return pixels * slope + intercept


def build_volume(slices: list[Dataset]) -> tuple[np.ndarray, dict]:
    first = slices[0]
    row_cos = np.array(first.ImageOrientationPatient[:3], dtype=float)
    col_cos = np.array(first.ImageOrientationPatient[3:], dtype=float)
    normal = np.cross(row_cos, col_cos)

    def along_normal(ds: Dataset) -> float:
        return float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), normal))

    slices = sorted(slices, key=along_normal)
    positions = np.array([along_normal(ds) for ds in slices], dtype=float)
    if len(slices) > 1:
        dz = float(np.median(np.diff(positions)))
    else:
        dz = float(first.get('SliceThickness', 1.0))
    if dz <= 0:
        raise ValueError('Could not determine slice spacing (non-positive dz).')

    dy, dx = (float(v) for v in first.PixelSpacing)
    volume = np.stack([apply_rescale(ds) for ds in slices], axis=0).astype(np.float32)
    origin = np.array(slices[0].ImagePositionPatient, dtype=float)

    return volume, {
        'template': slices[len(slices) // 2],
        'row_cos': row_cos, 'col_cos': col_cos, 'normal': normal,
        'origin': origin, 'dx': dx, 'dy': dy, 'dz': dz,
        'num_slices': len(slices),
        'rows': int(first.Rows), 'cols': int(first.Columns),
    }


def project_slab(slab: np.ndarray, mode: str) -> np.ndarray:
    if slab.shape[0] == 1:
        return slab[0]
    if mode == 'mip':
        return np.max(slab, axis=0)
    if mode == 'minip':
        return np.min(slab, axis=0)
    return np.mean(slab, axis=0)


def slab_indices(axis_min: float, axis_max: float, thickness: float, spacing: float) -> list[float]:
    extent = axis_max - axis_min
    if thickness > extent:
        return []
    count = int(np.floor((extent - thickness) / spacing)) + 1
    return [axis_min + thickness / 2.0 + i * spacing for i in range(count)]


def slab_range(center_mm: float, thickness: float, voxel_spacing: float, n_voxels: int) -> tuple[int, int]:
    lo_mm = center_mm - thickness / 2.0
    hi_mm = center_mm + thickness / 2.0
    lo_idx = max(0, int(np.ceil(lo_mm / voxel_spacing - 0.5)))
    hi_idx = min(n_voxels - 1, int(np.floor(hi_mm / voxel_spacing - 0.5)))
    if hi_idx < lo_idx:
        nearest = int(round(center_mm / voxel_spacing - 0.5))
        nearest = max(0, min(n_voxels - 1, nearest))
        return nearest, nearest
    return lo_idx, hi_idx


def reformat(volume: np.ndarray, meta: dict, orientation: str, thickness: float,
             spacing: float, mode: str):
    dx, dy, dz = meta['dx'], meta['dy'], meta['dz']
    n_z, n_y, n_x = volume.shape
    origin = meta['origin']
    row_cos = meta['row_cos']
    col_cos = meta['col_cos']
    normal = meta['normal']

    iop = OUTPUT_IOP[orientation]
    images: list[np.ndarray] = []
    positions: list[np.ndarray] = []

    if orientation == 'axial':
        centres = slab_indices(0.0, (n_z - 1) * dz, thickness, spacing)
        for c in centres:
            lo, hi = slab_range(c, thickness, dz, n_z)
            images.append(project_slab(volume[lo:hi + 1, :, :], mode))
            positions.append(origin + normal * c)
        return images, positions, iop, (dy, dx)

    if orientation == 'coronal':
        centres = slab_indices(0.0, (n_y - 1) * dy, thickness, spacing)
        for c in centres:
            lo, hi = slab_range(c, thickness, dy, n_y)
            slab = volume[:, lo:hi + 1, :]
            slab = np.moveaxis(slab, 1, 0)
            img = project_slab(slab, mode)
            img = np.flipud(img)
            images.append(img)
            z_max_mm = (n_z - 1) * dz
            positions.append(origin + col_cos * c + normal * z_max_mm)
        return images, positions, iop, (dz, dx)

    # sagittal
    centres = slab_indices(0.0, (n_x - 1) * dx, thickness, spacing)
    for c in centres:
        lo, hi = slab_range(c, thickness, dx, n_x)
        slab = volume[:, :, lo:hi + 1]
        slab = np.moveaxis(slab, 2, 0)
        img = project_slab(slab, mode)
        img = np.flipud(img)
        images.append(img)
        z_max_mm = (n_z - 1) * dz
        positions.append(origin + row_cos * c + normal * z_max_mm)
    return images, positions, iop, (dz, dy)


def iter_write_series(images: list[np.ndarray], positions: list[np.ndarray], iop: tuple,
                      pixel_spacing: tuple[float, float], template: Dataset,
                      output_dir: Path, orientation: str, thickness: float,
                      spacing: float, mode: str, window_center: float | None,
                      window_width: float | None,
                      is_cancelled: Callable[[], bool] | None = None):
    """Write the reformat output slice-by-slice. Yields each written path
    so the caller can stream progress events.

    is_cancelled, if supplied, is polled before each slice write; returning
    True stops iteration (partial output left on disk)."""
    output_dir.mkdir(parents=True, exist_ok=True)

    series_uid = generate_uid(prefix='2.25.')
    frame_of_reference = template.get('FrameOfReferenceUID') or generate_uid(prefix='2.25.')
    series_desc = (
        f"{(template.get('SeriesDescription') or 'Reformat').strip()} "
        f"- {orientation} {thickness:g}mm {mode.upper()}"
    )

    stacked = np.stack(images, axis=0)
    stacked = np.round(stacked).astype(np.int16)

    for idx, (img, ipp) in enumerate(zip(stacked, positions), start=1):
        if is_cancelled is not None and is_cancelled():
            return
        ds = Dataset()
        for tag in _TEMPLATE_TAGS:
            if tag in template:
                setattr(ds, tag, template.get(tag))

        ds.SeriesInstanceUID = series_uid
        ds.SOPInstanceUID = generate_uid(prefix='2.25.')
        ds.SOPClassUID = template.get('SOPClassUID', '1.2.840.10008.5.1.4.1.1.2')
        ds.SeriesNumber = int(template.get('SeriesNumber', 1)) * 100 + 1
        ds.SeriesDescription = series_desc
        ds.InstanceNumber = idx
        ds.FrameOfReferenceUID = frame_of_reference

        ds.ImageOrientationPatient = _ds_list(iop)
        ds.ImagePositionPatient = _ds_list(ipp)
        ds.PixelSpacing = _ds_list(pixel_spacing)
        ds.SliceThickness = _ds(float(thickness))
        ds.SpacingBetweenSlices = _ds(float(spacing))

        ds.Rows, ds.Columns = img.shape
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = 'MONOCHROME2'
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 1
        ds.RescaleSlope = 1
        ds.RescaleIntercept = 0
        if template.get('RescaleType'):
            ds.RescaleType = template.get('RescaleType')

        if window_center is not None and window_width is not None:
            ds.WindowCenter = float(window_center)
            ds.WindowWidth = float(window_width)
        elif template.get('WindowCenter') is not None and template.get('WindowWidth') is not None:
            ds.WindowCenter = template.get('WindowCenter')
            ds.WindowWidth = template.get('WindowWidth')

        ds.PixelData = img.tobytes()

        file_meta = FileMetaDataset()
        file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
        file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.file_meta = file_meta
        ds.is_little_endian = True
        ds.is_implicit_VR = False

        out_path = output_dir / f'slice{idx:04d}.dcm'
        pydicom.dcmwrite(str(out_path), ds, enforce_file_format=True)
        yield out_path


def iter_reformat_series(input_dir: Path, output_dir: Path, orientation: str,
                         thickness: float, spacing: float, mode: str,
                         window_center: float | None = None,
                         window_width: float | None = None,
                         is_cancelled: Callable[[], bool] | None = None):
    """Generator that yields phase/file events for UI streaming.

    Events:
      {'type': 'phase', 'label': str}   — user-visible status
      {'type': 'total', 'total': int}   — expected output slice count (once known)
      {'type': 'file',  'output': str}  — a slice was written
      {'type': 'error', 'error': str}   — fatal; iteration stops

    is_cancelled, if supplied, is polled before each written slice; returning
    True stops the stream (partial output left on disk).
    """
    if orientation not in ORIENTATIONS:
        yield {'type': 'error', 'error': f'invalid orientation: {orientation}'}
        return
    if mode not in MODES:
        yield {'type': 'error', 'error': f'invalid mode: {mode}'}
        return
    if thickness <= 0 or spacing <= 0:
        yield {'type': 'error', 'error': 'thickness and spacing must be positive'}
        return

    try:
        yield {'type': 'phase', 'label': 'Reading series'}
        slices = read_series(input_dir)

        yield {'type': 'phase', 'label': 'Building volume'}
        volume, meta = build_volume(slices)

        yield {'type': 'phase', 'label': 'Reformatting'}
        images, positions, iop, pixel_spacing = reformat(
            volume, meta, orientation, thickness, spacing, mode,
        )
        if not images:
            yield {'type': 'error', 'error':
                   f'slab thickness ({thickness}mm) exceeds volume extent along {orientation}'}
            return

        yield {'type': 'total', 'total': len(images)}
        for written_path in iter_write_series(
            images, positions, iop, pixel_spacing, meta['template'],
            output_dir, orientation, thickness, spacing, mode,
            window_center, window_width, is_cancelled=is_cancelled,
        ):
            yield {'type': 'file', 'output': str(written_path)}
    except Exception as e:
        yield {'type': 'error', 'error': redact_error_message(f'{type(e).__name__}: {e}')}
