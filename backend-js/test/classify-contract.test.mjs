// Cross-backend classification contract test — Node side.
//
// Reads backend-js/test/classify-fixtures.json and asserts that the Node
// classifier returns the expected output for every case. backend/tests/
// test_classify_contract.py reads the SAME fixture and runs the same
// assertions on the Python side. If one backend drifts, both tests flag
// it. See issue #2 and the comment at the top of classify.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyOrientationArr, classifyTransferSyntax } from '../classify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'classify-fixtures.json'), 'utf8'),
);

test('transfer syntax classification matches fixture', () => {
  for (const { uid, expected } of fixture.transfer_syntax) {
    const got = classifyTransferSyntax(uid);
    assert.deepStrictEqual(
      got,
      expected,
      `classifyTransferSyntax(${JSON.stringify(uid)}) mismatch`,
    );
  }
});

test('orientation classification matches fixture', () => {
  for (const { iop, expected } of fixture.orientation) {
    const got = classifyOrientationArr(iop);
    assert.strictEqual(
      got,
      expected,
      `classifyOrientationArr(${JSON.stringify(iop)}) mismatch: got ${got}, want ${expected}`,
    );
  }
});
