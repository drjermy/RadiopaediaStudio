// Image-upload orchestrator. Runs in the main process so it can stream
// large DICOM files off disk, hash them, PUT them to S3, and feed
// /image_preparation — none of which is comfortable in the renderer.
//
// Mirrors the smoke-test pipeline (scripts/smoke-test-radiopaedia-upload.mjs):
//   - per series: hash each .dcm file, POST /direct_s3_uploads with the
//     sha256 list, PUT non-cached files to their presigned URLs, POST
//     /image_preparation/:case_id/studies/:study_id/series.
//   - then PUT /api/v1/cases/:case_id/mark_upload_finished.
//
// Progress is emitted to the caller via an `emit` callback so the renderer
// can stream events into its modal. Abortable via an AbortSignal.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getValidAccessToken } from './radiopaedia-auth';
import { RADIOPAEDIA_API_BASE } from './radiopaedia-config';

export interface SeriesUploadSpec {
  /** Folder of anonymised DICOMs for this series. */
  folder: string;
  /** Radiopaedia Series fields sent in the image_preparation create body. */
  perspective?: string;
  specifics?: string;
}

export interface ImageUploadSpec {
  caseId: number;
  /**
   * One entry per Radiopaedia Study. The order matches collectStudies() on
   * the renderer side, so studyIdx values in events line up with the
   * existing step list.
   */
  studies: Array<{
    studyId: number;
    series: SeriesUploadSpec[];
  }>;
}

export type UploadPhase = 'stage' | 'hash' | 'presign' | 'upload' | 'prepare';

/**
 * Per-series processing status returned by Radiopaedia's
 * `/image_preparation/.../upload/:upload_id` polling endpoint.
 *
 * `pending-upload` → /image_preparation accepted the request; the
 * background job hasn't finished creating the Series record yet.
 * `pending-dicom-processing` → series exists, DICOM-to-PNG conversion
 * still running.
 * `completed-dicom-processing` → conversion done, no trim/crop pending.
 * `ready` → fully ready to display.
 * `failed` → terminal — the job finished without creating a series. We
 * synthesise this client-side; the API doesn't have a literal "failed"
 * string and (per the handoff doc, item #8) doesn't surface the reason.
 */
export type ProcessingStatus =
  | 'pending-upload'
  | 'pending-dicom-processing'
  | 'completed-dicom-processing'
  | 'ready'
  | 'failed';

export type UploadEvent =
  | { type: 'budget'; totalBytes: number; totalFiles: number }
  | { type: 'bytes-progress'; doneBytes: number; totalBytes: number }
  | { type: 'series-start'; studyIdx: number; seriesIdx: number; folder: string; sliceCount: number }
  | { type: 'series-progress'; studyIdx: number; seriesIdx: number; phase: UploadPhase; done: number; total: number }
  | { type: 'series-done'; studyIdx: number; seriesIdx: number }
  | { type: 'series-error'; studyIdx: number; seriesIdx: number; message: string }
  | { type: 'finalize-start' }
  | { type: 'finalize-done' }
  | { type: 'finalize-error'; message: string }
  // Polling phase after mark_upload_finished — Radiopaedia processes the
  // uploaded DICOMs asynchronously, so we follow up with status checks.
  | { type: 'verify-start'; totalSeries: number }
  | { type: 'verify-progress'; studyIdx: number; seriesIdx: number; status: ProcessingStatus }
  | { type: 'verify-done'; readyCount: number; failedCount: number; pendingCount: number }
  | { type: 'all-done'; caseId: number }
  | { type: 'aborted' };

export type EmitFn = (e: UploadEvent) => void;

interface PresignEntry {
  id: number;
  url?: string;
  status?: string; // 'already_uploaded' if S3 already has this hash
}

const S3_PUT_CONCURRENCY = 4;
// After PUT-ing to S3, wait briefly before /image_preparation. Lifted from
// the smoke test — Radiopaedia's prep handler may verify the S3 object
// exists before running its anonymiser check, and S3 propagation isn't
// strictly synchronous from the PUT 200.
const POST_PUT_SETTLE_MS = 2_000;

class HttpError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

