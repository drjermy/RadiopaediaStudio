// Unit tests for src/main/upload-images-core.ts.
//
// The core module is Electron-free + fs-free, so Node's test runner
// can drive it directly. Tests inject a stubbed fetch + auth so we
// don't hit radiopaedia.org and don't need a running sidecar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../dist/main/upload-images-core.js');
const { checkUploadStatusCore, fetchJobStatusCore, buildJobStatusUrl, HttpError } = mod;

// --- fixtures ---

const sampleJob = (over = {}) => ({
  studyIdx: 0,
  seriesIdx: 0,
  caseId: 1234,
  studyId: 5678,
  jobId: 'job-abc',
  ...over,
});

const okJson = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const status = (code, text = '') => new Response(text, { status: code });

// fetch stub helper: route by URL substring → response factory.
function fetchStub(routes) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    for (const [match, factory] of routes) {
      if (url.includes(match)) return factory();
    }
    throw new Error(`fetchStub: no route matched ${url}`);
  };
}

const authedDeps = (overrides = {}) => ({
  fetch: fetchStub([['/image_preparation/', () => okJson({ series: { seriesId: 1, status: 'ready' } })]]),
  getValidAccessToken: async () => 'mock-access',
  apiBase: 'https://example.test',
  ...overrides,
});

const noController = () => new AbortController().signal;

// --- buildJobStatusUrl ---

test('buildJobStatusUrl: includes case_id and url-encodes the job id', () => {
  // case_id is required despite looking redundant — the Rails
  // before_action find_case 401s otherwise. encodeURIComponent on the
  // job id defends against weird characters in upload identifiers.
  const url = buildJobStatusUrl('https://example.test', sampleJob({ jobId: 'a/b c' }));
  assert.equal(url, 'https://example.test/image_preparation/1234/studies/5678/upload/a%2Fb%20c');
});

// --- fetchJobStatusCore: status-code branches ---

test('fetchJobStatusCore: 202 → pending-upload', async () => {
  const f = fetchStub([['/image_preparation/', () => status(202)]]);
  const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
  assert.equal(out, 'pending-upload');
});

test('fetchJobStatusCore: 200 series.status="ready" → ready', async () => {
  const f = fetchStub([['/image_preparation/', () => okJson({ series: { seriesId: 1, status: 'ready' } })]]);
  const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
  assert.equal(out, 'ready');
});

test('fetchJobStatusCore: 200 series.status="completed-dicom-processing" → completed-dicom-processing', async () => {
  const f = fetchStub([['/image_preparation/', () => okJson({ series: { seriesId: 1, status: 'completed-dicom-processing' } })]]);
  const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
  assert.equal(out, 'completed-dicom-processing');
});

test('fetchJobStatusCore: 200 with unknown series.status → pending-dicom-processing (default)', async () => {
  // Covers pending-trim, pending-crop, and any future status the API
  // might add — stays "still processing" rather than misreporting.
  for (const s of ['pending-dicom-processing', 'pending-trim', 'pending-crop', 'something-new']) {
    const f = fetchStub([['/image_preparation/', () => okJson({ series: { seriesId: 1, status: s } })]]);
    const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
    assert.equal(out, 'pending-dicom-processing', `status=${s}`);
  }
});

test('fetchJobStatusCore: 200 with no series root → failed', async () => {
  // Background job ran but no series got created — upload failure.
  const f = fetchStub([['/image_preparation/', () => okJson({ study: { studyId: 5678 } })]]);
  const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
  assert.equal(out, 'failed');
});

test('fetchJobStatusCore: 200 with series but no seriesId → failed', async () => {
  const f = fetchStub([['/image_preparation/', () => okJson({ series: { status: 'ready' } })]]);
  const out = await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController());
  assert.equal(out, 'failed');
});

test('fetchJobStatusCore: 4xx throws HttpError with status preserved', async () => {
  const f = fetchStub([['/image_preparation/', () => status(401, 'unauthorized')]]);
  await assert.rejects(
    fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController()),
    (err) => err instanceof HttpError && err.status === 401 && err.body === 'unauthorized',
  );
});

test('fetchJobStatusCore: 5xx throws HttpError', async () => {
  const f = fetchStub([['/image_preparation/', () => status(503)]]);
  await assert.rejects(
    fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', noController()),
    (err) => err instanceof HttpError && err.status === 503,
  );
});

