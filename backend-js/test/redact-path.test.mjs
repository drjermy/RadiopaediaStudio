// Regression test for GitHub issue #7: absolute paths (and PHI-shaped
// ancestor folders like `PATIENT_SMITH_JOHN_2026`) must not leak into
// streaming error events or error-message logs emitted by the Node
// sidecar. Mirrors the invariant asserted by
// backend/tests/test_log_redaction.py on the Python side.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactPath, redactErrorMessage } from '../server.mjs';

// -- unit: redactPath() ---------------------------------------------------

test('redactPath keeps parent-folder + file basename', () => {
  assert.equal(
    redactPath('/Volumes/phi/PATIENT_SMITH_JOHN_2026/series-3/I1001000'),
    'series-3/I1001000',
  );
});

test('redactPath handles a bare filename', () => {
  assert.equal(redactPath('I1001000'), 'I1001000');
});

test('redactPath handles nullish and empty inputs', () => {
  assert.equal(redactPath(null), '');
  assert.equal(redactPath(undefined), '');
  assert.equal(redactPath(''), '');
});

test('redactPath strips ancestor directories', () => {
  const out = redactPath('/Users/drsmith/Downloads/PATIENT_SMITH_JOHN/I1001000');
  assert.ok(!out.includes('/Users/'), `leak: ${out}`);
  assert.ok(!out.includes('drsmith'), `leak: ${out}`);
  assert.equal(out, 'PATIENT_SMITH_JOHN/I1001000');
});

test('redactPath strips a Windows drive anchor', () => {
  const out = redactPath('C:\\phi\\PATIENT_SMITH_JOHN\\I1001000');
  assert.ok(!out.includes('C:'), `leak: ${out}`);
  assert.ok(!out.includes('phi'), `leak: ${out}`);
  assert.equal(out, 'PATIENT_SMITH_JOHN/I1001000');
});

// -- unit: redactErrorMessage() -------------------------------------------

test('redactErrorMessage redacts quoted POSIX paths inside error text', () => {
  const msg = "ENOENT: no such file or directory, open '/Volumes/phi/PATIENT_SMITH_JOHN_2026/series-3/I1001000'";
  const out = redactErrorMessage(msg);
  assert.ok(!out.includes('/Volumes/'), `leak: ${out}`);
  assert.ok(!out.includes('PATIENT_SMITH_JOHN_2026'), `leak: ${out}`);
  assert.ok(out.includes('series-3/I1001000'), `lost filename: ${out}`);
  assert.ok(out.startsWith('ENOENT:'), `lost error name: ${out}`);
});

test('redactErrorMessage passes through messages without paths', () => {
  assert.equal(redactErrorMessage('invalid argument'), 'invalid argument');
});

test('redactErrorMessage handles nullish input', () => {
  assert.equal(redactErrorMessage(null), '');
  assert.equal(redactErrorMessage(undefined), '');
});
