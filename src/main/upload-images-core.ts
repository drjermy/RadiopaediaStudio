// Pure (Electron-free, fs-free) building blocks for upload-images.ts.
//
// This module exists so unit tests can drive `checkUploadStatusCore` /
// `fetchJobStatusCore` without an Electron environment or real network.
// Anything that touches `electron`, `node:fs`, or the user's filesystem
// stays in upload-images.ts; anything that's just shape parsing + a
// single fetch round-trip lives here.
//
// Run via: npm test (after npm run build:frontend).

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

export interface UploadedJob {
  studyIdx: number;
  seriesIdx: number;
  caseId: number;
  studyId: number;
  jobId: string;
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface CheckUploadStatusDeps {
  fetch: typeof fetch;
  getValidAccessToken: () => Promise<string | null>;
  apiBase: string;
}

/**
 * Build the polling URL for a given job. The `case_id` segment looks
 * redundant given the route matches on upload_id alone, but the
 * controller's `find_case` runs in a before_action and 401s if the
 * lookup fails — so the real case id has to be sent.
 */
export function buildJobStatusUrl(apiBase: string, j: UploadedJob): string {
  return `${apiBase}/image_preparation/${j.caseId}/studies/${j.studyId}/upload/${encodeURIComponent(j.jobId)}`;
}

/**
 * GET /image_preparation/.../upload/:upload_id and translate the response
 * into a ProcessingStatus.
 *
 * 202 → pending-upload (background job still running).
 * 200 + series.seriesId + series.status='ready' → ready.
 * 200 + series.seriesId + series.status='completed-dicom-processing' →
 *   completed-dicom-processing.
 * 200 + series.seriesId + any other status → pending-dicom-processing
 *   (covers pending-trim / pending-crop / unknown future states).
 * 200 with no series root or no seriesId → failed (job ran but no
 *   series got created; the API does not surface a reason).
 * Anything else → throws HttpError.
 */
export async function fetchJobStatusCore(
  fetchImpl: typeof fetch,
  apiBase: string,
  j: UploadedJob,
  bearer: string,
  signal: AbortSignal,
): Promise<ProcessingStatus> {
  const res = await fetchImpl(buildJobStatusUrl(apiBase, j), {
    headers: { 'Authorization': `Bearer ${bearer}`, 'Accept': 'application/json' },
    signal,
  });
  if (res.status === 202) return 'pending-upload';
  if (!res.ok) {
    throw new HttpError('GET upload status', res.status, await res.text().catch(() => ''));
  }
  const body = (await res.json()) as Record<string, unknown>;
  const seriesPayload = body.series as Record<string, unknown> | undefined;
  if (seriesPayload && seriesPayload.seriesId != null) {
    const status = String(seriesPayload.status ?? '');
    if (status === 'ready') return 'ready';
    if (status === 'completed-dicom-processing') return 'completed-dicom-processing';
    return 'pending-dicom-processing';
  }
  return 'failed';
}

/**
 * On-demand status check for a previously-uploaded case. Single
 * round-trip per job, no looping — the caller decides cadence. Returns
 * one entry per input job, in input order.
 *
 * Single-job errors don't kill the batch — the failing job is recorded
 * as `pending-upload` (the safest default; a transient 502 shouldn't
 * cause the UI to claim "failed"). The caller can retry to disambiguate.
 *
 * Aborts via the supplied signal: any in-flight fetch will reject with
 * AbortError, which is then caught by the per-job try/catch and the
 * outer loop bails on its next iteration.
 */
export async function checkUploadStatusCore(
  jobs: UploadedJob[],
  signal: AbortSignal,
  deps: CheckUploadStatusDeps,
): Promise<Array<{ jobId: string; status: ProcessingStatus }>> {
  const token = await deps.getValidAccessToken();
  if (!token) {
    throw new Error('No valid access token. Sign in to Radiopaedia and try again.');
  }
  const out: Array<{ jobId: string; status: ProcessingStatus }> = [];
  for (const job of jobs) {
    if (signal.aborted) break;
    try {
      const status = await fetchJobStatusCore(deps.fetch, deps.apiBase, job, token, signal);
      out.push({ jobId: job.jobId, status });
    } catch {
      out.push({ jobId: job.jobId, status: 'pending-upload' });
    }
  }
  return out;
}