test('fetchJobStatusCore: forwards the AbortSignal to fetch', async () => {
  // Concretely guards "panel close cancels in-flight check": main
  // passes a signal down, fetch must see it. If a refactor drops the
  // signal: option, the abort path silently breaks.
  let receivedSignal;
  const f = async (_url, init) => { receivedSignal = init?.signal; return status(202); };
  const ac = new AbortController();
  await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 't', ac.signal);
  assert.equal(receivedSignal, ac.signal);
});

test('fetchJobStatusCore: sends Bearer authorization header', async () => {
  let receivedAuth;
  const f = async (_url, init) => {
    receivedAuth = init?.headers?.['Authorization'] ?? init?.headers?.Authorization;
    return status(202);
  };
  await fetchJobStatusCore(f, 'https://example.test', sampleJob(), 'mytoken', noController());
  assert.equal(receivedAuth, 'Bearer mytoken');
});

// --- checkUploadStatusCore: orchestration ---

test('checkUploadStatusCore: empty jobs list returns []', async () => {
  const out = await checkUploadStatusCore([], noController(), authedDeps());
  assert.deepEqual(out, []);
});

test('checkUploadStatusCore: throws when no token available', async () => {
  await assert.rejects(
    checkUploadStatusCore([sampleJob()], noController(), authedDeps({
      getValidAccessToken: async () => null,
    })),
    /No valid access token/,
  );
});

test('checkUploadStatusCore: returns one entry per input job, in order', async () => {
  const f = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('job-A')) return okJson({ series: { seriesId: 1, status: 'ready' } });
    if (url.includes('job-B')) return okJson({ series: { seriesId: 2, status: 'pending-trim' } });
    if (url.includes('job-C')) return status(202);
    throw new Error(`unexpected ${url}`);
  };
  const out = await checkUploadStatusCore(
    [sampleJob({ jobId: 'job-A' }), sampleJob({ jobId: 'job-B' }), sampleJob({ jobId: 'job-C' })],
    noController(),
    authedDeps({ fetch: f }),
  );
  assert.deepEqual(out, [
    { jobId: 'job-A', status: 'ready' },
    { jobId: 'job-B', status: 'pending-dicom-processing' },
    { jobId: 'job-C', status: 'pending-upload' },
  ]);
});

test('checkUploadStatusCore: per-job error is recorded as pending-upload, batch continues', async () => {
  // A transient 502 on one job should NOT cause the UI to lose state
  // for everything else. Marking as pending-upload is the safest
  // default — the user can re-check.
  const f = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('job-A')) return okJson({ series: { seriesId: 1, status: 'ready' } });
    if (url.includes('job-B')) return status(502);
    if (url.includes('job-C')) return okJson({ series: { seriesId: 3, status: 'ready' } });
    throw new Error(`unexpected ${url}`);
  };
  const out = await checkUploadStatusCore(
    [sampleJob({ jobId: 'job-A' }), sampleJob({ jobId: 'job-B' }), sampleJob({ jobId: 'job-C' })],
    noController(),
    authedDeps({ fetch: f }),
  );
  assert.deepEqual(out, [
    { jobId: 'job-A', status: 'ready' },
    { jobId: 'job-B', status: 'pending-upload' },
    { jobId: 'job-C', status: 'ready' },
  ]);
});

test('checkUploadStatusCore: pre-aborted signal returns []', async () => {
  const ac = new AbortController();
  ac.abort();
  const out = await checkUploadStatusCore([sampleJob()], ac.signal, authedDeps());
  // Token is fetched first (before the loop), so we still call deps.
  // What matters: no jobs got processed. Result is empty.
  assert.deepEqual(out, []);
});

test('checkUploadStatusCore: abort mid-batch stops further fetches', async () => {
  const ac = new AbortController();
  let calls = 0;
  const f = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls++;
    if (url.includes('job-A')) return okJson({ series: { seriesId: 1, status: 'ready' } });
    if (url.includes('job-B')) {
      ac.abort();
      // Even though we abort here, fetch can still resolve — the
      // outer loop checks the signal before the next iteration.
      return okJson({ series: { seriesId: 2, status: 'ready' } });
    }
    return okJson({ series: { seriesId: 3, status: 'ready' } });
  };
  const out = await checkUploadStatusCore(
    [sampleJob({ jobId: 'job-A' }), sampleJob({ jobId: 'job-B' }), sampleJob({ jobId: 'job-C' })],
    ac.signal,
    authedDeps({ fetch: f }),
  );
  // job-A and job-B both completed before abort took effect; job-C
  // never got fetched.
  assert.equal(calls, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].jobId, 'job-A');
  assert.equal(out[1].jobId, 'job-B');
});
