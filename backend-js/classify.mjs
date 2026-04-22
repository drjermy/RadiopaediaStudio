// Transfer-syntax, orientation and slice-spacing classifiers.
//
// Classification tables are duplicated across backends by design — see
// issue #2. Changes MUST land in both this file and backend/app/classify.py;
// the contract test pair (backend-js/test/classify-contract.test.mjs +
// backend/tests/test_classify_contract.py) reads a shared fixture
// (backend-js/test/classify-fixtures.json) and flags any drift.
//
// The Node sidecar runs anonymisation inline during a single streaming pass,
// so calling back to Python for each series would add an HTTP round-trip on
// the hot path. We accept the duplication and make drift obvious rather than
// silent.

// Transfer syntax tables -------------------------------------------------

export const TS_NAMES = {
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
};

export const TS_UNCOMPRESSED = new Set([
  '1.2.840.10008.1.2',
  '1.2.840.10008.1.2.1',
  '1.2.840.10008.1.2.2',
]);

export const TS_LOSSLESS = new Set([
  '1.2.840.10008.1.2.4.57',
  '1.2.840.10008.1.2.4.70',
  '1.2.840.10008.1.2.4.80',
  '1.2.840.10008.1.2.4.90',
  '1.2.840.10008.1.2.4.92',
  '1.2.840.10008.1.2.4.201',
  '1.2.840.10008.1.2.4.202',
  '1.2.840.10008.1.2.5',
]);

export function classifyTransferSyntax(uid) {
  if (!uid) return { uid: null, name: 'unknown', compressed: false, lossy: false };
  const name = TS_NAMES[uid] || uid;
  if (TS_UNCOMPRESSED.has(uid)) return { uid, name, compressed: false, lossy: false };
  if (TS_LOSSLESS.has(uid))     return { uid, name, compressed: true,  lossy: false };
  return { uid, name, compressed: true, lossy: true };
}

// Orientation / geometry -------------------------------------------------

// Classify a 6-number IOP array as axial/coronal/sagittal based on the
// dominant axis of the slice normal. Returns null for invalid input.
export function classifyOrientationArr(values) {
  if (!values || values.length !== 6) return null;
  const r = values.slice(0, 3).map(Number);
  const c = values.slice(3).map(Number);
  if (r.some(Number.isNaN) || c.some(Number.isNaN)) return null;
  const n = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const absN = n.map(Math.abs);
  const idx = absN.indexOf(Math.max(...absN));
  return ['sagittal', 'coronal', 'axial'][idx];
}

// Unit normal to the slice plane from the 6-number IOP (row + col vectors).
// Used to project ImagePositionPatient onto a 1-D axis for spacing calc.
export function sliceNormal(values) {
  if (!values || values.length !== 6) return null;
  const r = values.slice(0, 3).map(Number);
  const c = values.slice(3).map(Number);
  if (r.some((x) => !Number.isFinite(x)) || c.some((x) => !Number.isFinite(x))) return null;
  const n = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const mag = Math.hypot(n[0], n[1], n[2]);
  if (mag === 0) return null;
  return [n[0] / mag, n[1] / mag, n[2] / mag];
}

// Median absolute gap between adjacent positions along the slice normal,
// rounded to 2 decimal places. Returns null when fewer than 2 positions or
// all coincident.
export function medianSpacing(positions) {
  if (!positions || positions.length < 2) return null;
  const sorted = [...positions].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = Math.abs(sorted[i] - sorted[i - 1]);
    if (g > 1e-4) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const m = gaps.length >> 1;
  const med = gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
  return Math.round(med * 100) / 100;
}