interface DiscoveredSeries {
  files: Array<{ path: string; size: number }>;
  totalBytes: number;
}

export interface RunImageUploadOptions {
  /**
   * Port the Node sidecar is listening on. Required: every file destined
   * for Radiopaedia must be re-anonymised through dicomanon (Radiopaedia's
   * canonical anonymiser) before upload, even if it already came out of
   * the original /anonymize step — derived series produced by Python ops
   * like /reformat / /window / /transform don't carry the markers
   * Radiopaedia's validator requires (e.g. "Was not anonymized, Key
   * 00080018 not anonymized" 422s). Staging through dicomanon makes the
   * upload uniform regardless of how a series was produced.
   */
  nodeBackendPort: number;
}

export async function runImageUpload(
  spec: ImageUploadSpec,
  emit: EmitFn,
  signal: AbortSignal,
  options: RunImageUploadOptions,
): Promise<void> {
  if (signal.aborted) {
    emit({ type: 'aborted' });
    return;
  }
  let token = await getValidAccessToken();
  if (!token) {
    throw new Error('No valid access token. Sign in to Radiopaedia and try again.');
  }

  const apiBase = RADIOPAEDIA_API_BASE;

  // Stage every series through dicomanon into a temp folder. Replaces the
  // spec's series.folder with the staged path so all downstream steps —
  // discovery, hashing, S3 upload — operate on the anonymised copy.
  // Cleaned up in the finally block at the bottom of the function.
  const stagingRoot = join(tmpdir(), `radiopaedia-stage-${Date.now()}-${process.pid}`);
  await mkdir(stagingRoot, { recursive: true });
  try {
    await stageAllSeries(spec, options.nodeBackendPort, stagingRoot, emit, signal);
    if (signal.aborted) { emit({ type: 'aborted' }); return; }
    await runUploadAfterStaging(spec, apiBase, () => requireToken(token),
      async () => { token = await getValidAccessToken(); }, emit, signal);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => { /* cleanup is best-effort */ });
  }
}

async function stageAllSeries(
  spec: ImageUploadSpec,
  nodeBackendPort: number,
  stagingRoot: string,
  emit: EmitFn,
  signal: AbortSignal,
): Promise<void> {
  let stageIdx = 0;
  for (let si = 0; si < spec.studies.length; si++) {
    const studyEntry = spec.studies[si];
    for (let xi = 0; xi < studyEntry.series.length; xi++) {
      if (signal.aborted) return;
      const series = studyEntry.series[xi];
      const stagedFolder = join(stagingRoot, String(stageIdx++));
      emit({ type: 'series-progress', studyIdx: si, seriesIdx: xi, phase: 'stage', done: 0, total: 1 });
      try {
        await stageOneSeries(nodeBackendPort, series.folder, stagedFolder, signal, (done, total) => {
          emit({ type: 'series-progress', studyIdx: si, seriesIdx: xi, phase: 'stage', done, total });
        });
      } catch (e) {
        if (signal.aborted) return;
        const msg = describeError(e);
        emit({ type: 'series-error', studyIdx: si, seriesIdx: xi, message: `staging failed: ${msg}` });
        throw e;
      }
      // Mutate the spec to point downstream steps at the anonymised copy.
      series.folder = stagedFolder;
    }
  }
}

async function stageOneSeries(
  nodeBackendPort: number,
  sourceFolder: string,
  stageFolder: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  await mkdir(stageFolder, { recursive: true });
  const url = `http://127.0.0.1:${nodeBackendPort}/anonymize`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: sourceFolder, output: stageFolder }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(`POST /anonymize`, res.status, body);
  }
  if (!res.body) throw new Error('no anonymize response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = 0;
  let total = 0;
  while (true) {
    if (signal.aborted) return;
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const evt = JSON.parse(line) as { type: string; total?: number; error?: string; input?: string };
      if (evt.type === 'start') {
        total = evt.total ?? 0;
        if (total > 0) onProgress(0, total);
      } else if (evt.type === 'file') {
        done += 1;
        onProgress(done, total || done);
      } else if (evt.type === 'error') {
        throw new Error(`anonymize error on ${evt.input ?? '<unknown>'}: ${evt.error ?? 'unspecified'}`);
      }
    }
  }
}

