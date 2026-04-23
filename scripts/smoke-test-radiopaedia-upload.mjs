// End-to-end smoke test against Radiopaedia staging.
//
// Runs the full upload pipeline for ONE case / ONE study / ONE DICOM slice,
// using the `dicomanon` fixture. Intended to catch API-shape gotchas before
// the UI wiring lands. See GitHub issue #15 for the spec.
//
// Usage:
//
//   RADIOPAEDIA_API_BASE=https://env-develop.radiopaedia-dev.org \
//   RADIOPAEDIA_ACCESS_TOKEN=<access_token> \
//   node scripts/smoke-test-radiopaedia-upload.mjs
//
// Optional, for automatic 401-retry using a refresh token:
//
//   RADIOPAEDIA_REFRESH_TOKEN=<refresh_token>
//   RADIOPAEDIA_CLIENT_ID=<oauth client id>
//   RADIOPAEDIA_CLIENT_SECRET=<oauth client secret>
//
// The script creates a REAL draft case on the configured host. The final
// summary line prints the case URL so you can open it in a browser and
// delete it manually.
//
// Endpoint sequence (from issue #15):
//   1. GET    /api/v1/users/current
//   2. POST   /api/v1/cases
//   3. POST   /api/v1/cases/:CASE_ID/studies
//   4. POST   /direct_s3_uploads                         (sha256 → presigned URL)
//   5. PUT    <s3 presigned url>                         (raw DICOM bytes)
//   6. POST   /image_preparation/:CASE_ID/studies/:STUDY_ID/series
//   7. PUT    /api/v1/cases/:CASE_ID/mark_upload_finished
//
// API-shape gotchas handled here:
//   - `stack_upload.uploaded_data` is a Rails-style object with string-keyed
//     numeric indices: `{ "0": <upload_id> }`. Sending a JSON array silently
//     400s. See buildSeriesPayload below.
//   - `Authorization: Bearer` is attached to every API call EXCEPT the PUT
//     to the S3 presigned URL — S3 validates via the query-string signature
//     and an extra Authorization header can cause 400s. See `apiFetch` vs
//     `s3Put`.
//
// Payload-builder provenance:
//   The two builders below (`buildCaseCreatePayload` / `buildStudyCreatePayload`)
//   are duplicated inline from `src/shared/api.ts`. `scripts/` is a plain
//   Node ESM folder with no TS pipeline, and `src/shared/api.ts` emits only
//   types (its tsc `.js` sibling is gitignored — see .gitignore). Adding a
//   build step just for a smoke test isn't worth the cost.
//   TODO: import from src/shared/api.ts once the scripts folder has a ts pipeline.

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE = 'https://env-develop.radiopaedia-dev.org';

const apiBase = (process.env.RADIOPAEDIA_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, '');
let accessToken = process.env.RADIOPAEDIA_ACCESS_TOKEN ?? '';
const refreshToken = process.env.RADIOPAEDIA_REFRESH_TOKEN ?? '';
const clientId = process.env.RADIOPAEDIA_CLIENT_ID ?? '';
const clientSecret = process.env.RADIOPAEDIA_CLIENT_SECRET ?? '';

const TOKEN_CACHE_FILE = join(repoRoot, '.radiopaedia-tokens.json');

// If a cached token file is present from a previous run's refresh, prefer it
// over the (probably stale) env var. The user sees a log line so it's not
// magic.
if (!accessToken && existsSync(TOKEN_CACHE_FILE)) {
  try {
    const cached = JSON.parse(await readFile(TOKEN_CACHE_FILE, 'utf8'));
    if (cached.access_token) {
      accessToken = cached.access_token;
      console.error(`[smoke] using cached access token from ${TOKEN_CACHE_FILE}`);
    }
  } catch (err) {
    console.error(`[smoke] ignoring unreadable ${TOKEN_CACHE_FILE}: ${err.message}`);
  }
}

