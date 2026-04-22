// iterAnonymise polls the isCancelled callback between files. Once the
// callback returns true, the generator returns early — partial output is
// left on disk, no summary is yielded. Matches the Python iter_scrub_folder
// semantics; see GitHub issue #5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { iterAnonymise } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'dicomanon',
  'fixtures',
  'TestPattern_JPEG-Baseline_YBRFull.dcm',
);


function makeFolderWithCopies(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-'));
  const src = fs.readFileSync(FIXTURE);
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(dir, `slice-${i}.dcm`), src);
  }
  return dir;
}


test('iterAnonymise stops when isCancelled returns true', async () => {
  const input = makeFolderWithCopies(5);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-out-'));

  const events = [];
  let cancelAt = 2;
  const isCancelled = () => events.filter((e) => e.type === 'file').length >= cancelAt;

  for await (const evt of iterAnonymise(input, output, isCancelled)) {
    events.push(evt);
  }

  const fileCount = events.filter((e) => e.type === 'file').length;
  assert.equal(fileCount, cancelAt, `expected ${cancelAt} files processed, got ${fileCount}`);
  // Cancelled runs don't emit summary or done.
  assert.ok(!events.some((e) => e.type === 'summary'), 'summary leaked after cancel');
  assert.ok(!events.some((e) => e.type === 'done'), 'done leaked after cancel');
});


test('iterAnonymise runs to completion without a cancel hook', async () => {
  const input = makeFolderWithCopies(3);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'nocancel-out-'));

  const events = [];
  for await (const evt of iterAnonymise(input, output)) {
    events.push(evt);
  }

  const fileCount = events.filter((e) => e.type === 'file').length;
  assert.equal(fileCount, 3);
  assert.ok(events.some((e) => e.type === 'summary'));
  assert.ok(events.some((e) => e.type === 'done'));
});