async function runUploadAfterStaging(
  spec: ImageUploadSpec,
  apiBase: string,
  token: () => string,
  refreshToken: () => Promise<void>,
  emit: EmitFn,
  signal: AbortSignal,
): Promise<void> {

  // Captures the (studyIdx, seriesIdx, studyId, jobId) for each
  // /image_preparation/.../series response. We use these after
  // mark_upload_finished to poll the upload-status endpoint and surface
  // the per-series processing state to the user.
  const jobsToPoll: JobToPoll[] = [];

  // Discovery pass: list each series' files and stat their sizes so we
  // can publish a byte budget up front. The renderer uses this to drive
  // a real progress bar that accounts for the actual upload size, not
  // just step count. Stat-ing thousands of files is fast (~ms per
  // hundred), so this only adds a brief "discovering…" beat at the top.
  const discovered: DiscoveredSeries[][] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const studyEntry of spec.studies) {
    const studyDiscovery: DiscoveredSeries[] = [];
    for (const series of studyEntry.series) {
      if (signal.aborted) { emit({ type: 'aborted' }); return; }
      const files = await listDicomFiles(series.folder);
      if (files.length === 0) {
        throw new Error(`Series folder has no files to upload: ${series.folder}`);
      }
      const sized = await Promise.all(files.map(async (path) => ({
        path,
        size: (await stat(path)).size,
      })));
      const sumBytes = sized.reduce((n, f) => n + f.size, 0);
      totalBytes += sumBytes;
      totalFiles += sized.length;
      studyDiscovery.push({ files: sized, totalBytes: sumBytes });
    }
    discovered.push(studyDiscovery);
  }
  emit({ type: 'budget', totalBytes, totalFiles });

  // Each byte counts twice toward the progress bar — once during the
  // local hash, once during the S3 upload. Hashing 1 GB takes a few
  // seconds; uploading 1 GB depends on the network. Treating both as
  // equal-weighted bytes gives a smooth bar across both phases without
  // any perceptual cliff between them.
  const totalProgressBytes = totalBytes * 2;
  let doneProgressBytes = 0;
  const bumpBytes = (delta: number): void => {
    doneProgressBytes = Math.min(doneProgressBytes + delta, totalProgressBytes);
    emit({
      type: 'bytes-progress',
      doneBytes: doneProgressBytes,
      totalBytes: totalProgressBytes,
    });
  };

  for (let si = 0; si < spec.studies.length; si++) {
    const studyEntry = spec.studies[si];
    for (let xi = 0; xi < studyEntry.series.length; xi++) {
      if (signal.aborted) { emit({ type: 'aborted' }); return; }
      const series = studyEntry.series[xi];
      const discovery = discovered[si][xi];
      try {
        const { jobId } = await uploadSeries({
          apiBase,
          caseId: spec.caseId,
          studyId: studyEntry.studyId,
          studyIdx: si,
          seriesIdx: xi,
          series,
          discovery,
          bumpBytes,
          token,
          refreshToken,
          emit,
          signal,
        });
        if (signal.aborted) { emit({ type: 'aborted' }); return; }
        emit({ type: 'series-done', studyIdx: si, seriesIdx: xi });
        if (jobId) {
          jobsToPoll.push({
            studyIdx: si,
            seriesIdx: xi,
            studyId: studyEntry.studyId,
            jobId,
          });
        }
      } catch (e) {
        if (signal.aborted) { emit({ type: 'aborted' }); return; }
        const msg = describeError(e);
        emit({ type: 'series-error', studyIdx: si, seriesIdx: xi, message: msg });
        // Bail on first failure — the case stays as a draft. Partial
        // success is more confusing than "fix the cause and retry".
        throw e;
      }
    }
  }

  if (signal.aborted) { emit({ type: 'aborted' }); return; }

  emit({ type: 'finalize-start' });
  try {
    await apiFetch(apiBase, '/api/v1/cases/' + spec.caseId + '/mark_upload_finished', {
      method: 'PUT',
      token: token(),
      signal,
    });
    emit({ type: 'finalize-done' });
  } catch (e) {
    if (signal.aborted) { emit({ type: 'aborted' }); return; }
    emit({ type: 'finalize-error', message: describeError(e) });
    throw e;
  }

  // Verify phase: poll Radiopaedia's per-job status endpoints until each
  // series settles (ready or failed) or the global timeout fires.
  if (jobsToPoll.length > 0) {
    emit({ type: 'verify-start', totalSeries: jobsToPoll.length });
    const summary = await pollProcessingState(apiBase, jobsToPoll, token, emit, signal);
    if (signal.aborted) { emit({ type: 'aborted' }); return; }
    emit({ type: 'verify-done', ...summary });
  }
  emit({ type: 'all-done', caseId: spec.caseId });
}

