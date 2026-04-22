"""Transfer-syntax, orientation and slice-spacing classifiers.

Classification tables are duplicated across backends by design — see issue
#2. Changes MUST land in both this file and backend-js/classify.mjs; the
contract test pair (backend-js/test/classify-contract.test.mjs +
backend/tests/test_classify_contract.py) reads a shared fixture
(backend-js/test/classify-fixtures.json) and flags any drift.

The Node sidecar runs anonymisation inline during a single streaming pass,
so calling back to Python for each series would add an HTTP round-trip on
the hot path. We accept the duplication and make drift obvious rather than
silent.
"""

from __future__ import annotations


# Transfer syntax tables -------------------------------------------------

_TS_NAMES = {
    '1.2.840.10008.1.2':       'uncompressed (implicit LE)',
    '1.2.840.10008.1.2.1':     'uncompressed',
    '1.2.840.10008.1.2.2':     'uncompressed (explicit BE)',
    '1.2.840.10008.1.2.4.50':  'JPEG baseline',
    '1.2.840.10008.1.2.4.51':  'JPEG extended',
    '1.2.840.10008.1.2.4.57':  'JPEG lossless',
    '1.2.840.10008.1.2.4.70':  'JPEG lossless SV1',
    '1.2.840.10008.1.2.4.80':  'JPEG-LS lossless',
    '1.2.840.10008.1.2.4.81':  'JPEG-LS lossy',
    '1.2.840.10008.1.2.4.90':  'JPEG 2000 lossless',
    '1.2.840.10008.1.2.4.91':  'JPEG 2000 lossy',
    '1.2.840.10008.1.2.4.92':  'JPEG 2000 pt2 lossless',
    '1.2.840.10008.1.2.4.93':  'JPEG 2000 pt2 lossy',
    '1.2.840.10008.1.2.4.201': 'HTJ2K lossless',
    '1.2.840.10008.1.2.4.202': 'HTJ2K lossless-only',
    '1.2.840.10008.1.2.4.203': 'HTJ2K lossy',
    '1.2.840.10008.1.2.5':     'RLE lossless',
}

_TS_UNCOMPRESSED = {
    '1.2.840.10008.1.2',
    '1.2.840.10008.1.2.1',
    '1.2.840.10008.1.2.2',
}

_TS_LOSSLESS = {
    '1.2.840.10008.1.2.4.57',
    '1.2.840.10008.1.2.4.70',
    '1.2.840.10008.1.2.4.80',
    '1.2.840.10008.1.2.4.90',
    '1.2.840.10008.1.2.4.92',
    '1.2.840.10008.1.2.4.201',
    '1.2.840.10008.1.2.4.202',
    '1.2.840.10008.1.2.5',
}


def classify_transfer_syntax(uid: str | None) -> dict:
    """Map a TransferSyntaxUID to {uid, name, compressed, lossy}."""
    if not uid:
        return {'uid': None, 'name': 'unknown', 'compressed': False, 'lossy': False}
    name = _TS_NAMES.get(uid, uid)
    if uid in _TS_UNCOMPRESSED:
        return {'uid': uid, 'name': name, 'compressed': False, 'lossy': False}
    if uid in _TS_LOSSLESS:
        return {'uid': uid, 'name': name, 'compressed': True, 'lossy': False}
    return {'uid': uid, 'name': name, 'compressed': True, 'lossy': True}


# Orientation / geometry -------------------------------------------------

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
    n = [
        r[1] * c[2] - r[2] * c[1],
        r[2] * c[0] - r[0] * c[2],
        r[0] * c[1] - r[1] * c[0],
    ]
    abs_n = [abs(x) for x in n]
    axes = ('sagittal', 'coronal', 'axial')  # index matches argmax of normal
    return axes[abs_n.index(max(abs_n))]


def slice_normal(iop):
    """Unit normal to the slice plane from a 6-number IOP. Returns a
    3-tuple, or None for invalid / degenerate input."""
    if not iop or len(iop) != 6:
        return None
    try:
        r = [float(x) for x in iop[:3]]
        c = [float(x) for x in iop[3:]]
    except (ValueError, TypeError):
        return None
    n = (
        r[1] * c[2] - r[2] * c[1],
        r[2] * c[0] - r[0] * c[2],
        r[0] * c[1] - r[1] * c[0],
    )
    mag = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5
    if mag == 0:
        return None
    return (n[0] / mag, n[1] / mag, n[2] / mag)


def median_spacing(positions):
    """Median absolute gap between adjacent positions along the slice
    normal, rounded to 2 decimal places. Returns None when fewer than 2
    positions or all coincident."""
    if not positions or len(positions) < 2:
        return None
    sorted_pos = sorted(positions)
    gaps = []
    for i in range(1, len(sorted_pos)):
        g = abs(sorted_pos[i] - sorted_pos[i - 1])
        if g > 1e-4:
            gaps.append(g)
    if not gaps:
        return None
    gaps.sort()
    mid = len(gaps) // 2
    med = gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2
    return round(med * 100) / 100
