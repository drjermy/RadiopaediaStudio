"""JPEG 2000 (re-)compression for a DICOM series. Ported from
dicom-dev-kit's _encode + compress_studies loop, simplified: the user
picks the mode (lossless or lossy at a given ratio) explicitly from
the UI, so we don't need the auto per-modality policy.

Requires pylibjpeg + pylibjpeg-openjpeg at runtime.
"""

from __future__ import annotations

from pathlib import Path

import pydicom
from pydicom.uid import JPEG2000, JPEG2000Lossless

from app.anonymizer import find_dicoms


def encode_jpeg2000(ds, *, ratio: float | None = None) -> None:
    """ratio=None → JPEG 2000 lossless. ratio>1 → JPEG 2000 lossy at that
    compression ratio (pylibjpeg-openjpeg knob)."""
    if ratio is None:
        ds.compress(JPEG2000Lossless, encoding_plugin='pylibjpeg')
        return
    if ratio <= 1:
        raise ValueError(f'ratio must be > 1 for lossy compression, got {ratio}')
    ds.compress(
        JPEG2000,
        encoding_plugin='pylibjpeg',
        compression_ratios=[ratio],
    )


def _stamp_lossy_tags(ds, ratio: float) -> None:
    ds.LossyImageCompression = '01'
    # Accumulate the ratio history rather than overwriting — DICOM allows
    # multi-valued LossyImageCompressionRatio / Method.
    existing_ratios = ds.get('LossyImageCompressionRatio', [])
    if not isinstance(existing_ratios, list):
        existing_ratios = [existing_ratios]
    ds.LossyImageCompressionRatio = [*existing_ratios, float(ratio)]
    existing_methods = ds.get('LossyImageCompressionMethod', [])
    if not isinstance(existing_methods, list):
        existing_methods = [existing_methods]
    ds.LossyImageCompressionMethod = [*existing_methods, 'ISO_15444_1']


def compress_file(input_path: Path, output_path: Path, ratio: float | None = None) -> None:
    ds = pydicom.dcmread(input_path)
    if 'PixelData' not in ds:
        raise ValueError(f'no PixelData in {input_path}')
    encode_jpeg2000(ds, ratio=ratio)
    if ratio is not None:
        _stamp_lossy_tags(ds, ratio)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(output_path, enforce_file_format=True)


def iter_compress_folder(input_dir: Path, output_dir: Path, ratio: float | None = None):
    """Mirror input_dir into output_dir, re-encoding every DICOM as JPEG 2000
    (lossless if ratio is None, else lossy at the given ratio)."""
    for src in find_dicoms(input_dir):
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        try:
            compress_file(src, dst, ratio=ratio)
            yield {'input': str(src), 'output': str(dst)}
        except Exception as e:
            yield {'input': str(src), 'error': f'{type(e).__name__}: {e}'}


def iter_recompress_in_place(folder: Path, ratio: float | None = None):
    """Re-encode every DICOM in `folder` as JPEG 2000, writing back to the
    same path. Used to compress the output of reformat/window without
    needing a temp directory."""
    for f in find_dicoms(folder):
        try:
            ds = pydicom.dcmread(f)
            if 'PixelData' not in ds:
                continue
            encode_jpeg2000(ds, ratio=ratio)
            if ratio is not None:
                _stamp_lossy_tags(ds, ratio)
            ds.save_as(f, enforce_file_format=True)
            yield {'input': str(f), 'output': str(f)}
        except Exception as e:
            yield {'input': str(f), 'error': f'{type(e).__name__}: {e}'}
