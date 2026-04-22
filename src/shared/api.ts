// Shared typed shapes between main / renderer / future-server code.
//
// Source of truth:
//   - Pydantic request/response models: backend/app/main.py
//   - Summary shape emitted by anonymise + /scan: backend/app/anonymizer.py
//     (see `iter_scrub_folder` summary_out and `scan_folder`)
//   - NDJSON streaming event shapes: the `_line({...})` calls in
//     backend/app/main.py (anonymize/window/trim/transform)
//   - Node anonymiser mirrors the Python shapes: backend-js/
//
// When the Python side changes, update this file and `grep` for the
// affected TypeScript type to find consumers.

// ---------------------------------------------------------------------------
// Transfer syntax (from backend/app/classify.py::classify_transfer_syntax)
// ---------------------------------------------------------------------------

export interface TransferSyntaxInfo {
  uid: string | null;
  name: string | null;
  compressed: boolean;
  lossy: boolean;
}

// ---------------------------------------------------------------------------
// Study/series summary (backend/app/anonymizer.py::scan_folder +
// iter_scrub_folder summary_out). Emitted by /scan, /anonymize summary,
// and /series-info (as a single series).
// ---------------------------------------------------------------------------

export interface SeriesSummary {
  description: string | null;
  modality: string | null;
  orientation: string | null;            // 'axial' | 'coronal' | 'sagittal' | null
  slice_thickness: number | null;
  slice_spacing: number | null;
  slice_count: number;
  total_bytes: number;
  transfer_syntax: TransferSyntaxInfo;
  folder: string | null;
  thumbnail?: string | null;              // data: URL, filled in by /thumbnails
  window_center?: number | null;
  window_width?: number | null;
  // Set client-side by the renderer when appending a derived series
  // (not produced by the backend).
  operation?: string;
}

export interface StudySummary {
  description: string | null;
  modality: string | null;
  body_part: string | null;
  study_date: string | null;
  total_slices: number;
  total_bytes: number;
  series_count: number;
  series: SeriesSummary[];
}

export interface SummaryPayload {
  studies: StudySummary[];
}

// ---------------------------------------------------------------------------
// NDJSON streaming events (backend/app/main.py: anonymize/window/trim/transform)
// ---------------------------------------------------------------------------

export interface StartEvent {
  type: 'start';
  mode: string;           // 'file' | 'folder' | 'reformat'
  total: number;
  output: string;
}

export interface TotalEvent {
  type: 'total';
  total: number;
}

export interface PhaseEvent {
  type: 'phase';
  label: string;
}

export interface FileEvent {
  type: 'file';
  input: string;
  output: string;
  kept?: number;
  dropped?: number;
  dropped_tags?: string[];
}

export interface ErrorEvent {
  type: 'error';
  input?: string;
  error: string;
}

// `summary` event carries the studies[] payload after the last `file`
// (see iter_scrub_folder summary_out).
export interface SummaryEvent extends SummaryPayload {
  type: 'summary';
}

export interface DoneEvent {
  type: 'done';
  count: number;
  error_count: number;
  output: string;
}

export type StreamEvent =
  | StartEvent
  | TotalEvent
  | PhaseEvent
  | FileEvent
  | ErrorEvent
  | SummaryEvent
  | DoneEvent;

// ---------------------------------------------------------------------------
// Request / response bodies (backend/app/main.py Pydantic models)
// ---------------------------------------------------------------------------

export interface InspectRequest {
  input: string;
}

export interface InspectFileResponse {
  kind: 'file';
  name: string;
  input: string;
  dicom_count: number;
  total_bytes: number;
}

export interface InspectFolderResponse {
  kind: 'folder';
  name: string;
  input: string;
  dicom_count: number;
  total_bytes: number;
}

export type InspectResponse = InspectFileResponse | InspectFolderResponse;

export interface ThumbnailsRequest {
  folders: string[];
}

// `thumbnails` returns { folder_path: data:image/png;base64... | null }.
export type ThumbnailsResponse = Record<string, string | null>;

export interface SeriesInfoRequest {
  folder: string;
  label?: string | null;
}

// Shape mirrors SeriesSummary but is returned with an additional `folder`
// echo; fields that aren't derivable (e.g. `series_count`) are absent.
export interface SeriesInfoResponse {
  folder: string;
  description: string | null;
  modality?: string | null;
  orientation?: string | null;
  slice_thickness?: number | null;
  slice_spacing?: number | null;
  slice_count: number;
  total_bytes: number;
  transfer_syntax?: TransferSyntaxInfo;
  thumbnail: string | null;
  window_center?: number | null;
  window_width?: number | null;
}

export interface AnonymizeRequest {
  input: string;
  output: string;
}

// /window/presets response: name -> { center, width }
export type WindowPreset = { center: number; width: number };
export type WindowPresetsResponse = Record<string, WindowPreset>;

// CompressSpec / ReformatSpec / WindowSpec / TrimRequest / TransformRequest
// — match backend/app/main.py.
export interface CompressSpec {
  mode: 'lossless' | 'lossy';
  ratio?: number | null;
}

