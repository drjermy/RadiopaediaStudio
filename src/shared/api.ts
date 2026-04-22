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
