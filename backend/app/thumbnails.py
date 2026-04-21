"""Generate small PNG previews of DICOM slices for UI display.

Middle-slice thumbnail per series is enough for the user to recognise a
study at a glance. Applies rescale slope/intercept and the file's window
(falls back to min/max if none set). Inverts MONOCHROME1 so dark means
dark on screen regardless of photometric interpretation.
"""

from __future__ import annotations

import base64
from io import BytesIO

import numpy as np
import pydicom
from PIL import Image


def _first(v):
    """Window tags can be multi-valued. Take the first if so."""
    if v is None:
        return None
    if hasattr(v, '__iter__') and not isinstance(v, (str, bytes)):
        return next(iter(v), None)
    return v


def make_thumbnail(ds: pydicom.Dataset, max_size: int = 384) -> str | None:
    """Return a data-URL string (`data:image/png;base64,...`) for ds, or
    None if the slice isn't previewable (no PixelData, unsupported type)."""
    if 'PixelData' not in ds:
        return None
    try:
        arr = ds.pixel_array
    except Exception:
        return None
    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        # RGB / RGBA — skip windowing, resize as-is
        img = Image.fromarray(arr.astype(np.uint8)).convert('RGB')
    else:
        # Multi-frame (z, y, x): pick the middle frame
        if arr.ndim == 3:
            arr = arr[arr.shape[0] // 2]
        if arr.ndim != 2:
            return None

        slope = float(ds.get('RescaleSlope', 1) or 1)
        intercept = float(ds.get('RescaleIntercept', 0) or 0)
        arr = arr.astype(np.float32) * slope + intercept

        wc = _first(ds.get('WindowCenter', None))
        ww = _first(ds.get('WindowWidth', None))
        try:
            wc = float(wc) if wc is not None else None
            ww = float(ww) if ww is not None else None
        except (ValueError, TypeError):
            wc = ww = None
        if wc is not None and ww is not None and ww > 0:
            lo, hi = wc - ww / 2.0, wc + ww / 2.0
        else:
            lo, hi = float(arr.min()), float(arr.max())
        if hi <= lo:
            hi = lo + 1.0

        normed = np.clip((arr - lo) / (hi - lo), 0, 1)
        if ds.get('PhotometricInterpretation', '') == 'MONOCHROME1':
            normed = 1.0 - normed

        img = Image.fromarray((normed * 255).astype(np.uint8), mode='L')

    # Respect PixelSpacing so anisotropic reformats (thick-slice coronal /
    # sagittal MPR) look physically correct rather than squished to the
    # voxel grid.
    row_mm, col_mm = 1.0, 1.0
    ps = ds.get('PixelSpacing', None)
    if ps is not None:
        try:
            row_mm = float(ps[0])
            col_mm = float(ps[1])
        except (TypeError, ValueError, IndexError):
            row_mm, col_mm = 1.0, 1.0
    if row_mm > 0 and col_mm > 0 and (row_mm != col_mm):
        w_px, h_px = img.size
        phys_w = w_px * col_mm
        phys_h = h_px * row_mm
        scale = max_size / max(phys_w, phys_h)
        out_w = max(1, round(phys_w * scale))
        out_h = max(1, round(phys_h * scale))
        img = img.resize((out_w, out_h), Image.BILINEAR)
    else:
        img.thumbnail((max_size, max_size))

    buf = BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