export interface ReformatSpec {
  orientation: string;                    // 'axial' | 'coronal' | 'sagittal'
  thickness: number;
  spacing: number;
  mode: string;                           // 'avg' | 'mip' | 'minip'
}

export interface WindowSpec {
  center: number;
  width: number;
}

export interface TrimRequest {
  input: string;
  output: string;
  start: number;                          // inclusive 0-based
  end: number;                            // inclusive
}

export interface TransformRequest {
  input: string;
  output: string;
  reformat?: ReformatSpec;
  window?: WindowSpec;
  compress?: CompressSpec;
}

export interface DeleteSeriesRequest {
  folder: string;
  allowed_parent: string;
}

// ---------------------------------------------------------------------------
// Case metadata — the fields a user fills in after anonymisation, before
// uploading to Radiopaedia. This is the shape a future Radiopaedia API client
// (#?) will serialise into its request body. Keep form fields idiomatic
// TypeScript; translate to the wire format at serialise time.
// ---------------------------------------------------------------------------

/** Max lengths (kept as named constants so UI + future serialiser agree). */
export const CASE_TITLE_MAX = 120;
export const CASE_CLINICAL_HISTORY_MAX = 2000;
export const CASE_FINDINGS_MAX = 5000;

/** Fixed dropdown vocabularies. Keep ordered; UI renders in-order. */
export const CASE_MODALITIES = [
  'CT',
  'MRI',
  'X-ray',
  'US',
  'NM',
  'PT',
  'Mammography',
  'Fluoroscopy',
  'Angiography',
  'Other',
] as const;
export type CaseModality = (typeof CASE_MODALITIES)[number];

export const CASE_BODY_PARTS = [
  'head',
  'chest',
  'abdomen',
  'pelvis',
  'upper limb',
  'lower limb',
  'spine',
  'musculoskeletal',
  'cardiovascular',
  'other',
] as const;
export type CaseBodyPart = (typeof CASE_BODY_PARTS)[number];

export const CASE_AGE_BANDS = [
  '<1',
  '1-10',
  '11-20',
  '21-30',
  '31-40',
  '41-50',
  '51-60',
  '61-70',
  '71-80',
  '81+',
  'not specified',
] as const;
export type CaseAgeBand = (typeof CASE_AGE_BANDS)[number];

export type CaseSex = 'M' | 'F' | 'O';
export type CaseVisibility = 'draft' | 'public';

export interface Case {
  // Required.
  title: string;                                // 1..CASE_TITLE_MAX chars.
  visibility: CaseVisibility;                   // defaults to 'draft'.

  // Preferred-but-optional structured fields (picked from fixed lists
  // above — typed as plain string for forward-compat with new values).
  body_part: string | null;
  modality: string | null;
  patient_age_band: string | null;              // see CASE_AGE_BANDS.
  patient_sex: CaseSex | null;

  // Prose fields. Optional (may be ''), but prompted.
  clinical_history: string;                     // soft cap CASE_CLINICAL_HISTORY_MAX.
  findings: string;                             // soft cap CASE_FINDINGS_MAX.
  case_discussion: string;                      // no explicit cap.

  tags: string[];                               // deduped, trimmed, non-empty.

  // Derived — NOT shown in the form, filled in at serialise time.
  source_summary: SummaryPayload;
  output_root: string;
}

/**
 * Pre-fill a Case form from the anonymise summary + output folder.
 * Picks modality / body_part from the first study (or the first series with
 * a usable modality) when available. Everything else is left unset so the
 * UI can render its own placeholders / defaults.
 */
export function deriveDefaultCase(
  summary: SummaryPayload,
  outputRoot: string,
): Partial<Case> {
  const out: Partial<Case> = {
    visibility: 'draft',
    source_summary: summary,
    output_root: outputRoot,
  };
  const firstStudy = summary.studies?.[0];
  if (firstStudy) {
    const studyModality = firstStudy.modality
      ?? firstStudy.series?.find((s) => s.modality)?.modality
      ?? null;
    if (studyModality) out.modality = studyModality;
    if (firstStudy.body_part) out.body_part = firstStudy.body_part;
    if (firstStudy.description) out.title = firstStudy.description.slice(0, CASE_TITLE_MAX);
  }
  return out;
}

/**
 * Placeholder boundary for the future Radiopaedia API client (#?). The real
 * shape/transport lives in that client — this function just marks the seam
 * between our in-app `Case` and whatever the server wants. Until that client
 * lands, a pass-through object is enough to let callers feel out the API.
 *
 * TODO(#?): replace `Record<string, unknown>` with the generated Radiopaedia
 * client's request type once that lands; drop `source_summary`/`output_root`
 * or fold into multipart upload as appropriate.
 */
export function buildCasePayload(c: Case): Record<string, unknown> {
  return {
    title: c.title,
    visibility: c.visibility,
    body_part: c.body_part,
    modality: c.modality,
    patient_age_band: c.patient_age_band,
    patient_sex: c.patient_sex,
    clinical_history: c.clinical_history,
    findings: c.findings,
    case_discussion: c.case_discussion,
    tags: c.tags,
    // Derived — present so the future client can pick out files and
    // attach DICOMs from the anonymised root.
    source_summary: c.source_summary,
    output_root: c.output_root,
  };
}
