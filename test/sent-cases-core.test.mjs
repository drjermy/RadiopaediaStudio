// Unit tests for src/shared/sent-cases-core.ts.
//
// Covers the pure storage-format helpers used by the renderer to
// persist Sent-cases (#25) — version filtering on read, cap on write,
// dedupe-by-case on add, per-job status merging.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../dist/shared/sent-cases-core.js');
const {
  parseSentCases,
  capSentCases,
  addOrReplaceSentCase,
  buildSentCase,
  mergeJobStatuses,
  removeSentCase,
} = mod;

const VERSION = 1;

const sampleJob = (over = {}) => ({
  studyIdx: 0,
  seriesIdx: 0,
  studyId: 100,
  jobId: 'job-1',
  ...over,
});

const sampleCase = (over = {}) => ({
  v: VERSION,
  caseId: 42,
  apiBase: 'https://example.test',
  title: 'sample',
  uploadedAt: '2025-01-01T00:00:00.000Z',
  jobs: [{ ...sampleJob(), lastKnownStatus: null, lastCheckedAt: null }],
  ...over,
});

// --- parseSentCases ---

test('parseSentCases: null input returns []', () => {
  assert.deepEqual(parseSentCases(null, VERSION), []);
});

test('parseSentCases: empty string returns []', () => {
  assert.deepEqual(parseSentCases('', VERSION), []);
});

test('parseSentCases: malformed JSON returns []', () => {
  assert.deepEqual(parseSentCases('{not json', VERSION), []);
});

test('parseSentCases: non-array JSON returns []', () => {
  // Defends against someone hand-editing localStorage to {"foo": 1}.
  assert.deepEqual(parseSentCases('{"caseId":1}', VERSION), []);
  assert.deepEqual(parseSentCases('null', VERSION), []);
  assert.deepEqual(parseSentCases('"a string"', VERSION), []);
});

test('parseSentCases: filters out entries with mismatched schema version', () => {
  const raw = JSON.stringify([
    sampleCase({ caseId: 1 }),
    sampleCase({ caseId: 2, v: 0 }),         // older schema
    sampleCase({ caseId: 3, v: 2 }),         // newer schema (forward-compat: still drop)
    sampleCase({ caseId: 4 }),
  ]);
  const out = parseSentCases(raw, VERSION);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.caseId), [1, 4]);
});

test('parseSentCases: drops entries missing the version field', () => {
  // A row written by an older app version that didn't have `v` at all.
  // Quiet drop is safer than a crash.
  const raw = JSON.stringify([sampleCase({ caseId: 1 }), { caseId: 2, title: 'orphan' }]);
  const out = parseSentCases(raw, VERSION);
  assert.equal(out.length, 1);
  assert.equal(out[0].caseId, 1);
});

// --- capSentCases ---

test('capSentCases: leaves a short list unchanged', () => {
  const cases = [sampleCase({ caseId: 1 }), sampleCase({ caseId: 2 })];
  assert.deepEqual(capSentCases(cases, 50), cases);
});

test('capSentCases: keeps the head when over the cap (newest first)', () => {
  // The renderer prepends the newest entry, so slice(0, max) preserves
  // the most recent N and drops the oldest.
  const cases = Array.from({ length: 5 }, (_, i) => sampleCase({ caseId: i + 1 }));
  const out = capSentCases(cases, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((c) => c.caseId), [1, 2, 3]);
});

test('capSentCases: cap of 0 returns empty', () => {
  assert.deepEqual(capSentCases([sampleCase()], 0), []);
});

// --- addOrReplaceSentCase ---

test('addOrReplaceSentCase: prepends a new entry', () => {
  const existing = [sampleCase({ caseId: 1 })];
  const out = addOrReplaceSentCase(existing, sampleCase({ caseId: 2 }));
  assert.deepEqual(out.map((c) => c.caseId), [2, 1]);
});

test('addOrReplaceSentCase: replaces an existing entry by caseId+apiBase', () => {
  const existing = [
    sampleCase({ caseId: 1, title: 'old' }),
    sampleCase({ caseId: 2, title: 'other' }),
  ];
  const fresh = sampleCase({ caseId: 1, title: 'new' });
  const out = addOrReplaceSentCase(existing, fresh);
  // Newest representation wins, moves to the head.
  assert.equal(out.length, 2);
  assert.equal(out[0].caseId, 1);
  assert.equal(out[0].title, 'new');
  assert.equal(out[1].caseId, 2);
});

test('addOrReplaceSentCase: dedupes only on (caseId, apiBase) pair', () => {
  // The same caseId across different hosts (e.g. staging vs prod) is
  // legitimately different — must not collapse.
  const existing = [sampleCase({ caseId: 1, apiBase: 'https://staging.test' })];
  const fresh = sampleCase({ caseId: 1, apiBase: 'https://prod.test' });
  const out = addOrReplaceSentCase(existing, fresh);
  assert.equal(out.length, 2);
});

