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
// uploading to Radiopaedia. Field names match the Radiopaedia API; see
// `buildCaseCreatePayload` / `buildStudyCreatePayload` below for the exact
// wire format.
//
// Wire contract (server-side permit lists). Unrecognised keys are silently
// dropped, so a 200 doesn't mean a field was accepted — verify by reading
// the case back.
//
//   POST /api/v1/cases
//     accepts: title, system_id, diagnostic_certainty_id, suitable_for_quiz,
//              presentation, age, gender ('Male'|'Female'), body (HTML).
//     UI-side names map at the wire boundary:
//       clinical_history → presentation
//       case_discussion  → body (HTML)
//       patient_sex M/F  → gender Male/Female (Other is omitted).
//
//   POST /api/v1/cases/:case_id/studies
//     accepts ONLY: modality, findings, position, caption.
//     No `plane` / `orientation` field on this endpoint — it would be
//     silently dropped. Plane lives on the Series, not the Study.
//
//   POST /image_preparation/:CASE_ID/studies/:STUDY_ID/series
//     accepts: specifics, perspective, root_index. The series-create body
//     wraps this in `{ series: { … }, stack_upload: { uploaded_data: [] } }`.
//
//   PATCH image_preparation series update
//     accepts: perspective, specifics. Per-series `perspective` is what the
//     UI labels "Plane" (free text — Axial / Coronal / Sagittal are
//     typeahead suggestions, not an enum).
//
//   PUT /api/v1/cases/:case_id/mark_upload_finished
//     no body params; finalises the draft.
// ---------------------------------------------------------------------------

/** Max lengths (kept as named constants so UI + serialiser agree). */
export const CASE_TITLE_MAX = 120;
export const CASE_CLINICAL_HISTORY_MAX = 2000;

/**
 * Systems vocabulary. IDs are **verbatim** from the Radiopaedia API spec —
 * the set is non-contiguous (5, 10, 13, 14 are not assigned), and
 * "Not applicable" is id 24, not 5. Rendered alphabetically here for the
 * dropdown; the API treats `system_id` as an opaque integer so order in
 * this array only affects UI.
 */
export const SYSTEM_OPTIONS = [
  { id: 1,  name: 'Breast' },
  { id: 16, name: 'Cardiac' },
  { id: 3,  name: 'Central Nervous System' },
  { id: 4,  name: 'Chest' },
  { id: 21, name: 'Forensic' },
  { id: 6,  name: 'Gastrointestinal' },
  { id: 19, name: 'Gynaecology' },
  { id: 20, name: 'Haematology' },
  { id: 7,  name: 'Head & Neck' },
  { id: 8,  name: 'Hepatobiliary' },
  { id: 17, name: 'Interventional' },
  { id: 9,  name: 'Musculoskeletal' },
  { id: 18, name: 'Obstetrics' },
  { id: 22, name: 'Oncology' },
  { id: 12, name: 'Paediatrics' },
  { id: 15, name: 'Spine' },
  { id: 23, name: 'Trauma' },
  { id: 11, name: 'Urogenital' },
  { id: 2,  name: 'Vascular' },
  { id: 24, name: 'Not Applicable' },
] as const satisfies ReadonlyArray<{ id: number; name: string }>;
export type SystemOption = (typeof SYSTEM_OPTIONS)[number];

/**
 * Diagnostic certainty vocabulary. IDs straight from the API spec.
 * "Not applicable" (id 5) last, rest in the spec's natural order.
 */
export const DIAGNOSTIC_CERTAINTY_OPTIONS = [
  { id: 1, name: 'Possible' },
  { id: 2, name: 'Probable' },
  { id: 3, name: 'Almost Certain' },
  { id: 4, name: 'Certain' },
  { id: 5, name: 'Not applicable' },
] as const satisfies ReadonlyArray<{ id: number; name: string }>;
export type DiagnosticCertaintyOption = (typeof DIAGNOSTIC_CERTAINTY_OPTIONS)[number];

