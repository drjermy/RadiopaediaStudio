"""Apply WindowCenter / WindowWidth to DICOM files.

Non-destructive — pixel data is untouched. Only the display-window tags
are rewritten. Useful for teaching cases where an appropriate preset
(brain, lung, bone, abdomen, mediastinum) makes the case readable at a
glance without the viewer having to adjust.

Accepts any file that already has PixelData. Typically run over an
already-anonymised output.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pydicom
from pydicom.uid import generate_uid

from app.logsafe import redact_error_message, redact_path


# Centre / width presets as commonly used in clinical display.
PRESETS: dict[str, tuple[float, float]] = {
    'brain': (40, 80),
    'subdural': (80, 200),
    'stroke': (32, 8),
    'lung': (-600, 1500),
    'bone': (400, 1800),
    'soft_tissue': (50, 350),
    'mediastinum': (40, 400),
    'liver': (60, 160),
}


def apply_window(ds, center: float, width: float) -> None:
    """Set WindowCenter / WindowWidth on ds. Clears any multi-valued
    centre/width and any WindowCenterWidthExplanation so the new values
    aren't ambiguously paired with a stale description."""
    ds.WindowCenter = float(center)
    ds.WindowWidth = float(width)
    if 'WindowCenterWidthExplanation' in ds:
        del ds.WindowCenterWidthExplanation


def _regen_for_new_series(ds, series_remap) -> None:
    """Give the windowed output new Series + SOP UIDs so Radiopaedia
    treats it as a distinct series from the base. Study UID and Frame
    of Reference UID are preserved so the windowed version stays in the
    same case and still spatially registers with the base."""
    ds.SOPInstanceUID = generate_uid(prefix='2.25.')
    if 'SeriesInstanceUID' in ds:
        ds.SeriesInstanceUID = series_remap(ds.SeriesInstanceUID)
    if hasattr(ds, 'file_meta'):
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID


def apply_window_file(
    input_path: Path, output_path: Path, center: float, width: float,
) -> dict:
    """Single-file windowing. Generates a fresh SOP + Series UID so the
    output is a distinct series from the input."""
    ds = pydicom.dcmread(input_path)
    apply_window(ds, center, width)
    series_remap = lambda _original: generate_uid(prefix='2.25.')
    _regen_for_new_series(ds, series_remap)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(output_path, enforce_file_format=True)
    return {'center': center, 'width': width}


def iter_apply_window_folder(
    input_dir: Path, output_dir: Path, center: float, width: float,
    *,
    is_cancelled: Callable[[], bool] | None = None,
):
    """Mirror input_dir into output_dir, writing windowed copies of every
    *.dcm. Files that were originally in the same series end up in the
    same NEW series (distinct from the base); Study UID and Frame of
    Reference UID are preserved. Per-file failures yielded rather than
    raised.

    is_cancelled, if supplied, is polled once per file; returning True
    stops the loop immediately (partial output left on disk).
    """
    from app.anonymizer import find_dicoms

    cache: dict[str, str] = {}
    def series_remap(original):
        if original is None:
            return None
        if original not in cache:
            cache[original] = generate_uid(prefix='2.25.')
        return cache[original]

    for src in find_dicoms(input_dir):
        if is_cancelled is not None and is_cancelled():
            return
        rel = src.relative_to(input_dir)
        dst = output_dir / rel
        try:
            ds = pydicom.dcmread(src)
            apply_window(ds, center, width)
            _regen_for_new_series(ds, series_remap)
            dst.parent.mkdir(parents=True, exist_ok=True)
            ds.save_as(dst, enforce_file_format=True)
            yield {'input': str(src), 'output': str(dst), 'center': center, 'width': width}
        except Exception as e:
            yield {'input': redact_path(src), 'error': redact_error_message(f'{type(e).__name__}: {e}')}
