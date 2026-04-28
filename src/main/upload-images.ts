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
import { readFile, readdir, stat } from 'node:fs/promises';
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

export type UploadPhase = 'hash' | 'presign' | 'upload' | 'prepare';

export type UploadEvent =
  | { type: 'series-start'; studyIdx: number; seriesIdx: number; folder: string; sliceCount: number }
  | { type: 'series-progress'; studyIdx: number; seriesIdx: number; phase: UploadPhase; done: number; total: number }
  | { type: 'series-done'; studyIdx: number; seriesIdx: number }
  | { type: 'series-error'; studyIdx: number; seriesIdx: number; message: string }
  | { type: 'finalize-start' }
  | { type: 'finalize-done' }
  | { type: 'finalize-error'; message: string }
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

export async function runImageUpload(
  spec: ImageUploadSpec,
  emit: EmitFn,
  signal: AbortSignal,
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

  for (let si = 0; si < spec.studies.length; si++) {
    const studyEntry = spec.studies[si];
    for (let xi = 0; xi < studyEntry.series.length; xi++) {
      if (signal.aborted) { emit({ type: 'aborted' }); return; }
      const series = studyEntry.series[xi];
      try {
        await uploadSeries({
          apiBase,
          caseId: spec.caseId,
          studyId: studyEntry.studyId,
          studyIdx: si,
          seriesIdx: xi,
          series,
          token: () => requireToken(token),
          refreshToken: async () => { token = await getValidAccessToken(); },
          emit,
          signal,
        });
        if (signal.aborted) { emit({ type: 'aborted' }); return; }
        emit({ type: 'series-done', studyIdx: si, seriesIdx: xi });
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
      token: requireToken(token),
      signal,
    });
    emit({ type: 'finalize-done' });
    emit({ type: 'all-done', caseId: spec.caseId });
  } catch (e) {
    if (signal.aborted) { emit({ type: 'aborted' }); return; }
    emit({ type: 'finalize-error', message: describeError(e) });
    throw e;
  }
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
  token: () => string;
  refreshToken: () => Promise<void>;
  emit: EmitFn;
  signal: AbortSignal;
}

async function uploadSeries(args: UploadSeriesArgs): Promise<void> {
  const { apiBase, caseId, studyId, studyIdx, seriesIdx, series, emit, signal } = args;

  // 1. Glob the DICOM files in the series folder.
  const files = await listDicomFiles(series.folder);
  if (files.length === 0) {
    throw new Error(`Series folder has no .dcm files: ${series.folder}`);
  }
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
    if (signal.aborted) return;
    const buf = await readFile(files[i]);
    buffers.push(buf);
    hashes.push(createHash('sha256').update(buf).digest('hex'));
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
  //    as already_uploaded.
  const toUpload = uploads
    .map((u, i) => ({ u, i }))
    .filter(({ u }) => u.status !== 'already_uploaded' && u.url);
  if (toUpload.length > 0) {
    let done = 0;
    emit({ type: 'series-progress', studyIdx, seriesIdx, phase: 'upload', done, total: toUpload.length });
    await runBounded(toUpload, S3_PUT_CONCURRENCY, async ({ u, i }) => {
      if (signal.aborted) return;
      await s3Put(u.url!, buffers[i], signal);
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
  await apiFetch(apiBase, `/image_preparation/${caseId}/studies/${studyId}/series`, {
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
  const entries = await readdir(folder);
  const files: Array<{ path: string; name: string }> = [];
  for (const name of entries) {
    if (!/\.dcm$/i.test(name)) continue;
    const path = join(folder, name);
    try {
      const s = await stat(path);
      if (s.isFile()) files.push({ path, name });
    } catch { /* skip unreadable */ }
  }
  // Sort by name so the slice order is deterministic — image0000.dcm,
  // image0001.dcm, etc. Whatever order the anonymiser used to write the
  // folder will sort the same way here.
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