/**
 * Modality vocabulary for Study objects. Exactly the 12 strings from the
 * Radiopaedia API spec — don't rename or translate these; the API matches
 * literally. IDs are a local-only tag (used as the <option value>) so we
 * don't have to round-trip the verbatim label through `select.value`.
 */
export const MODALITY_OPTIONS = [
  { id: 1,  name: 'CT' },
  { id: 2,  name: 'MRI' },
  { id: 3,  name: 'X-ray' },
  { id: 4,  name: 'Ultrasound' },
  { id: 5,  name: 'Mammography' },
  { id: 6,  name: 'DSA (angiography)' },
  { id: 7,  name: 'Fluoroscopy' },
  { id: 8,  name: 'Nuclear medicine' },
  { id: 9,  name: 'Annotated image' },
  { id: 10, name: 'Illustration' },
  { id: 11, name: 'Pathology' },
  { id: 12, name: 'Photograph' },
] as const satisfies ReadonlyArray<{ id: number; name: string }>;
export type ModalityOption = (typeof MODALITY_OPTIONS)[number];
export type Modality = ModalityOption['name'];

export type CaseSex = 'M' | 'F' | 'O';

/**
 * Case — maps to the body of POST /api/v1/cases. UI-level shape; the wire
 * format (string-serialised, HTML-wrapped) is produced by
 * buildCaseCreatePayload.
 */
export interface Case {
  // Required at submit time.
  title: string;                                // 1..CASE_TITLE_MAX chars.
  system_id: number | null;                     // from SYSTEM_OPTIONS; required by UI gate.

  // Optional structured fields.
  age: string | null;                           // free-text, e.g. "34 years".
  patient_sex: CaseSex | null;                  // UI-local tri-state; maps to Male/Female/omit.
  diagnostic_certainty_id?: number;             // from DIAGNOSTIC_CERTAINTY_OPTIONS.
  suitable_for_quiz?: boolean;

  // Prose fields (plain text in memory; serialised to HTML).
  clinical_history: string;                     // soft cap CASE_CLINICAL_HISTORY_MAX.
  case_discussion: string;                      // no explicit cap.

  // Derived — NOT shown in the form, filled in at serialise time.
  source_summary: SummaryPayload;
  output_root: string;
}

/**
 * Study — one per anonymised series, created under a Case. Maps to the body
 * of POST /api/v1/cases/:id/studies.
 */
export interface Study {
  modality: Modality;                           // one of MODALITY_OPTIONS.name.
  // Plane is shown on the Study form for convenience but lives on the Series
  // server-side (as `perspective`, set via the image_preparation series
  // update endpoint). It must NOT be emitted on POST /api/v1/cases/:id/studies
  // — see the wire-contract block at the top of this file.
  plane?: string;                               // free text, suggested: Axial / Coronal / Sagittal / Oblique.
  findings?: string;                            // plain text in memory; HTML at wire.
  position?: number;                            // 1 = discussion; first study = 2.
  caption?: string;                             // plain text.
}

/**
 * Pre-fill a Case form from the anonymise summary + output folder.
 * Now much thinner: modality and findings belong on Study, not Case.
 * Title seeds from the first study's description so the user has
 * something to overwrite.
 */
export function deriveDefaultCase(
  summary: SummaryPayload,
  outputRoot: string,
): Partial<Case> {
  const out: Partial<Case> = {
    source_summary: summary,
    output_root: outputRoot,
  };
  const firstStudy = summary.studies?.[0];
  if (firstStudy?.description) {
    out.title = firstStudy.description.slice(0, CASE_TITLE_MAX);
  }
  return out;
}

/**
 * Pick the default Study.modality for a series based on its DICOM `modality`
 * tag. Returns `null` when we can't confidently map (user has to pick).
 * Mapping is intentionally conservative — only the DICOM codes we
 * actually see coming out of the anonymiser.
 */