interface JobToPoll {
  studyIdx: number;
  seriesIdx: number;
  studyId: number;
  jobId: string;
}

async function pollProcessingState(
  apiBase: string,
  jobs: JobToPoll[],
  token: () => string,
  emit: EmitFn,
  signal: AbortSignal,
): Promise<{ readyCount: number; failedCount: number; pendingCount: number }> {
  // Per-job state — start at "pending-upload" (job is queued, no series
  // record yet) and walk through the status field until a terminal value.
  const states = new Map<string, ProcessingStatus>();
  for (const j of jobs) states.set(j.jobId, 'pending-upload');

  // Backoff: 2s → 4s → 8s → 16s, capped at 30s. Total timeout ~5 min,
  // generous for typical cases — large CTs can take longer; we'll log a
  // verify-done with pendingCount > 0 if we hit it.
  const overallDeadline = Date.now() + 5 * 60 * 1000;
  let delayMs = 2_000;

  // Each loop checks every still-pending job, then sleeps. Done when
  // every job is terminal or we hit the deadline.
  while (true) {
    if (signal.aborted) break;
    const pending = jobs.filter((j) => !isTerminal(states.get(j.jobId)!));
    if (pending.length === 0) break;
    if (Date.now() >= overallDeadline) break;

    for (const j of pending) {
      if (signal.aborted) break;
      try {
        const next = await fetchJobStatus(apiBase, j, token());
        if (next !== states.get(j.jobId)) {
          states.set(j.jobId, next);
          emit({ type: 'verify-progress', studyIdx: j.studyIdx, seriesIdx: j.seriesIdx, status: next });
        }
      } catch (e) {
        // A single poll error doesn't end the world — try again next round.
        // If the job vanished entirely (server pruned), we'll keep polling
        // until the overall deadline and report it as still-pending.
      }
    }

    if (signal.aborted) break;
    if (jobs.every((j) => isTerminal(states.get(j.jobId)!))) break;
    if (Date.now() >= overallDeadline) break;
    await sleep(delayMs, signal);
    delayMs = Math.min(delayMs * 2, 30_000);
  }

  let ready = 0, failed = 0, pending = 0;
  for (const j of jobs) {
    const s = states.get(j.jobId);
    if (s === 'ready' || s === 'completed-dicom-processing') ready++;
    else if (s === 'failed') failed++;
    else pending++;
  }
  return { readyCount: ready, failedCount: failed, pendingCount: pending };
}

function isTerminal(s: ProcessingStatus): boolean {
  return s === 'ready' || s === 'completed-dicom-processing' || s === 'failed';
}

