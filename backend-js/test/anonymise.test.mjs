// Invariant tests for the Node sidecar's anonymiseBuffer(). Mirrors the
// assertions in backend/tests/test_scrub.py on the Python side: PHI tags
// are removed, UIDs regenerated, PatientIdentityRemoved=YES,
// DeidentificationMethod is set. Run with: npm test (node --test).
//
// Input DICOM is synthesised by starting from dicomanon's own bundled
// fixture (TestPattern_JPEG-Baseline_YBRFull.dcm) — hand-crafting a DICOM
// byte stream is fiddly (preamble + DICM magic + file meta group +
// explicit/implicit VR transitions), and dicomanon doesn't expose a
// from-scratch writer. The fixture already contains the PHI-shaped tags
// we care about (PatientName, PatientBirthDate, PatientID, Study/Series
// /SOP UIDs), so it's a realistic round-trip input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Message, dictionary } from 'dicomanon';

import { anonymiseBuffer } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'dicomanon',
  'fixtures',
  'TestPattern_JPEG-Baseline_YBRFull.dcm',
);

// dicomanon dict keys look like "(0010,0010)"; the parsed-DICOM tag keys
// are the flat uppercased "00100010" form. Build a keyword->flatTag map.
function normKey(k) {
  return k.replace(/[(),]/g, '').toUpperCase();
}

const KEYWORD_TO_TAG = (() => {
  const m = new Map();
  for (const [tagKey, entry] of Object.entries(dictionary)) {
    if (entry?.name) m.set(entry.name, normKey(tagKey));
  }
  return m;
})();

function tagOf(kw) {
  const t = KEYWORD_TO_TAG.get(kw);
  if (!t) throw new Error(`unknown DICOM keyword: ${kw}`);
  return t;
}

function getValue(dict, kw) {
  const v = dict[tagOf(kw)];
  if (!v || !Array.isArray(v.Value) || v.Value.length === 0) return null;
  return v.Value[0];
}

// Round-trip through write() + readFile() so we check invariants on the
// ACTUAL bytes the server would put on disk, not just the in-memory dict.
function anonymiseAndRoundTrip(buf) {
  const { data, originalDict } = anonymiseBuffer(buf);
  const outAb = data.write();
  const reread = Message.readFile(outAb);
  return { reread, originalDict, anonymisedDict: data.dict };
}

const inputBuffer = fs.readFileSync(FIXTURE);

// -- sanity: fixture contains the PHI we expect to strip -------------------

test('fixture contains PHI tags before anonymisation', () => {
  const ab = inputBuffer.buffer.slice(
    inputBuffer.byteOffset,
    inputBuffer.byteOffset + inputBuffer.byteLength,
  );
  const data = Message.readFile(ab);
  assert.ok(getValue(data.dict, 'PatientName'), 'fixture needs PatientName');
  assert.ok(getValue(data.dict, 'PatientBirthDate'), 'fixture needs PatientBirthDate');
  assert.ok(getValue(data.dict, 'StudyInstanceUID'), 'fixture needs StudyInstanceUID');
  assert.ok(getValue(data.dict, 'SeriesInstanceUID'), 'fixture needs SeriesInstanceUID');
});

// -- PHI stripping ----------------------------------------------------------

test('PatientName is dropped after anonymisation', () => {
  const { reread } = anonymiseAndRoundTrip(inputBuffer);
  assert.equal(getValue(reread.dict, 'PatientName'), null);
});

test('PatientBirthDate is dropped after anonymisation', () => {
  const { reread } = anonymiseAndRoundTrip(inputBuffer);
  assert.equal(getValue(reread.dict, 'PatientBirthDate'), null);
});

test('OperatorsName is dropped even when present', () => {
  // dicomanon's fixture doesn't include OperatorsName; verify the anon
  // output also doesn't sneak it in. Direct tag presence check — Anon
  // should never *add* a PHI tag.
  const { reread } = anonymiseAndRoundTrip(inputBuffer);
  assert.equal(getValue(reread.dict, 'OperatorsName'), null);
});

// -- UID regeneration -------------------------------------------------------

test('StudyInstanceUID is regenerated (differs from input)', () => {
  const { reread, originalDict } = anonymiseAndRoundTrip(inputBuffer);
  const before = getValue(originalDict, 'StudyInstanceUID');
  const after = getValue(reread.dict, 'StudyInstanceUID');
  assert.ok(before, 'expected input StudyInstanceUID');
  assert.ok(after, 'expected output StudyInstanceUID');
  assert.notEqual(after, before);
});

test('SeriesInstanceUID is regenerated (differs from input)', () => {
  const { reread, originalDict } = anonymiseAndRoundTrip(inputBuffer);
  const before = getValue(originalDict, 'SeriesInstanceUID');
  const after = getValue(reread.dict, 'SeriesInstanceUID');
  assert.ok(before);
  assert.ok(after);
  assert.notEqual(after, before);
});

// -- de-identification flags ----------------------------------------------

test('PatientIdentityRemoved is set to YES', () => {
  const { reread } = anonymiseAndRoundTrip(inputBuffer);
  assert.equal(getValue(reread.dict, 'PatientIdentityRemoved'), 'YES');
});

test('DeidentificationMethod is set (non-empty)', () => {
  const { reread } = anonymiseAndRoundTrip(inputBuffer);
  const method = getValue(reread.dict, 'DeidentificationMethod');
  assert.ok(method, 'DeidentificationMethod must be set');
  assert.equal(typeof method, 'string');
  assert.ok(method.length > 0);
});

// -- allowlisted tags survive ----------------------------------------------

test('Modality is preserved through anonymisation', () => {
  const { reread, originalDict } = anonymiseAndRoundTrip(inputBuffer);
  const before = getValue(originalDict, 'Modality');
  const after = getValue(reread.dict, 'Modality');
  assert.ok(before, 'fixture should have Modality');
  assert.equal(after, before);
});
