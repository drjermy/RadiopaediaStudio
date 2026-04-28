// Pure storage-format logic for the Sent-cases panel (#25).
//
// The renderer stores sent cases in localStorage; these helpers handle
// the in-memory shape transitions (parse, version-filter, cap-newest-N,
// dedupe-by-case, merge per-job statuses). Kept separate from the
// renderer wiring so unit tests can drive them without a DOM /
// localStorage shim.
//
// Schema versioning: every entry carries `v: <SENT_CASES_VERSION>`.
// `parseSentCases` quietly drops any entry whose version doesn't match
// the current one — losing local pointers is recoverable because the
// data is already committed to Radiopaedia.

export type ProcessingStatus =
  | 'pending-upload'
  | 'pending-dicom-processing'
  | 'completed-dicom-processing'
  | 'ready'
  | 'failed';

export interface SentCaseJob {
  studyIdx: number;
  seriesIdx: number;
  studyId: number;
  jobId: string;
  lastKnownStatus: ProcessingStatus | null;
  lastCheckedAt: string | null;
}

export interface SentCase {
  v: number;
  caseId: number;
  apiBase: string;
  title: string;
  uploadedAt: string; // ISO
  jobs: SentCaseJob[];
}

/**
 * Parse the raw localStorage value into a SentCase[]. Returns an empty
 * array on any failure (null, malformed JSON, non-array shape) and
 * filters out entries whose `v` doesn't match `currentVersion`.
 */
export function parseSentCases(raw: string | null, currentVersion: number): SentCase[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (c): c is SentCase =>
      !!c && typeof c === 'object' && (c as { v?: unknown }).v === currentVersion,
  );
}

/** Cap the list at `max` entries, newest first (i.e. drop the tail). */
export function capSentCases(cases: SentCase[], max: number): SentCase[] {
  return cases.slice(0, max);
}

/**
 * Insert (or replace by `caseId + apiBase`) a fresh entry at the head
 * of the list. Used after a successful upload — newest representation
 * wins, even on a retry of the same case.
 */
export function addOrReplaceSentCase(existing: SentCase[], entry: SentCase): SentCase[] {
  const filtered = existing.filter(
    (c) => !(c.caseId === entry.caseId && c.apiBase === entry.apiBase),
  );
  return [entry, ...filtered];
}

/**
 * Build a fresh SentCase entry from a successful upload's job list.
 * `lastKnownStatus` and `lastCheckedAt` are nulled so the panel shows
 * "Status not checked yet" until the first refresh.
 */
export function buildSentCase(
  version: number,
  caseId: number,
  apiBase: string,
  title: string,
  jobs: ReadonlyArray<{ studyIdx: number; seriesIdx: number; studyId: number; jobId: string }>,
  uploadedAt: string,
): SentCase {
  return {
    v: version,
    caseId,
    apiBase,
    title,
    uploadedAt,
    jobs: jobs.map((j) => ({
      studyIdx: j.studyIdx,
      seriesIdx: j.seriesIdx,
      studyId: j.studyId,
      jobId: j.jobId,
      lastKnownStatus: null,
      lastCheckedAt: null,
    })),
  };
}

/**
 * Merge a batch of per-job status updates into the matching case.
 * Returns a new array; the input is NOT mutated. If the case isn't
 * present (e.g. removed concurrently), the original list is returned
 * unchanged.
 */
export function mergeJobStatuses(
  cases: SentCase[],
  caseId: number,
  apiBase: string,
  updates: ReadonlyArray<{ jobId: string; status: ProcessingStatus }>,
  checkedAt: string,
): SentCase[] {
  const idx = cases.findIndex((c) => c.caseId === caseId && c.apiBase === apiBase);
  if (idx < 0) return cases;
  const byJobId = new Map(updates.map((u) => [u.jobId, u.status]));
  const target = cases[idx];
  const next: SentCase = {
    ...target,
    jobs: target.jobs.map((j) => {
      const newStatus = byJobId.get(j.jobId);
      if (newStatus == null) return j;
      return { ...j, lastKnownStatus: newStatus, lastCheckedAt: checkedAt };
    }),
  };
  const out = cases.slice();
  out[idx] = next;
  return out;
}

/** Remove the entry matching `caseId + apiBase`, if any. */
export function removeSentCase(cases: SentCase[], caseId: number, apiBase: string): SentCase[] {
  return cases.filter((c) => !(c.caseId === caseId && c.apiBase === apiBase));
}