export function defaultModalityForSeries(seriesModality: string | null | undefined): Modality | null {
  if (!seriesModality) return null;
  const m = seriesModality.trim().toUpperCase();
  switch (m) {
    case 'CT':   return 'CT';
    case 'MR':
    case 'MRI':  return 'MRI';
    case 'CR':
    case 'DX':
    case 'RG':
    case 'XR':
    case 'X-RAY':
    case 'XA-PLAIN':
      return 'X-ray';
    case 'US':   return 'Ultrasound';
    case 'MG':   return 'Mammography';
    case 'XA':   return 'DSA (angiography)';
    case 'RF':   return 'Fluoroscopy';
    case 'NM':
    case 'PT':
    case 'PET':
      return 'Nuclear medicine';
    case 'SC':
    case 'OT':
      return 'Annotated image';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// HTML helpers — the Radiopaedia API wants HTML for `body` and `findings`.
// We collect plain text in the UI and wrap it at serialise time. Keep these
// exported so both payload builders + any renderer-side preview can use
// the same escaping path.
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPE_MAP[c] ?? c);
}

/**
 * Convert a plain-text blob to HTML:
 *   - split on blank lines (2+ newlines) into paragraphs,
 *   - HTML-escape `&<>` in the content,
 *   - wrap each paragraph in `<p>…</p>`,
 *   - convert remaining single newlines inside a paragraph to `<br />`.
 * Returns an empty string for empty/whitespace-only input (so callers can
 * omit-on-empty cleanly).
 */
export function textToHtml(plain: string): string {
  const trimmed = (plain ?? '').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\n\s*\n+/)
    .map((para) => para.trim())
    .filter((para) => para.length > 0)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Payload builders — the wire-format producers for the Radiopaedia API.
// Both are pure / side-effect-free: they take in-memory shapes and return
// plain JSON-ready objects. Omit undefined / empty fields rather than
// sending nulls (the API is happier that way).
// ---------------------------------------------------------------------------

function setIf<T extends Record<string, unknown>>(
  dst: T,
  key: string,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string' && value.length === 0) return;
  (dst as Record<string, unknown>)[key] = value;
}

/**
 * Body for POST /api/v1/cases. `suitable_for_quiz` is kept when explicitly
 * set (true or false) — users may want to opt out of quiz inclusion. Sex is
 * mapped: M → Male, F → Female, else omitted.
 */
export function buildCaseCreatePayload(c: Case): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  setIf(out, 'title', c.title.trim());
  if (c.system_id != null) out.system_id = c.system_id;
  setIf(out, 'age', c.age?.trim() ?? '');

  if (c.patient_sex === 'M') out.gender = 'Male';
  else if (c.patient_sex === 'F') out.gender = 'Female';
  // 'O' or null → omit.

  setIf(out, 'presentation', c.clinical_history.trim());
  const bodyHtml = textToHtml(c.case_discussion);
  setIf(out, 'body', bodyHtml);

  if (c.diagnostic_certainty_id != null) {
    out.diagnostic_certainty_id = c.diagnostic_certainty_id;
  }
  if (c.suitable_for_quiz !== undefined) {
    out.suitable_for_quiz = !!c.suitable_for_quiz;
  }
  return out;
}

/**
 * Body for POST /api/v1/cases/:id/studies. `position` is required (the
 * caller passes `i + 2` for the i-th study — position 1 is reserved for the
 * case discussion slot).
 */
export function buildStudyCreatePayload(
  s: Study,
  position: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    modality: s.modality,
    position,
  };
  const findingsHtml = textToHtml(s.findings ?? '');
  setIf(out, 'findings', findingsHtml);
  setIf(out, 'caption', s.caption?.trim() ?? '');
  // Plane intentionally omitted: the studies-create permit list is
  // modality/findings/position/caption only. Plane gets sent later as
  // `perspective` on the image_preparation series update — see Study.plane
  // above and the upload-side payload builder when it's added.
  return out;
}