test('addOrReplaceSentCase: does not mutate the input list', () => {
  const existing = [sampleCase({ caseId: 1 })];
  const before = JSON.stringify(existing);
  addOrReplaceSentCase(existing, sampleCase({ caseId: 1, title: 'mutated?' }));
  assert.equal(JSON.stringify(existing), before);
});

// --- buildSentCase ---

test('buildSentCase: maps jobs to the persisted shape and nulls status fields', () => {
  const out = buildSentCase(VERSION, 7, 'https://h', 'title', [sampleJob({ jobId: 'a' })], '2025-01-02T00:00:00Z');
  assert.equal(out.v, VERSION);
  assert.equal(out.caseId, 7);
  assert.equal(out.apiBase, 'https://h');
  assert.equal(out.title, 'title');
  assert.equal(out.uploadedAt, '2025-01-02T00:00:00Z');
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0].jobId, 'a');
  // Until first refresh, both status fields are null so the panel
  // shows "Status not checked yet".
  assert.equal(out.jobs[0].lastKnownStatus, null);
  assert.equal(out.jobs[0].lastCheckedAt, null);
});

// --- mergeJobStatuses ---

test('mergeJobStatuses: updates matching jobs and stamps lastCheckedAt', () => {
  const cases = [sampleCase({
    jobs: [
      { ...sampleJob({ jobId: 'a' }), lastKnownStatus: null, lastCheckedAt: null },
      { ...sampleJob({ jobId: 'b' }), lastKnownStatus: null, lastCheckedAt: null },
    ],
  })];
  const out = mergeJobStatuses(cases, 42, 'https://example.test', [
    { jobId: 'a', status: 'ready' },
    { jobId: 'b', status: 'pending-dicom-processing' },
  ], '2025-02-02T00:00:00Z');
  assert.equal(out[0].jobs[0].lastKnownStatus, 'ready');
  assert.equal(out[0].jobs[0].lastCheckedAt, '2025-02-02T00:00:00Z');
  assert.equal(out[0].jobs[1].lastKnownStatus, 'pending-dicom-processing');
  assert.equal(out[0].jobs[1].lastCheckedAt, '2025-02-02T00:00:00Z');
});

test('mergeJobStatuses: leaves jobs not present in updates untouched', () => {
  const cases = [sampleCase({
    jobs: [
      { ...sampleJob({ jobId: 'a' }), lastKnownStatus: 'ready', lastCheckedAt: 't0' },
      { ...sampleJob({ jobId: 'b' }), lastKnownStatus: null, lastCheckedAt: null },
    ],
  })];
  const out = mergeJobStatuses(cases, 42, 'https://example.test', [
    { jobId: 'b', status: 'failed' },
  ], 't1');
  assert.equal(out[0].jobs[0].lastKnownStatus, 'ready');
  assert.equal(out[0].jobs[0].lastCheckedAt, 't0');
  assert.equal(out[0].jobs[1].lastKnownStatus, 'failed');
  assert.equal(out[0].jobs[1].lastCheckedAt, 't1');
});

test('mergeJobStatuses: returns input unchanged if case is not present', () => {
  const cases = [sampleCase({ caseId: 1 })];
  const out = mergeJobStatuses(cases, 999, 'https://nope', [{ jobId: 'a', status: 'ready' }], 't');
  assert.equal(out, cases); // same reference, no copy
});

test('mergeJobStatuses: does not mutate the input', () => {
  const cases = [sampleCase({
    jobs: [{ ...sampleJob({ jobId: 'a' }), lastKnownStatus: null, lastCheckedAt: null }],
  })];
  const before = JSON.stringify(cases);
  mergeJobStatuses(cases, 42, 'https://example.test', [{ jobId: 'a', status: 'ready' }], 't');
  assert.equal(JSON.stringify(cases), before);
});

// --- removeSentCase ---

test('removeSentCase: drops the matching entry, preserves order of the rest', () => {
  const cases = [
    sampleCase({ caseId: 1 }),
    sampleCase({ caseId: 2 }),
    sampleCase({ caseId: 3 }),
  ];
  const out = removeSentCase(cases, 2, 'https://example.test');
  assert.deepEqual(out.map((c) => c.caseId), [1, 3]);
});

test('removeSentCase: returns equivalent list when no match', () => {
  const cases = [sampleCase({ caseId: 1 })];
  const out = removeSentCase(cases, 999, 'https://example.test');
  assert.deepEqual(out, cases);
});

test('removeSentCase: matches on the (caseId, apiBase) pair', () => {
  const cases = [
    sampleCase({ caseId: 1, apiBase: 'https://staging.test' }),
    sampleCase({ caseId: 1, apiBase: 'https://prod.test' }),
  ];
  const out = removeSentCase(cases, 1, 'https://prod.test');
  assert.equal(out.length, 1);
  assert.equal(out[0].apiBase, 'https://staging.test');
});