if (!accessToken) {
  console.error(
    'Usage:\n' +
      '  RADIOPAEDIA_API_BASE=https://env-develop.radiopaedia-dev.org \\\n' +
      '  RADIOPAEDIA_ACCESS_TOKEN=<access_token> \\\n' +
      '  node scripts/smoke-test-radiopaedia-upload.mjs\n' +
      '\n' +
      'Optional for automatic 401-retry:\n' +
      '  RADIOPAEDIA_REFRESH_TOKEN, RADIOPAEDIA_CLIENT_ID, RADIOPAEDIA_CLIENT_SECRET\n' +
      '\n' +
      'Grab a fresh access token by running the desktop app and completing\n' +
      'the OAuth flow in Settings, then copy it from the local safeStorage\n' +
      "keychain entry (or wire the dev-console copy button once it's built).\n",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging helpers — NEVER print the bearer, refresh token, or client_secret.
// Short prefixes (~3 chars) are OK for diagnosing the "wrong token" class of
// bug; see the engineering notes at the top of this file.
// ---------------------------------------------------------------------------

function tokenHead(t) {
  return t ? `${t.slice(0, 3)}...` : '(none)';
}

function logRequest(method, url) {
  console.log(`→ ${method} ${url}`);
}
function logResponse(status, summary) {
  console.log(`← ${status} ${summary}`);
}

async function dumpBody(res) {
  try {
    const text = await res.text();
    console.error('  response body:\n' + text);
  } catch (err) {
    console.error(`  (could not read response body: ${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Payload builders (duplicated from src/shared/api.ts — see provenance note
// at the top of this file).
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPE_MAP[c] ?? c);
}
function textToHtml(plain) {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('');
}
function setIf(dst, key, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.length === 0) return;
  dst[key] = value;
}

function buildCaseCreatePayload(c) {
  const out = {};
  setIf(out, 'title', c.title?.trim());
  if (c.system_id != null) out.system_id = c.system_id;
  setIf(out, 'age', c.age?.trim() ?? '');
  if (c.patient_sex === 'M') out.gender = 'Male';
  else if (c.patient_sex === 'F') out.gender = 'Female';
  setIf(out, 'presentation', (c.clinical_history ?? '').trim());
  const bodyHtml = textToHtml(c.case_discussion ?? '');
  setIf(out, 'body', bodyHtml);
  if (c.diagnostic_certainty_id != null) out.diagnostic_certainty_id = c.diagnostic_certainty_id;
  if (c.suitable_for_quiz !== undefined) out.suitable_for_quiz = !!c.suitable_for_quiz;
  return out;
}

function buildStudyCreatePayload(s, position) {
  const out = { modality: s.modality, position };
  setIf(out, 'findings', textToHtml(s.findings ?? ''));
  setIf(out, 'caption', s.caption?.trim() ?? '');
  return out;
}

/**
 * The series body for POST /image_preparation/:CASE_ID/studies/:STUDY_ID/series.
 *
 * IMPORTANT: `stack_upload.uploaded_data` MUST be an object with string-keyed
 * numeric indices, NOT a JSON array. `{"0": <id>, "1": <id>}` is correct;
 * `[<id>, <id>]` silently 400s. This is how Rails serialises
 * `params[:stack_upload][:uploaded_data][]` and the API round-trips the same
 * shape.
 */
function buildSeriesPayload(uploadIds) {
  const uploaded_data = {};
  uploadIds.forEach((id, i) => {
    uploaded_data[String(i)] = id;
  });
  return {
    image_format: 'application/dicom',
    series: { root_index: 0 },
    stack_upload: { uploaded_data },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiFetch(path, init = {}) {
  const url = path.startsWith('http') ? path : `${apiBase}${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  logRequest(method, url);
  const res = await fetch(url, { ...init, headers });
  logResponse(res.status, res.statusText);
  return res;
}

/**
 * PUT the DICOM bytes to the S3 presigned URL. MUST NOT include
 * Authorization — see top-of-file engineering notes.
 */
async function s3Put(url, bytes) {
  logRequest('PUT', url.split('?')[0] + '?<signature redacted>');
  const res = await fetch(url, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'application/dicom' },
  });
  logResponse(res.status, res.statusText);
  return res;
}

async function refreshAccessToken() {
  if (!refreshToken || !clientId || !clientSecret) {
    return false;
  }
  const url = `${apiBase}/oauth/token`;
  logRequest('POST', url + ' (grant_type=refresh_token)');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  logResponse(res.status, res.statusText);
  if (!res.ok) {
    await dumpBody(res);
    return false;
  }
  const json = await res.json();
  if (!json.access_token) return false;
  accessToken = json.access_token;
  try {
    await mkdir(dirname(TOKEN_CACHE_FILE), { recursive: true });
    await writeFile(
      TOKEN_CACHE_FILE,
      JSON.stringify(
        {
          access_token: json.access_token,
          refresh_token: json.refresh_token ?? refreshToken,
          token_type: json.token_type,
          expires_in: json.expires_in,
          refreshed_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.error(`[smoke] refreshed access token; cached in ${TOKEN_CACHE_FILE}`);
  } catch (err) {
    console.error(`[smoke] refreshed access token but failed to cache it: ${err.message}`);
  }
  return true;
}

/**
 * Call `fn()`. On 401, try a refresh-token exchange once and retry. On any
 * other non-2xx, dump the body and abort.
 */
async function callWithRefresh(fn, { step }) {
  let res = await fn();
  if (res.status === 401) {
    console.error(`[smoke] ${step}: 401 — attempting refresh-token exchange`);
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      await dumpBody(res);
      console.error(
        '[smoke] token expired; re-run with a fresh RADIOPAEDIA_ACCESS_TOKEN ' +
          '(or set RADIOPAEDIA_REFRESH_TOKEN / _CLIENT_ID / _CLIENT_SECRET for auto-refresh).',
      );
      process.exit(1);
    }
    res = await fn();
  }
  if (!res.ok) {
    await dumpBody(res);
    throw new Error(`${step} failed: HTTP ${res.status}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`[smoke] api_base=${apiBase}`);
  console.log(`[smoke] bearer token (head): ${tokenHead(accessToken)}`);
  if (refreshToken) {
    console.log(
      `[smoke] refresh token configured (head): ${tokenHead(refreshToken)} ` +
        `(auto-retry on 401 is enabled)`,
    );
  } else {
    console.log('[smoke] no refresh token configured — 401 will abort');
  }

  // 1. GET /api/v1/users/current
  const currentRes = await callWithRefresh(() => apiFetch('/api/v1/users/current'), {
    step: 'GET /api/v1/users/current',
  });
  const current = await currentRes.json();
  const login = current.login ?? current.user?.login ?? '(unknown)';
  const draftCount = current.quotas?.draft_case_count;
  const draftAllowed = current.quotas?.allowed_draft_cases;
  console.log(
    `[smoke] login=${login} draft_case_count=${draftCount ?? '?'} ` +
      `allowed_draft_cases=${draftAllowed ?? '?'}`,
  );
  if (
    typeof draftCount === 'number' &&
    typeof draftAllowed === 'number' &&
    draftCount >= draftAllowed
  ) {
    console.error(
      `[smoke] over draft-case quota (${draftCount}/${draftAllowed}); clear drafts before running`,
    );
    process.exit(1);
  }

  // 2. POST /api/v1/cases
  const caseInput = {
    title: `Radiopaedia Studio smoke test ${new Date().toISOString()}`,
    system_id: 4, // Chest
    age: '40 years',
    patient_sex: 'M',
    diagnostic_certainty_id: 5, // Not applicable
    suitable_for_quiz: false,
    clinical_history: 'Routine chest imaging',
    case_discussion: 'Automated upload smoke test — safe to delete.',
  };
  const casePayload = buildCaseCreatePayload(caseInput);
  const caseRes = await callWithRefresh(
    () =>
      apiFetch('/api/v1/cases', {
        method: 'POST',
        body: JSON.stringify(casePayload),
      }),
    { step: 'POST /api/v1/cases' },
  );
  const caseJson = await caseRes.json();
  const caseId = caseJson.id ?? caseJson.case?.id;
  if (!caseId) {
    console.error('[smoke] POST /api/v1/cases response had no `id`:');
    console.error(JSON.stringify(caseJson, null, 2));
    process.exit(1);
  }
  console.log(`[smoke] CASE_ID=${caseId}`);

  // 3. POST /api/v1/cases/:CASE_ID/studies
  const studyPayload = buildStudyCreatePayload(
    { modality: 'CT', caption: 'smoke-test series' },
    2, // position — first study is 2 (1 is the case-discussion slot)
  );
  const studyRes = await callWithRefresh(
    () =>
      apiFetch(`/api/v1/cases/${caseId}/studies`, {
        method: 'POST',
        body: JSON.stringify(studyPayload),
      }),
    { step: `POST /api/v1/cases/${caseId}/studies` },
  );
  const studyJson = await studyRes.json();
  const studyId = studyJson.id ?? studyJson.study?.id;
  if (!studyId) {
    console.error('[smoke] POST .../studies response had no `id`:');
    console.error(JSON.stringify(studyJson, null, 2));
    process.exit(1);
  }
  console.log(`[smoke] STUDY_ID=${studyId}`);

  // 4. Prepare the DICOM fixture.
  const fixturePath = join(
    repoRoot,
    'backend-js',
    'node_modules',
    'dicomanon',
    'fixtures',
    'TestPattern_JPEG-Baseline_YBRFull.dcm',
  );
  if (!existsSync(fixturePath)) {
    console.error(
      `[smoke] DICOM fixture not found at:\n  ${fixturePath}\n` +
        "Run `cd backend-js && npm install` to pull the `dicomanon` dep (it ships " +
        'the TestPattern fixture).',
    );
    process.exit(1);
  }
  const bytes = await readFile(fixturePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  console.log(`[smoke] fixture=${fixturePath}`);
  console.log(`[smoke] fixture sha256=${sha256} size=${bytes.byteLength}`);

  // 5. POST /direct_s3_uploads — claim a presigned URL.
  const s3ReqRes = await callWithRefresh(
    () =>
      apiFetch('/direct_s3_uploads', {
        method: 'POST',
        body: JSON.stringify({ sha256: [sha256] }),
      }),
    { step: 'POST /direct_s3_uploads' },
  );
  const s3Req = await s3ReqRes.json();
  const uploads = s3Req.uploads ?? s3Req;
  const upload = Array.isArray(uploads) ? uploads[0] : uploads?.[0];
  const uploadId = upload?.id;
  const uploadUrl = upload?.url;
  if (!uploadId || !uploadUrl) {
    console.error('[smoke] /direct_s3_uploads response had no [0].id / [0].url:');
    console.error(JSON.stringify(s3Req, null, 2));
    process.exit(1);
  }
  console.log(`[smoke] upload_id=${uploadId}`);

  // 6. PUT <presigned url> — NO Authorization header here.
  const s3Res = await s3Put(uploadUrl, bytes);
  if (!s3Res.ok) {
    await dumpBody(s3Res);
    console.error('[smoke] S3 PUT failed — aborting');
    process.exit(1);
  }

  // 7. POST /image_preparation/:CASE_ID/studies/:STUDY_ID/series.
  //    uploaded_data is a Rails-style object (see buildSeriesPayload).
  const seriesPayload = buildSeriesPayload([uploadId]);
  const seriesRes = await callWithRefresh(
    () =>
      apiFetch(`/image_preparation/${caseId}/studies/${studyId}/series`, {
        method: 'POST',
        body: JSON.stringify(seriesPayload),
      }),
    {
      step: `POST /image_preparation/${caseId}/studies/${studyId}/series`,
    },
  );
  const seriesJson = await seriesRes.json().catch(() => null);
  console.log(`[smoke] series response: ${JSON.stringify(seriesJson)}`);

  // 8. PUT /api/v1/cases/:CASE_ID/mark_upload_finished.
  const finishRes = await callWithRefresh(
    () => apiFetch(`/api/v1/cases/${caseId}/mark_upload_finished`, { method: 'PUT' }),
    { step: `PUT /api/v1/cases/${caseId}/mark_upload_finished` },
  );
  const finishJson = await finishRes.json().catch(() => null);
  console.log(`[smoke] finish response: ${JSON.stringify(finishJson)}`);

  // 9. Summary.
  const webHost = apiBase;
  console.log('');
  console.log('[smoke] SUCCESS');
  console.log(`[smoke] CASE_ID=${caseId}`);
  console.log(`[smoke] view at: ${webHost}/cases/${caseId}`);
  console.log('[smoke] remember to delete the draft case manually when you are done.');
}

main().catch((err) => {
  console.error(`[smoke] FAILED: ${err.stack ?? err.message}`);
  process.exit(1);
});