async function fetchJobStatus(
  apiBase: string,
  j: JobToPoll,
  bearer: string,
): Promise<ProcessingStatus> {
  // GET /image_preparation/:case_id/studies/:study_id/upload/:upload_id
  // returns 202 while the job is running, 200 once finished. The 200 has
  // study + series fields merged; absence of `seriesId` (camelCase, per
  // SeriesImagePreparationSerializer) means the job finished without
  // creating a series — i.e. the upload failed (no error surfaced; see
  // handoff doc item #8).
  const url = `${apiBase}/image_preparation/_/studies/${j.studyId}/upload/${encodeURIComponent(j.jobId)}`;
  // The case_id segment is unused by check_upload_status; the route is
  // matched by job_id alone. Sending '_' as a placeholder keeps the URL
  // valid without us having to thread the case id deeper into the poll
  // call site.
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${bearer}`, 'Accept': 'application/json' },
  });
  if (res.status === 202) return 'pending-upload';
  if (!res.ok) throw new HttpError(`GET upload status`, res.status, await res.text().catch(() => ''));
  const body = (await res.json()) as Record<string, unknown>;
  // Series exists → use its status field (ready / completed-dicom-processing /
  // pending-dicom-processing / pending-trim / pending-crop). Trim/crop are
  // unrelated to a fresh upload, so they collapse to pending-dicom for our
  // purposes.
  if (body.seriesId != null) {
    const status = String(body.status ?? '');
    if (status === 'ready') return 'ready';
    if (status === 'completed-dicom-processing') return 'completed-dicom-processing';
    return 'pending-dicom-processing';
  }
  // No seriesId after the job finished → failed.
  return 'failed';
}

function requireToken(t: string | null): string {
  if (!t) throw new Error('Access token disappeared mid-upload — sign in again.');
  return t;
}

function describeError(e: unknown): string {
  if (e instanceof HttpError) {
    const body = e.body ? ` — ${e.body.slice(0, 200)}` : '';
    return `${e.message} (HTTP ${e.status})${body}`;
  }
  return (e as Error)?.message ?? String(e);
}

interface UploadSeriesArgs {
  apiBase: string;
  caseId: number;
  studyId: number;
  studyIdx: number;
  seriesIdx: number;
  series: SeriesUploadSpec;
  discovery: DiscoveredSeries;
  bumpBytes: (delta: number) => void;
  token: () => string;
  refreshToken: () => Promise<void>;
  emit: EmitFn;
  signal: AbortSignal;
}

async function uploadSeries(args: UploadSeriesArgs): Promise<{ jobId: string | null }> {
  const { apiBase, caseId, studyId, studyIdx, seriesIdx, series, discovery, bumpBytes, emit, signal } = args;

  const files = discovery.files;
  emit({
    type: 'series-start',
    studyIdx, seriesIdx,
    folder: series.folder,
    sliceCount: files.length,
  });

  // 2. Read + hash each file. We keep the bytes in memory because we'll
  //    PUT them right after — re-reading would double the disk I/O.
  const hashes: string[] = [];
  const buffers: Buffer[] = [];
  emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'hash', done: 0, total: files.length });
  for (let i = 0; i < files.length; i++) {
    if (signal.aborted) return { jobId: null };
    const buf = await readFile(files[i].path);
    buffers.push(buf);
    hashes.push(createHash('sha256').update(buf).digest('hex'));
    bumpBytes(files[i].size);
    emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'hash', done: i + 1, total: files.length });
  }

  // 3. POST /direct_s3_uploads with the hash list. Response is one entry
  //    per hash with either { id, url } (need to PUT) or { id, status:
  //    'already_uploaded' } (S3 already has these bytes; reuse the id).
  emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'presign', done: 0, total: 1 });
  const presignRes = await apiFetch(apiBase, '/direct_s3_uploads', {
    method: 'POST',
    token: args.token(),
    body: { sha256: hashes },
    signal,
  });
  const uploads = extractUploadsArray(presignRes);
  if (uploads.length !== files.length) {
    throw new Error(
      `/direct_s3_uploads returned ${uploads.length} entries for ${files.length} hashes`,
    );
  }
  emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'presign', done: 1, total: 1 });

  // 4. PUT bytes to S3 in parallel (bounded). Skip entries that came back
  //    as already_uploaded — but credit their bytes to the progress bar
  //    immediately so the bar stays accurate when an unchanged stack is
  //    re-pushed.
  const toUpload: Array<{ u: PresignEntry; i: number }> = [];
  for (let i = 0; i < uploads.length; i++) {
    const u = uploads[i];
    if (u.status === 'already_uploaded' || !u.url) {
      bumpBytes(files[i].size);
    } else {
      toUpload.push({ u, i });
    }
  }
  if (toUpload.length > 0) {
    let done = 0;
    emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'upload', done, total: toUpload.length });
    await runBounded(toUpload, S3_PUT_CONCURRENCY, async ({ u, i }) => {
      if (signal.aborted) return;
      await s3Put(u.url!, buffers[i], signal);
      bumpBytes(files[i].size);
      done += 1;
      emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'upload', done, total: toUpload.length });
    });
    // Pause briefly so /image_preparation's S3 GET doesn't race us.
    await sleep(POST_PUT_SETTLE_MS, signal);
  }

  // 5. POST /image_preparation/.../series. The body's perspective +
  //    specifics are sent here (NOT on /api/v1/cases/:id/studies — see
  //    the wire-contract block at the top of src/shared/api.ts).
  emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'prepare', done: 0, total: 1 });
  const seriesBody: Record<string, unknown> = { root_index: 0 };
  if (series.perspective?.trim()) seriesBody.perspective = series.perspective.trim();
  if (series.specifics?.trim()) seriesBody.specifics = series.specifics.trim();
  const prepResponse = await apiFetch(apiBase, `/image_preparation/${caseId}/studies/${studyId}/series`, {
    method: 'POST',
    token: args.token(),
    body: {
      image_format: 'application/dicom',
      series: seriesBody,
      stack_upload: { uploaded_data: uploads.map((u) => u.id) },
    },
    signal,
  });
  emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'prepare', done: 1, total: 1 });
  // The /image_preparation/.../series response includes a `job_id` we
  // use later to poll processing status. Type it loosely (the exact
  // shape isn't documented; check_upload_status reads it back as a
  // string).
  const jobId = prepResponse.job_id as string | undefined;
  return { jobId: jobId ?? null };
}

function extractUploadsArray(json: unknown): PresignEntry[] {
  // The endpoint historically returned { uploads: [...] } per the docs but
  // older response shapes returned a bare array. Tolerate both.
  if (Array.isArray(json)) return json as PresignEntry[];
  const obj = json as { uploads?: PresignEntry[] };
  if (Array.isArray(obj.uploads)) return obj.uploads;
  throw new Error(`/direct_s3_uploads response not understood: ${JSON.stringify(json).slice(0, 200)}`);
}

async function listDicomFiles(folder: string): Promise<string[]> {
  // Accept any regular file in the series folder. We don't filter on
  // `.dcm` because Radiopaedia's anonymiser preserves source filenames,
  // and a lot of clinical DICOMs come out of PACS with no extension at
  // all (e.g. "3XUGRC0F"). The rest of the backend already treats the
  // folder as DICOM-only, so this matches scan / thumbnails / reformat.
  // Hidden files (.DS_Store, ._*) are excluded so a stray macOS metadata
  // sibling doesn't get hashed and uploaded.
  const entries = await readdir(folder);
  const files: Array<{ path: string; name: string }> = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const path = join(folder, name);
    try {
      const s = await stat(path);
      if (s.isFile()) files.push({ path, name });
    } catch { /* skip unreadable */ }
  }
  // Sort by name so the slice order is deterministic. Whatever order the
  // anonymiser used to write the folder will sort the same way here.
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files.map((f) => f.path);
}

interface ApiFetchOpts {
  method?: string;
  token: string;
  body?: unknown;
  signal: AbortSignal;
}
async function apiFetch(
  apiBase: string,
  path: string,
  opts: ApiFetchOpts,
): Promise<Record<string, unknown>> {
  const url = `${apiBase}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${opts.token}`,
    'Accept': 'application/json',
  };
  let bodyStr: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(opts.body);
  }
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: bodyStr,
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(`${opts.method ?? 'GET'} ${path}`, res.status, body);
  }
  // mark_upload_finished + image_preparation responses include JSON; for
  // anything that doesn't, parse failures fall through to {} so callers
  // don't have to special-case empty bodies.
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function s3Put(url: string, body: Buffer, signal: AbortSignal): Promise<void> {
  // Authorization MUST NOT be set: S3 validates the presigned URL via
  // its query-string signature, and an extra Authorization header makes
  // the request 400. See src/shared/api.ts wire-contract block + the
  // smoke-test note.
  const res = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'Content-Type': 'application/dicom' },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(`S3 PUT failed`, res.status, text);
  }
}

async function runBounded<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners: Array<Promise<void>> = [];
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
    }
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  await Promise.all(runners);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
