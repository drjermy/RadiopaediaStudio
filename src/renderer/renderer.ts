import type {
  Case,
  CompressSpec,
  DeleteSeriesRequest,
  InspectResponse,
  Modality,
  ReformatSpec,
  Series,
  SeriesInfoRequest,
  SeriesInfoResponse,
  SeriesSummary,
  StreamEvent,
  Study,
  StudySummary,
  SummaryPayload,
  ThumbnailsRequest,
  ThumbnailsResponse,
  TransformRequest,
  TrimRequest,
  WindowPresetsResponse,
  WindowSpec,
} from '../shared/api.js';
import {
  CASE_TITLE_MAX,
  MODALITY_OPTIONS,
  SYSTEM_OPTIONS,
  buildCaseCreatePayload,
  buildStudyCreatePayload,
  defaultModalityForSeries,
  deriveDefaultCase,
  perspectiveConfigFor,
} from '../shared/api.js';
import {
  addOrReplaceSentCase,
  buildSentCase,
  capSentCases,
  mergeJobStatuses,
  parseSentCases,
  removeSentCase as removeSentCaseCore,
  type SentCase,
} from '../shared/sent-cases-core.js';
import type { ViewerStateDetail } from './globals';

// Elements ------------------------------------------------------------------
// Pull the null-check once via a helper; every element below is present in
// index.html (required for the renderer to function at all), so any lookup
// miss is a fatal programming error rather than something to defend against
// per-call-site.
function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}
function opt<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const drop = req<HTMLDivElement>('drop');
const btnOpenFolder = opt<HTMLButtonElement>('btn-open-folder');
const panelInspected = req<HTMLDivElement>('panel-inspected');
const panelProcessing = req<HTMLDivElement>('panel-processing');
const panelDone = req<HTMLDivElement>('panel-done');
const panelUpload = req<HTMLDivElement>('panel-upload');
const viewerSection = req<HTMLDivElement>('viewer-section');
const viewerCanvas = req<HTMLDivElement>('viewer-canvas');
const viewerTitle = req<HTMLHeadingElement>('viewer-title');
const viewerHint = req<HTMLDivElement>('viewer-hint');
const viewerStatus = req<HTMLDivElement>('viewer-status');
const btnCloseViewer = req<HTMLButtonElement>('btn-close-viewer');
const btnSaveViewer = req<HTMLButtonElement>('btn-save-viewer');
const viewerPresetSelect = req<HTMLSelectElement>('viewer-preset');
const viewerCompressMode = req<HTMLSelectElement>('viewer-compress-mode');
const viewerCompressRatio = req<HTMLInputElement>('viewer-compress-ratio');
const viewerCompressRatioLabel = req<HTMLLabelElement>('viewer-compress-ratio-label');
const viewerTrim = req<HTMLDivElement>('viewer-trim');
const trimStart = req<HTMLInputElement>('trim-start');
const trimEnd = req<HTMLInputElement>('trim-end');
const trimFill = req<HTMLDivElement>('trim-fill');
const trimLabel = req<HTMLDivElement>('trim-label');
const btnTrim = opt<HTMLButtonElement>('btn-trim');
const log = req<HTMLDivElement>('log-body');
const logModal = req<HTMLDivElement>('log-modal');
const btnLog = req<HTMLButtonElement>('btn-log');
const btnLogClose = req<HTMLButtonElement>('btn-log-close');
const btnLogDone = req<HTMLButtonElement>('btn-log-done');
const btnLogClear = req<HTMLButtonElement>('btn-log-clear');

// Sent-cases modal (#25).
const sentModal = req<HTMLDivElement>('sent-modal');
const sentList = req<HTMLDivElement>('sent-list');
const sentEmpty = req<HTMLParagraphElement>('sent-empty');
const btnSent = req<HTMLButtonElement>('btn-sent');
const btnSentClose = req<HTMLButtonElement>('btn-sent-close');
const btnSentDone = req<HTMLButtonElement>('btn-sent-done');
const btnSentRefreshAll = req<HTMLButtonElement>('btn-sent-refresh-all');

const inspectedTitle = req<HTMLHeadingElement>('inspected-title');
const inspectedSummary = req<HTMLParagraphElement>('inspected-summary');
const inspectedPath = req<HTMLDivElement>('inspected-path');
const processingSummary = req<HTMLParagraphElement>('processing-summary');
const progressBar = req<HTMLProgressElement>('progress-bar');
const progressLabel = req<HTMLSpanElement>('progress-label');
const btnCancelRun = req<HTMLButtonElement>('btn-cancel-run');
const doneTitle = req<HTMLHeadingElement>('done-title');
const btnRevealMain = req<HTMLButtonElement>('btn-reveal-main');
const dropDetails = req<HTMLDetailsElement>('drop-details');
const dropDetailsBody = req<HTMLDivElement>('drop-details-body');
const studySummaryEl = req<HTMLDivElement>('study-summary');

const btnAnonymise = req<HTMLButtonElement>('btn-anonymise');
const btnCancelInspect = req<HTMLButtonElement>('btn-cancel-inspect');
const btnReset = req<HTMLButtonElement>('btn-reset');

// Case metadata form elements.
const caseForm = req<HTMLFormElement>('case-form');
const btnAddCase = req<HTMLButtonElement>('btn-add-case');
const btnUploadBack = req<HTMLButtonElement>('btn-upload-back');
const uploadSeriesListEl = req<HTMLDivElement>('upload-series-list');

// Auth modal + header button.
const btnAuth = req<HTMLButtonElement>('btn-auth');
const authModal = req<HTMLDivElement>('auth-modal');
const authModalTitle = req<HTMLHeadingElement>('auth-modal-title');
const authSignedOut = req<HTMLDivElement>('auth-signed-out');
const authSignedIn = req<HTMLDivElement>('auth-signed-in');
const authProfile = req<HTMLDivElement>('auth-profile');
const btnAuthOpen = req<HTMLButtonElement>('btn-auth-open');
const authOpenError = req<HTMLDivElement>('auth-open-error');
const authCodeInput = req<HTMLInputElement>('auth-code-input');
const btnAuthSubmit = req<HTMLButtonElement>('btn-auth-submit');
const authExchangeError = req<HTMLDivElement>('auth-exchange-error');
const btnAuthSignout = req<HTMLButtonElement>('btn-auth-signout');
const btnAuthClose = req<HTMLButtonElement>('btn-auth-close');
const btnAuthDone = req<HTMLButtonElement>('btn-auth-done');

// Upload-preview modal elements.
const uploadPreview = req<HTMLDivElement>('upload-preview');
const uploadPreviewBlurb = req<HTMLParagraphElement>('upload-preview-blurb');
const uploadPreviewSummary = req<HTMLDivElement>('upload-preview-summary');
const uploadPreviewSteps = req<HTMLOListElement>('upload-preview-steps');
const uploadPreviewProgress = req<HTMLDivElement>('upload-preview-progress');
const uploadProgressBar = req<HTMLProgressElement>('upload-progress-bar');
const uploadProgressText = req<HTMLDivElement>('upload-progress-text');
const uploadPreviewResult = req<HTMLDivElement>('upload-preview-result');
const btnPreviewClose = req<HTMLButtonElement>('btn-preview-close');
const btnPreviewCancel = req<HTMLButtonElement>('btn-preview-cancel');
const btnPreviewSubmit = req<HTMLButtonElement>('btn-preview-submit');
const caseTitle = req<HTMLInputElement>('case-title');
const caseTitleCounter = req<HTMLSpanElement>('case-title-counter');
const caseSystem = req<HTMLSelectElement>('case-system');
const caseValidation = req<HTMLSpanElement>('case-validation');
const btnCaseReady = req<HTMLButtonElement>('btn-case-ready');

// Suppress unused warnings for elements that exist only so we throw early
// if the HTML drifts out of sync with this file.
void inspectedTitle; void inspectedSummary; void inspectedPath;
void caseForm;

// State ---------------------------------------------------------------------
type AppState = 'idle' | 'inspected' | 'processing' | 'done' | 'upload';

interface PendingInspect {
  kind: 'file' | 'folder';
  name: string;
  input: string;
  dicom_count: number;
  total_bytes: number;
  output: string;
}

interface ViewerContext {
  studyIdx: number;
  seriesIdx: number;
  folder: string;
  trimOnly?: boolean;
}

let state: AppState = 'idle';
let pending: PendingInspect | null = null;
let anonOutput: string | null = null;
// Cached auth state. Refreshed on boot, after a successful exchange, and
// after sign-out. The Add-to-Radiopaedia button + the upload pipeline
// pre-flight both read this.
let isAuthed = false;
let windowPresets: WindowPresetsResponse = {};
let studyMeta: SummaryPayload | null = null; // { studies: [{ ..., series: [...] }, ...] }
let viewerContext: ViewerContext | null = null; // { studyIdx, seriesIdx, folder } for Save
let viewerState: ViewerStateDetail | null = null; // latest viewer:state detail
let trimCount = 0;
// Owns the AbortSignal for the currently-running streaming op (anonymise /
// trim / transform / window). Set by the wrapper in each long-running
// function before it calls runStream; the Cancel button calls .abort() on
// it. Cleared on settle (success, error, or cancellation).
let currentAbortController: AbortController | null = null;

// Helpers -------------------------------------------------------------------
function write(msg: string): void {
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  for (let i = 0; i < units.length; i++) {
    if (v < 1024 || i === units.length - 1) return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
    v /= 1024;
  }
  return `${n} B`;
}

function setState(next: AppState): void {
  state = next;
  drop.style.display = next === 'idle' ? '' : 'none';
  if (btnOpenFolder) btnOpenFolder.hidden = next !== 'idle';
  panelInspected.classList.toggle('active', next === 'inspected');
  panelProcessing.classList.toggle('active', next === 'processing');
  panelDone.classList.toggle('active', next === 'done');
  panelUpload.classList.toggle('active', next === 'upload');
  btnReset.hidden = next === 'idle';
  // "Add to Radiopaedia" only shown when we have a finished case AND the
  // user is signed in. Auth state is the gate so users can't get dragged
  // into the OAuth flow mid-upload — the header button drives sign-in
  // before this point.
  btnAddCase.hidden = next !== 'done' || !studyMeta || !anonOutput;
  btnAddCase.disabled = !isAuthed;
  btnAddCase.title = isAuthed
    ? ''
    : 'Sign in to Radiopaedia from the header before uploading.';
  // Cancel button is only meaningful while a run is streaming.
  btnCancelRun.hidden = next !== 'processing' || !currentAbortController;
  if (next === 'upload') renderUploadSeriesList();
}

function basename(p: string | null | undefined): string {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function appendOutputSuffix(basePath: string, suffix: string, kind: 'file' | 'folder'): string {
  if (kind === 'folder') {
    return basePath.replace(/\/+$/, '') + '_' + suffix;
  }
  const slash = basePath.lastIndexOf('/');
  const fname = basePath.slice(slash + 1);
  const dot = fname.lastIndexOf('.');
  if (dot <= 0) return basePath + '_' + suffix;
  const parentDir = basePath.slice(0, slash + 1);
  return parentDir + fname.slice(0, dot) + '_' + suffix + fname.slice(dot);
}

function deriveAnonPath(inputPath: string, kind: 'file' | 'folder'): string {
  return appendOutputSuffix(inputPath, 'anon', kind);
}

async function attachThumbnails(): Promise<void> {
  if (!studyMeta?.studies?.length) return;
  const folders: string[] = [];
  for (const st of studyMeta.studies) {
    for (const se of st.series || []) {
      if (se.folder) folders.push(se.folder);
    }
  }
  if (folders.length === 0) return;
  const port = await window.backend.getPort();
  if (!port) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/thumbnails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders } satisfies ThumbnailsRequest),
    });
    if (!res.ok) return;
    const map = (await res.json()) as ThumbnailsResponse;
    for (const st of studyMeta.studies) {
      for (const se of st.series || []) {
        if (se.folder && map[se.folder]) se.thumbnail = map[se.folder];
      }
    }
  } catch (e) {
    console.warn('[renderer] thumbnail fetch failed:', e);
  }
}

function renderDropDetails(
  aggregateDrops: Map<string, number> | undefined,
  fileCount: number,
  kind: 'file' | 'folder',
): void {
  dropDetailsBody.innerHTML = '';
  if (!aggregateDrops || aggregateDrops.size === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No tags dropped.';
    dropDetailsBody.appendChild(p);
    dropDetails.hidden = false;
    return;
  }
  const rows = [...aggregateDrops.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tag, n] of rows) {
    const row = document.createElement('div');
    row.className = 'drop-row';
    const name = document.createElement('span');
    name.textContent = tag;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = kind === 'folder'
      ? `${n} / ${fileCount}`
      : '';
    row.append(name, count);
    dropDetailsBody.appendChild(row);
  }
  dropDetails.hidden = false;
}

// Streaming runner ----------------------------------------------------------
// sidecar: 'python' (backend/) for everything; 'node' (backend-js/) for /anonymize.
interface RunStreamOpts {
  sidecar?: 'python' | 'node';
  signal?: AbortSignal;
}

interface StreamResult {
  aggregateDrops: Map<string, number>;
  summary?: SummaryPayload;
  count?: number;
  error_count?: number;
  output?: string;
  cancelled?: boolean;
}

async function runStream(
  url: string,
  body: unknown,
  { sidecar = 'python', signal }: RunStreamOpts = {},
): Promise<StreamResult> {
  const getPort = sidecar === 'node' ? window.nodeBackend.getPort : window.backend.getPort;
  const port = await getPort();
  if (!port) throw new Error(`${sidecar} backend not ready`);

  progressBar.value = 0;
  progressBar.removeAttribute('max'); // indeterminate until we get a total
  progressLabel.textContent = '…';

  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status}: ${err}`);
  }
  if (!res.body) throw new Error('no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = 0;
  let total = 0;
  const aggregateDrops = new Map<string, number>();
  let final: Partial<StreamResult> = {};

  const consume = (line: string): void => {
    const evt = JSON.parse(line) as StreamEvent;
    switch (evt.type) {
      case 'start':
        total = evt.total || 0;
        if (total > 0) {
          progressBar.max = total;
          progressBar.value = 0;
          progressLabel.textContent = `0 / ${total}`;
        }
        break;
      case 'total':
        total = evt.total;
        progressBar.max = total;
        progressBar.value = done;
        progressLabel.textContent = `${done} / ${total}`;
        break;
      case 'phase':
        processingSummary.textContent = evt.label + '…';
        break;
      case 'file':
        done += 1;
        if (total > 0) {
          progressBar.value = done;
          progressLabel.textContent = `${done} / ${total}`;
        } else {
          progressLabel.textContent = `${done}`;
        }
        for (const tag of evt.dropped_tags || []) {
          aggregateDrops.set(tag, (aggregateDrops.get(tag) || 0) + 1);
        }
        break;
      case 'error':
        if (evt.input) {
          write(`  error: ${evt.input}: ${evt.error}`);
        } else {
          write(`  error: ${evt.error}`);
        }
        break;
      case 'summary':
        // collected metadata emitted between the last 'file' and 'done'
        final = { ...final, summary: { studies: evt.studies } };
        break;
      case 'done':
        final = {
          ...final,
          count: evt.count,
          error_count: evt.error_count,
          output: evt.output,
        };
        break;
    }
  };

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) consume(line);
      }
    }
    if (buffer.trim()) consume(buffer.trim());
  } catch (e) {
    // AbortError on the reader surfaces when the user clicks Cancel and we
    // call controller.abort(). Treat it as a clean termination: return the
    // partial result with cancelled=true so callers can branch on it
    // without seeing the abort as a thrown error.
    const name = (e as { name?: string })?.name;
    if (name === 'AbortError' || signal?.aborted) {
      write('cancelled');
      return { ...final, aggregateDrops, cancelled: true };
    }
    throw e;
  }
  return { ...final, aggregateDrops };
}

// Viewer --------------------------------------------------------------------
interface OpenViewerOpts {
  trimOnly?: boolean;
}

async function openViewerForSeries(
  studyIdx: number,
  seriesIdx: number,
  opts: OpenViewerOpts = {},
): Promise<void> {
  const { trimOnly = false } = opts;
  const st = studyMeta?.studies?.[studyIdx];
  const se = st?.series?.[seriesIdx];
  if (!se?.folder) return;
  if (!window.viewerAPI?.open) {
    write('viewer bundle not loaded');
    return;
  }
  viewerContext = { studyIdx, seriesIdx, folder: se.folder, trimOnly };
  refreshActiveThumbnail();
  viewerState = null;
  viewerTitle.textContent = trimOnly
    ? `Trim — ${se.description || `Series ${seriesIdx + 1}`}`
    : (se.description || `Series ${seriesIdx + 1}`);
  viewerHint.textContent = 'scroll page · drag W/L · middle pan · right zoom · A/C/S orient · [/] thickness ±1mm · ⇧[/] spacing ±1mm · space reset';
  viewerSection.hidden = false;
  viewerSection.classList.toggle('trim-only', trimOnly);
  await setupTrim(se);
  viewerSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    await window.viewerAPI.open(se.folder, viewerCanvas, {
      // Trim operates on source-slice indices — stack mode makes that trivial
      // (slider tick = file index) and sidesteps the volume-viewport oddities
      // that made trim feel glitchy.
      forceStack: trimOnly,
      sliceThickness: se.slice_thickness,
      sliceSpacing: se.slice_spacing,
      sliceCount: se.slice_count,
      orientation: se.orientation,
      windowCenter: se.window_center,
      windowWidth:  se.window_width,
    });
  } catch (e) {
    write(`viewer error: ${(e as Error).message || e}`);
    closeViewer();
  }
}

async function setupTrim(series: SeriesSummary | undefined): Promise<void> {
  // Only show trim on multi-slice series.
  if (!series?.slice_count || series.slice_count < 2) {
    trimCount = 0;
    return;
  }
  trimCount = series.slice_count;
  trimStart.min = trimEnd.min = '0';
  trimStart.max = trimEnd.max = String(trimCount - 1);
  trimStart.value = '0';
  trimEnd.value = String(trimCount - 1);
  updateTrimUI();
  // Visibility is owned by the viewer:state listener (depends on
  // orientation + native), so don't unhide here.
}

function currentTrim(): { start: number; end: number } | null {
  if (viewerTrim.hidden || !trimCount) return null;
  const start = parseInt(trimStart.value, 10) || 0;
  const end = parseInt(trimEnd.value, 10) || 0;
  if (start === 0 && end === trimCount - 1) return null; // untouched
  return { start, end };
}

function updateTrimUI(): void {
  const s = parseInt(trimStart.value, 10) || 0;
  const e = parseInt(trimEnd.value, 10) || 0;
  // Enforce start ≤ end
  if (s > e) {
    if (document.activeElement === trimStart) {
      trimEnd.value = String(s);
    } else {
      trimStart.value = String(e);
    }
  }
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  const loPct = (lo / (trimCount - 1)) * 100;
  const hiPct = (hi / (trimCount - 1)) * 100;
  trimFill.style.left = `${loPct}%`;
  trimFill.style.right = `${100 - hiPct}%`;
  const kept = hi - lo + 1;
  const sameAsFull = lo === 0 && hi === trimCount - 1;
  trimLabel.textContent = sameAsFull
    ? `All ${trimCount} slices`
    : `Slices ${lo + 1}–${hi + 1} of ${trimCount}  ·  keeping ${kept}`;
  updateTrimButtonState();
}

// Trim only makes sense when slider indices correspond to source slice
// indices — stack mode always, volume mode only when we're in the
// acquisition orientation at native thickness/spacing.
function updateTrimButtonState(): void {
  if (!btnTrim) return;
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  const moved = !(lo === 0 && hi === trimCount - 1);
  const vs = viewerState;
  const indicesAreSourceSlices = vs
    && (!vs.isVolume || (vs.isVolume && vs.isAtNative));
  btnTrim.disabled = !moved || !indicesAreSourceSlices || !viewerContext?.folder;
}

function pushTrimRangeToViewer(): void {
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  // Only constrain the viewer when the user has actually moved off the
  // edges — otherwise "full range" is a no-op anyway.
  const active = !(lo === 0 && hi === trimCount - 1);
  window.viewerAPI?.setTrimRange?.(active ? { start: lo, end: hi } : null);
}

trimStart.addEventListener('input', () => {
  updateTrimUI();
  pushTrimRangeToViewer();
  window.viewerAPI?.goToSlice?.(parseInt(trimStart.value, 10));
});
trimEnd.addEventListener('input', () => {
  updateTrimUI();
  pushTrimRangeToViewer();
  window.viewerAPI?.goToSlice?.(parseInt(trimEnd.value, 10));
});

btnTrim?.addEventListener('click', async () => {
  if (!btnTrim || btnTrim.disabled || !viewerContext?.folder || viewerContext.studyIdx == null) return;
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  if (!(hi > lo)) return;
  const { folder, studyIdx } = viewerContext;
  // `studyIdx` is destructured for parity with the JS original (may be used
  // by future code); reference it once to keep TS noUnusedLocals quiet if
  // that flag is ever enabled.
  void studyIdx;
  const label = `trim-${lo + 1}-${hi + 1}`;
  const output = appendOutputSuffix(folder, label, 'folder');
  btnTrim.disabled = true;
  processingSummary.textContent = `Trimming → ${basename(output)}`;
  currentAbortController = new AbortController();
  setState('processing');
  try {
    const trimReq: TrimRequest = { input: folder, output, start: lo, end: hi };
    const result = await runStream('/trim', trimReq,
      { signal: currentAbortController.signal });
    if (result.cancelled) {
      closeViewer();
      setState('idle');
      return;
    }
    // Close the viewer first — Cornerstone's image cache still holds
    // references to the pre-trim stack; reopening on the new folder while
    // the cache is live was only loading the first few slices.
    closeViewer();
    // Rescan the root so studyMeta matches what the next click on the
    // new thumbnail will get — appendNewSeries alone leaves the summary
    // slightly out of sync with a full scan.
    if (anonOutput) await loadFolder(anonOutput);
    write(`trimmed ${label}`);
  } catch (e) {
    write(`trim failed: ${(e as Error).message || e}`);
    setState('done');
    updateTrimButtonState();
  } finally {
    currentAbortController = null;
  }
});

function closeViewer(): void {
  if (window.viewerAPI?.close) window.viewerAPI.close();
  viewerCanvas.innerHTML = '';
  viewerStatus.innerHTML = '';
  viewerTrim.hidden = true;
  viewerSection.hidden = true;
  viewerSection.classList.remove('trim-only');
  viewerContext = null;
  viewerState = null;
  refreshActiveThumbnail();
}

// Drive the thumbnail's .active class from viewerContext. Cheaper than
// a full renderStudySummary rebuild.
function refreshActiveThumbnail(): void {
  const active = viewerContext;
  for (const li of Array.from(studySummaryEl.querySelectorAll<HTMLLIElement>('.series-list li'))) {
    const match = active
      && String(active.studyIdx)  === li.dataset.studyIdx
      && String(active.seriesIdx) === li.dataset.seriesIdx;
    li.classList.toggle('active', !!match);
  }
}

async function saveViewerAsVersion(): Promise<void> {
  if (!viewerContext || !viewerState) return;
  const { studyIdx, folder } = viewerContext;
  const { isVolume, orientation, slabThickness, slabSpacing, center, width } = viewerState;

  const spec: {
    reformat?: ReformatSpec;
    window?: WindowSpec;
    compress?: CompressSpec;
  } = {};
  const suffixParts: string[] = [];
  // Only include a reformat if the user actually moved off the native
  // defaults. Otherwise saving from a CT opened axial at native thickness
  // would produce a meaningless "same series, new UIDs" reformat — and
  // with slab/spacing wrong during the initial first-render flash, would
  // explode file counts.
  if (isVolume && orientation && slabThickness && slabSpacing && !viewerState.isDefaultView) {
    const t = Math.round(slabThickness * 10) / 10;
    const s = Math.round(slabSpacing * 10) / 10;
    spec.reformat = {
      orientation,
      thickness: t,
      spacing: s,
      mode: 'avg',
    };
    suffixParts.push(`${orientation}-${t}-${s}mm`);
  }
  if (center != null && width != null && !viewerState.isDefaultVOI) {
    spec.window = { center: Math.round(center), width: Math.round(width) };
    suffixParts.push(`W${Math.round(center)}-${Math.round(width)}`);
  }

  const cmode = viewerCompressMode.value;
  const cratio = parseFloat(viewerCompressRatio.value);
  if (cmode === 'lossless') {
    spec.compress = { mode: 'lossless' };
    suffixParts.push('j2k');
  } else if (cmode === 'lossy' && Number.isFinite(cratio) && cratio > 1) {
    spec.compress = { mode: 'lossy', ratio: cratio };
    suffixParts.push(`j2k-${cratio}`);
  }

  const trim = currentTrim();
  if (trim) suffixParts.push(`trim-${trim.start + 1}-${trim.end + 1}`);

  if (!spec.reformat && !spec.window && !spec.compress && !trim) {
    write('nothing to save — adjust orientation, slab, window, compression, or trim first');
    return;
  }

  const suffix = suffixParts.join('-') || 'copy';
  const output = appendOutputSuffix(folder, suffix, 'folder');

  processingSummary.textContent = `Saving ${suffix} version → ${basename(output)}`;
  currentAbortController = new AbortController();
  setState('processing');

  try {
    const signal = currentAbortController.signal;
    let result: StreamResult;
    if (trim && !spec.reformat && !spec.window && !spec.compress) {
      // Trim only — fast path via /trim (copy subset with fresh UIDs)
      const trimReq: TrimRequest = {
        input: folder, output, start: trim.start, end: trim.end,
      };
      result = await runStream('/trim', trimReq, { signal });
    } else if (trim) {
      // Combining trim with other ops isn't supported yet — fall through
      // to /transform with the other ops and drop the trim, with a warning.
      write('note: trim is not combined with other ops yet — saved without trim');
      const tReq: TransformRequest = { input: folder, output, ...spec };
      result = await runStream('/transform', tReq, { signal });
    } else {
      const tReq: TransformRequest = { input: folder, output, ...spec };
      result = await runStream('/transform', tReq, { signal });
    }
    if (result.cancelled) {
      setState('done');
      return;
    }
    await appendNewSeries(output, suffix, studyIdx);
    setState('done');
    write(`saved ${suffix}`);
  } catch (e) {
    write(`save failed: ${(e as Error).message || e}`);
    setState('done');
  } finally {
    currentAbortController = null;
  }
}

btnCloseViewer.addEventListener('click', closeViewer);
btnSaveViewer.addEventListener('click', saveViewerAsVersion);

function fmtMm(mm: number): string {
  return (Math.round(mm * 10) / 10).toString().replace(/\.0$/, '');
}

// Always show thickness/spacing as the slash form ("3/3 mm", "5/2 mm").
// Append "(native)" when both are at the per-orientation floor.
function thicknessLabel(
  { slabThickness, slabSpacing, isAtNative }:
  { slabThickness: number; slabSpacing: number; isAtNative: boolean },
): string {
  const base = `${fmtMm(slabThickness)}/${fmtMm(slabSpacing)} mm`;
  return isAtNative ? `${base} (native)` : base;
}

document.addEventListener('viewer:state', (e) => {
  viewerState = e.detail;
  const { isVolume, orientation, slabThickness, slabSpacing,
          sourceThickness, sourceSpacing, trimApplicable, isAtNative,
          center, width } = e.detail;
  // Trim slider is only for trim-only mode (opened via the scissors
  // button on the thumbnail). Hidden during normal viewing.
  const showTrim = !!viewerContext?.trimOnly && trimCount >= 2 && trimApplicable;
  viewerTrim.hidden = !showTrim;
  updateTrimButtonState();
  const bits: string[] = [];
  if (isVolume) {
    if (orientation) bits.push(`<span class="k">View</span><span class="v">${orientation}</span>`);
    if (slabThickness != null && slabSpacing != null) {
      bits.push(`<span class="k">Thickness</span><span class="v">${thicknessLabel({ slabThickness, slabSpacing, isAtNative })}</span>`);
    }
    // Predicted slice count for the slab settings in play. Mirrors the
    // formula the backend reformat uses, so the user sees the size of
    // the series that Save would produce before committing.
    if (e.detail.predictedSliceCount != null) {
      bits.push(`<span class="k">Slices</span><span class="v">${e.detail.predictedSliceCount}</span>`);
    }
  } else {
    bits.push('<span class="k">Mode</span><span class="v">stack</span>');
    // Stack mode (typically a derived series) — the volume controls aren't
    // active, but the source thickness/spacing are still known and worth
    // showing so the user can tell what they're looking at.
    if (sourceThickness != null) {
      bits.push(`<span class="k">Thickness</span><span class="v">${thicknessLabel({ slabThickness: sourceThickness, slabSpacing: sourceSpacing ?? sourceThickness, isAtNative: true })}</span>`);
    }
  }
  if (center != null && width != null) {
    bits.push(`<span class="k">W/L</span><span class="v">${Math.round(center)} / ${Math.round(width)}</span>`);
  }
  viewerStatus.innerHTML = bits.map((b) => `<span>${b}</span>`).join('');
});

function setStudyCollapsed(studyIdx: number, collapsed: boolean): void {
  const block = studySummaryEl.querySelector<HTMLDivElement>(
    `.study-block[data-study-idx="${studyIdx}"]`,
  );
  if (block) block.classList.toggle('collapsed', collapsed);
}
void setStudyCollapsed; // exported implicitly via future use; keeps parity with JS

function renderStudySummary(): void {
  studySummaryEl.innerHTML = '';
  if (!studyMeta?.studies?.length) {
    studySummaryEl.hidden = true;
    return;
  }
  studySummaryEl.hidden = false;

  for (let si = 0; si < studyMeta.studies.length; si++) {
    const st: StudySummary = studyMeta.studies[si];
    const block = document.createElement('div');
    block.className = 'study-block';
    block.dataset.studyIdx = String(si);

    const headParts: string[] = [];
    if (st.modality) headParts.push(st.modality);
    if (st.body_part) headParts.push(st.body_part);
    if (st.description) headParts.push(st.description);
    const headerText = headParts.join(' · ') || `Study ${si + 1}`;

    const metaBits: string[] = [];
    if (st.study_date) metaBits.push(st.study_date);
    metaBits.push(`${st.series_count} series`);
    metaBits.push(`${st.total_slices} slice${st.total_slices === 1 ? '' : 's'}`);
    if (st.total_bytes) metaBits.push(humanBytes(st.total_bytes));

    const header = document.createElement('button');
    header.className = 'study-header';
    header.type = 'button';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = '▾';
    const label = document.createElement('span');
    label.textContent = headerText;
    const metaEl = document.createElement('span');
    metaEl.className = 'study-meta';
    metaEl.textContent = metaBits.join(' · ');
    header.append(twisty, label, metaEl);
    header.addEventListener('click', () => {
      block.classList.toggle('collapsed');
    });
    block.appendChild(header);

    const body = document.createElement('div');
    body.className = 'study-body';

    if (st.series?.length) {
      const ul = document.createElement('ul');
      ul.className = 'series-list';
      for (let i = 0; i < st.series.length; i++) {
        const se = st.series[i];
        const li = document.createElement('li');
        li.dataset.studyIdx = String(si);
        li.dataset.seriesIdx = String(i);
        if (viewerContext
            && viewerContext.studyIdx === si
            && viewerContext.seriesIdx === i) {
          li.classList.add('active');
        }
        // Thumbnails are clickable — they open the viewer. The "+" card
        // is still the only way to create a new derived series.
        if (se.folder) {
          li.classList.add('viewable');
          li.addEventListener('click', () => openViewerForSeries(si, i));
        }

        if (se.thumbnail) {
          const img = document.createElement('img');
          img.className = 'thumb';
          img.src = se.thumbnail;
          img.alt = se.description || 'series preview';
          li.appendChild(img);
        } else {
          const ph = document.createElement('div');
          ph.className = 'thumb-placeholder';
          li.appendChild(ph);
        }

        if (se.folder) {
          const del = document.createElement('button');
          del.className = 'series-delete';
          del.type = 'button';
          del.title = 'Delete this series from disk';
          del.setAttribute('aria-label', 'Delete series');
          del.textContent = '×';
          del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void deleteSeries(si, i);
          });
          li.appendChild(del);
        }

        if (se.folder && se.slice_count >= 2) {
          const trimBtn = document.createElement('button');
          trimBtn.className = 'series-trim-btn';
          trimBtn.type = 'button';
          trimBtn.title = 'Trim this series';
          trimBtn.setAttribute('aria-label', 'Trim series');
          trimBtn.textContent = '✂'; // scissors
          trimBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void openViewerForSeries(si, i, { trimOnly: true });
          });
          li.appendChild(trimBtn);
        }

        const desc = document.createElement('div');
        desc.className = 'series-desc';
        desc.textContent = se.description || '(no description)';
        // Modality is already shown in the study-block header — no need to
        // repeat it here. Compression status lives in the top-left badge
        // on the thumbnail (LOSSLESS / LOSSY pill below).
        const tech: string[] = [];
        if (se.orientation) tech.push(se.orientation);
        if (se.slice_thickness != null) {
          // "3/2 mm" when slices abut or overlap (spacing ≤ thickness),
          // "3+0.5 mm" when there's a gap (spacing > thickness, common in MRI).
          // Slash means thickness/spacing; plus means thickness + gap.
          const th = se.slice_thickness;
          const sp = se.slice_spacing;
          if (sp == null) tech.push(`${fmtMm(th)} mm`);
          else if (sp > th + 0.01) tech.push(`${fmtMm(th)}+${fmtMm(sp - th)} mm`);
          else tech.push(`${fmtMm(th)}/${fmtMm(sp)} mm`);
        }
        tech.push(`${se.slice_count} slice${se.slice_count === 1 ? '' : 's'}`);
        const meta = document.createElement('div');
        meta.className = 'series-meta';
        meta.textContent = tech.join(' · ');

        const sizeBits: string[] = [];
        if (se.total_bytes != null) {
          sizeBits.push(humanBytes(se.total_bytes));
          if (se.slice_count > 0) {
            sizeBits.push(`${humanBytes(se.total_bytes / se.slice_count)}/slice`);
          }
        }
        const size = document.createElement('div');
        size.className = 'series-meta';
        size.textContent = sizeBits.join(' · ');

        li.append(desc, meta, size);

        // Compression pill on the thumbnail. Always present so the user
        // can see the status at a glance — neutral grey for lossless,
        // amber for lossy, muted dim grey for uncompressed.
        const ts = se.transfer_syntax;
        if (ts) {
          const pill = document.createElement('span');
          if (!ts.compressed) {
            pill.className = 'compression-tag uncompressed';
            pill.textContent = 'UNCOMPRESSED';
          } else if (ts.lossy) {
            pill.className = 'compression-tag lossy';
            pill.textContent = 'LOSSY';
          } else {
            pill.className = 'compression-tag';
            pill.textContent = 'LOSSLESS';
          }
          li.appendChild(pill);
        }

        ul.appendChild(li);
      }

      body.appendChild(ul);
    }
    block.appendChild(body);
    studySummaryEl.appendChild(block);
  }
}

// Upload-view: grouped by DICOM study -----------------------------------------
// One block per DICOM study with a single Modality picker at the top
// (Radiopaedia's data model: modality lives on the Study). Each child series
// row carries a checkbox + thumbnail + meta + per-series perspective and
// specifics inputs (typeahead suggestions and field labels track the parent
// study's modality — see PERSPECTIVE_MODALITIES).
function renderUploadSeriesList(): void {
  uploadSeriesListEl.innerHTML = '';
  if (!studyMeta?.studies?.length) return;

  for (let si = 0; si < studyMeta.studies.length; si++) {
    const st = studyMeta.studies[si];
    const seriesWithFolder = (st.series ?? []).filter((s) => s.folder);
    if (seriesWithFolder.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'upload-study-group';
    group.dataset.studyKey = studyKeyFor(st) ?? '';

    // Header row: human study label + Modality picker. The header stays put
    // across modality changes so the user keeps keyboard focus on the select;
    // only the series rows beneath it re-render.
    const header = document.createElement('div');
    header.className = 'upload-study-header';

    const titleParts: string[] = [];
    if (st.description) titleParts.push(st.description);
    if (st.body_part) titleParts.push(st.body_part);
    if (st.study_date) titleParts.push(st.study_date);
    const title = document.createElement('div');
    title.className = 'upload-study-title';
    title.textContent = titleParts.join(' · ') || `Study ${si + 1}`;
    header.appendChild(title);

    const modLabel = document.createElement('label');
    modLabel.className = 'upload-study-modality';
    modLabel.textContent = 'Modality';
    const modSelect = document.createElement('select');
    modSelect.className = 'study-modality';
    {
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '(pick modality)';
      modSelect.appendChild(blank);
    }
    for (const m of MODALITY_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      modSelect.appendChild(opt);
    }
    modSelect.value = getStudyModality(st);
    modLabel.appendChild(modSelect);
    header.appendChild(modLabel);
    group.appendChild(header);

    // Series rows live in their own container so we can rebuild just this
    // chunk on modality change, leaving the header (and any other groups)
    // untouched.
    const rows = document.createElement('div');
    rows.className = 'upload-series-rows';
    fillSeriesRows(rows, seriesWithFolder, getStudyModality(st));
    group.appendChild(rows);

    modSelect.addEventListener('change', () => {
      setStudyModality(st, modSelect.value as Modality | '');
      fillSeriesRows(rows, seriesWithFolder, getStudyModality(st));
      refreshCaseFormUI();
      persistCaseDraft();
    });

    uploadSeriesListEl.appendChild(group);
  }
}

function fillSeriesRows(
  container: HTMLDivElement,
  seriesList: SeriesSummary[],
  modality: Modality | '',
): void {
  container.innerHTML = '';
  const config = perspectiveConfigFor(modality);
  for (const se of seriesList) {
    container.appendChild(buildUploadSeriesRow(se, config));
  }
}

function buildUploadSeriesRow(
  se: SeriesSummary,
  config: ReturnType<typeof perspectiveConfigFor>,
): HTMLDivElement {
  const folder = se.folder!;
  const row = document.createElement('div');
  row.className = 'upload-series-row';
  row.dataset.folder = folder;
  const selected = isFolderSelected(folder);
  row.classList.toggle('unselected', !selected);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'upload-row-check';
  check.checked = selected;
  check.addEventListener('change', () => {
    if (check.checked) deselectedFolders.delete(folder);
    else deselectedFolders.add(folder);
    row.classList.toggle('unselected', !check.checked);
    refreshCaseFormUI();
    persistCaseDraft();
  });
  row.appendChild(check);

  if (se.thumbnail) {
    const img = document.createElement('img');
    img.className = 'upload-row-thumb';
    img.src = se.thumbnail;
    img.alt = se.description || 'series preview';
    row.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'upload-row-thumb-placeholder';
    row.appendChild(ph);
  }

  const body = document.createElement('div');
  body.className = 'upload-row-body';

  const desc = document.createElement('div');
  desc.className = 'upload-row-desc';
  desc.textContent = se.description || '(no description)';
  body.appendChild(desc);

  // Meta line 1: orientation, slice thickness/spacing, count.
  const tech: string[] = [];
  if (se.orientation) tech.push(se.orientation);
  if (se.slice_thickness != null) {
    const th = se.slice_thickness;
    const sp = se.slice_spacing;
    if (sp == null) tech.push(`${fmtMm(th)} mm`);
    else if (sp > th + 0.01) tech.push(`${fmtMm(th)}+${fmtMm(sp - th)} mm`);
    else tech.push(`${fmtMm(th)}/${fmtMm(sp)} mm`);
  }
  tech.push(`${se.slice_count} slice${se.slice_count === 1 ? '' : 's'}`);
  if (tech.length) {
    const meta = document.createElement('div');
    meta.className = 'upload-row-meta';
    meta.textContent = tech.join(' · ');
    body.appendChild(meta);
  }

  // Meta line 2: stack size, per-slice size, transfer syntax.
  const sizeBits: string[] = [];
  if (se.total_bytes != null) {
    sizeBits.push(humanBytes(se.total_bytes));
    if (se.slice_count > 0) {
      sizeBits.push(`${humanBytes(se.total_bytes / se.slice_count)}/slice`);
    }
  }
  if (se.transfer_syntax?.name) sizeBits.push(se.transfer_syntax.name);
  if (sizeBits.length) {
    const size = document.createElement('div');
    size.className = 'upload-row-meta';
    size.textContent = sizeBits.join(' · ');
    body.appendChild(size);
  }

  // Perspective + specifics inputs — labels and suggestions track the
  // parent study's modality. Both are free-text typeaheads via <datalist>.
  const fields = document.createElement('div');
  fields.className = 'series-fields';
  fields.appendChild(buildTypeaheadInput({
    label: config.perspective_label,
    className: 'series-perspective',
    options: config.perspectives,
    value: getSeriesField(folder, 'perspective') ?? defaultPerspectiveFor(se),
    onChange: (v) => {
      const cur = seriesByFolder.get(folder) ?? {};
      seriesByFolder.set(folder, { ...cur, perspective: v });
      persistCaseDraft();
    },
  }));
  if (config.specifics_label) {
    fields.appendChild(buildTypeaheadInput({
      label: config.specifics_label,
      className: 'series-specifics',
      options: config.specifics,
      value: getSeriesField(folder, 'specifics') ?? '',
      onChange: (v) => {
        const cur = seriesByFolder.get(folder) ?? {};
        seriesByFolder.set(folder, { ...cur, specifics: v });
        persistCaseDraft();
      },
    }));
  }
  body.appendChild(fields);

  row.appendChild(body);
  return row;
}

function getSeriesField(folder: string, field: 'perspective' | 'specifics'): string | undefined {
  return seriesByFolder.get(folder)?.[field];
}

function defaultPerspectiveFor(se: SeriesSummary): string {
  return se.orientation ? titleCase(se.orientation) : '';
}

interface TypeaheadOpts {
  label: string;
  className: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}
// Custom typeahead: <input> + click-to-open suggestion menu. Built instead
// of a native <datalist> because datalist on Chromium needs two clicks to
// open, can't be CSS-styled (popup uses OS rendering, often appears bold),
// and can't be programmatically opened reliably. The input still accepts
// any text — choosing a suggestion just fills it in.
function buildTypeaheadInput(opts: TypeaheadOpts): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'series-field';
  const span = document.createElement('span');
  span.className = 'series-field-label';
  span.textContent = opts.label;
  label.appendChild(span);

  const wrap = document.createElement('div');
  wrap.className = 'typeahead-wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = opts.className;
  input.value = opts.value;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => {
    opts.onChange(input.value);
    if (opts.options.length) renderMenu(input.value);
  });
  wrap.appendChild(input);

  if (!opts.options.length) {
    label.appendChild(wrap);
    return label;
  }

  const chevron = document.createElement('button');
  chevron.type = 'button';
  chevron.className = 'typeahead-chevron';
  chevron.tabIndex = -1;
  chevron.setAttribute('aria-label', 'Show suggestions');
  chevron.textContent = '▾';
  wrap.appendChild(chevron);

  const menu = document.createElement('div');
  menu.className = 'typeahead-menu';
  menu.hidden = true;
  wrap.appendChild(menu);

  function renderMenu(filter: string): void {
    menu.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const matches = q
      ? opts.options.filter((o) => o.toLowerCase().includes(q))
      : opts.options;
    if (matches.length === 0) {
      menu.hidden = true;
      return;
    }
    for (const o of matches) {
      const item = document.createElement('div');
      item.className = 'typeahead-item';
      item.textContent = o;
      item.addEventListener('mousedown', (e) => {
        // mousedown (not click) so we beat the input's blur which would hide
        // the menu before the click registers.
        e.preventDefault();
        input.value = o;
        opts.onChange(o);
        menu.hidden = true;
        input.focus();
      });
      menu.appendChild(item);
    }
    menu.hidden = false;
  }

  function open(): void {
    renderMenu(input.value);
  }
  function close(): void {
    menu.hidden = true;
  }

  chevron.addEventListener('mousedown', (e) => {
    // Toggle on chevron press without stealing focus from the input.
    e.preventDefault();
    if (menu.hidden) {
      input.focus();
      open();
    } else {
      close();
    }
  });
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => {
    // Defer so a click on a menu item lands first.
    setTimeout(close, 100);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  label.appendChild(wrap);
  return label;
}

function titleCase(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// Inspect -------------------------------------------------------------------
async function inspect(inputPath: string): Promise<void> {
  const port = await window.backend.getPort();
  if (!port) { write('error: backend not ready'); return; }
  const res = await fetch(`http://127.0.0.1:${port}/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputPath }),
  });
  if (!res.ok) {
    const body = await res.text();
    write(`inspect failed ${res.status}: ${body}`);
    return;
  }
  const info = (await res.json()) as InspectResponse;
  if (info.dicom_count === 0) {
    write(`no .dcm files found in ${inputPath}`);
    return;
  }

  pending = { ...info, output: deriveAnonPath(inputPath, info.kind) };
  // Auto-anonymise — skip the Inspected confirmation panel. Size/count
  // is shown in the Processing panel's summary line.
  runAnonymise();
}

// Anonymise -----------------------------------------------------------------
async function runAnonymise(): Promise<void> {
  if (!pending) return;
  processingSummary.textContent = pending.kind === 'folder'
    ? `Anonymising & analysing ${pending.dicom_count} files → ${basename(pending.output)}`
    : `Anonymising & analysing ${pending.name} → ${basename(pending.output)}`;
  currentAbortController = new AbortController();
  setState('processing');

  try {
    const result = await runStream('/anonymize',
      { input: pending.input, output: pending.output },
      { sidecar: 'node', signal: currentAbortController.signal });

    if (result.cancelled) {
      setState('idle');
      return;
    }

    anonOutput = result.output ?? null;
    studyMeta = result.summary || null;

    // Node doesn't render thumbnails — ask Python to do a batch pass on the
    // anonymised series folders, then merge results into the summary.
    await attachThumbnails();

    renderStudySummary();

    const count = result.count ?? 0;
    const errorCount = result.error_count ?? 0;
    doneTitle.textContent = errorCount > 0
      ? `Anonymised — ${count} written, ${errorCount} failed`
      : `Anonymised — ${count} file${count === 1 ? '' : 's'} written`;
    renderDropDetails(result.aggregateDrops, count, pending.kind);
    hydrateCaseForm(studyMeta, anonOutput);
    setState('done');
    // Remember the anonymised output so Cmd+R reloads it without re-running.
    if (result.output) persistLastFolder(result.output);
  } catch (e) {
    write(`error: ${(e as Error).message || e}`);
    setState('inspected');
  } finally {
    currentAbortController = null;
  }
}

// Load (read-only) ----------------------------------------------------------
async function loadFolder(folderPath: string): Promise<void> {
  const port = await window.backend.getPort();
  if (!port) { write('backend not ready'); return; }
  processingSummary.textContent = `Scanning ${basename(folderPath)}…`;
  setState('processing');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: folderPath }),
    });
    if (!res.ok) throw new Error(await res.text());
    const summary = (await res.json()) as SummaryPayload;
    studyMeta = summary;
    anonOutput = folderPath;
    renderStudySummary();
    const nSeries = summary.studies?.reduce((a, s) => a + (s.series?.length ?? 0), 0) ?? 0;
    const nStudies = summary.studies?.length ?? 0;
    doneTitle.textContent = `Loaded ${nSeries} series from ${basename(folderPath)}`;
    // No drop-details for load — nothing was dropped/scrubbed.
    dropDetails.hidden = true;
    hydrateCaseForm(studyMeta, anonOutput);
    setState('done');
    persistLastFolder(folderPath);
    write(
      `loaded folder: ${folderPath} (${nStudies} stud${nStudies === 1 ? 'y' : 'ies'}, ${nSeries} series)`,
    );
  } catch (e) {
    write(`load failed: ${(e as Error).message || e}`);
    setState('idle');
  }
}

const LAST_FOLDER_KEY = 'radiopaedia-studio:last-folder';

function persistLastFolder(folder: string): void {
  try { sessionStorage.setItem(LAST_FOLDER_KEY, folder); } catch { /* ignore */ }
}

async function restoreLastFolder(): Promise<void> {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(LAST_FOLDER_KEY); } catch { /* ignore */ }
  if (!saved) return;
  // Soft-reload: if the folder vanished between sessions, loadFolder's
  // /scan call will fail cleanly and we fall back to idle.
  await loadFolder(saved);
}

async function appendNewSeries(
  folder: string,
  label: string,
  studyIdx: number | null | undefined,
): Promise<void> {
  if (studyIdx == null || !studyMeta?.studies?.[studyIdx]) return;
  const port = await window.backend.getPort();
  if (!port) return;
  try {
    const infoReq: SeriesInfoRequest = { folder, label };
    const res = await fetch(`http://127.0.0.1:${port}/series-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(infoReq),
    });
    if (!res.ok) return;
    const info = (await res.json()) as SeriesInfoResponse;
    const st = studyMeta.studies[studyIdx];
    // /series-info's response is a partial SeriesSummary (some fields only
    // exist once the file has been scrubbed) — coerce to the full shape
    // with sensible defaults for anything missing.
    const next: SeriesSummary = {
      description: info.description || label,
      modality: info.modality ?? null,
      orientation: info.orientation ?? null,
      slice_thickness: info.slice_thickness ?? null,
      slice_spacing: info.slice_spacing ?? null,
      slice_count: info.slice_count,
      total_bytes: info.total_bytes,
      transfer_syntax: info.transfer_syntax ?? { uid: null, name: null, compressed: false, lossy: false },
      folder: info.folder,
      thumbnail: info.thumbnail,
      window_center: info.window_center,
      window_width:  info.window_width,
      operation: label,
    };
    st.series.push(next);
    if (info.total_bytes) st.total_bytes = (st.total_bytes || 0) + info.total_bytes;
    st.series_count = st.series.length;
    st.total_slices = (st.total_slices || 0) + (info.slice_count || 0);
    // Seed default perspective for the newly-appended derived series so the
    // user doesn't have to retype Axial/Coronal/etc. Modality is per-study
    // and doesn't need re-seeding when adding to an existing study.
    if (next.folder && !seriesByFolder.has(next.folder) && next.orientation) {
      seriesByFolder.set(next.folder, { perspective: titleCase(next.orientation) });
    }
    renderStudySummary();
    refreshCaseFormUI();
  } catch (e) {
    console.warn('[renderer] series-info fetch failed:', e);
  }
}

async function deleteSeries(studyIdx: number, seriesIdx: number): Promise<void> {
  const st = studyMeta?.studies?.[studyIdx];
  const se = st?.series?.[seriesIdx];
  if (!st || !se?.folder) return;
  const label = se.description || `Series ${seriesIdx + 1}`;
  if (!confirm(`Delete "${label}" and its ${se.slice_count ?? '?'} files from disk?\n\n${se.folder}`)) return;
  // Close viewer first if it's showing the series we're about to delete —
  // otherwise Cornerstone holds file handles and the folder can't be removed.
  if (viewerContext?.folder === se.folder) closeViewer();
  const port = await window.backend.getPort();
  if (!port) { write('backend not ready'); return; }
  if (!anonOutput) { write('no anonymise root known; refusing to delete'); return; }
  try {
    const delReq: DeleteSeriesRequest = { folder: se.folder, allowed_parent: anonOutput };
    const res = await fetch(`http://127.0.0.1:${port}/delete-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(delReq),
    });
    if (!res.ok) throw new Error(await res.text());
    // Mutate the study summary and re-render.
    st.series.splice(seriesIdx, 1);
    st.series_count = st.series.length;
    if (se.total_bytes) st.total_bytes = Math.max(0, (st.total_bytes || 0) - se.total_bytes);
    if (se.slice_count) st.total_slices = Math.max(0, (st.total_slices || 0) - se.slice_count);
    // Drop the per-series state for this folder so it doesn't round-trip
    // through the draft. The parent DICOM study's modality stays put.
    if (se.folder) {
      seriesByFolder.delete(se.folder);
      deselectedFolders.delete(se.folder);
    }
    renderStudySummary();
    refreshCaseFormUI();
    persistCaseDraft();
    write(`deleted ${label}`);
  } catch (e) {
    write(`delete failed: ${(e as Error).message || e}`);
  }
}

async function loadPresets(): Promise<void> {
  const port = await window.backend.getPort();
  if (!port) return;
  const res = await fetch(`http://127.0.0.1:${port}/window/presets`);
  if (!res.ok) return;
  windowPresets = (await res.json()) as WindowPresetsResponse;
  for (const name of Object.keys(windowPresets)) {
    const p = windowPresets[name];
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (C ${p.center} / W ${p.width})`;
    viewerPresetSelect.appendChild(opt);
  }
}

viewerCompressMode.addEventListener('change', () => {
  viewerCompressRatioLabel.hidden = viewerCompressMode.value !== 'lossy';
});

viewerPresetSelect.addEventListener('change', () => {
  const v = viewerPresetSelect.value;
  if (!v) return;
  if (v === '__reset') {
    window.viewerAPI?.reset?.();
  } else {
    const p = windowPresets[v];
    if (p) window.viewerAPI?.applyWindow?.(p.center, p.width);
  }
  // Reset the select so the same preset can be re-applied
  viewerPresetSelect.value = '';
});

// Drop handling -------------------------------------------------------------
function bindDropZone(zone: HTMLElement, onDrop: (p: string) => void): void {
  (['dragenter', 'dragover'] as const).forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('hover');
    }),
  );
  (['dragleave', 'drop'] as const).forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('hover');
    }),
  );
  zone.addEventListener('drop', (e) => {
    if (state !== 'idle') return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    const p = window.fsBridge.pathForFile(files[0]);
    if (!p) { write('dropped item has no path'); return; }
    onDrop(p);
  });
}

bindDropZone(drop, (p) => inspect(p));

btnOpenFolder?.addEventListener('click', async () => {
  if (state !== 'idle') return;
  const folder = await window.dialogBridge?.pickFolder?.();
  if (!folder) return;
  await loadFolder(folder);
});

// Buttons -------------------------------------------------------------------
btnAnonymise.addEventListener('click', runAnonymise);
btnCancelInspect.addEventListener('click', () => { pending = null; setState('idle'); });
btnCancelRun.addEventListener('click', () => {
  // The user wants to stop — tell the fetch to abort. runStream catches
  // the AbortError, logs "cancelled", and returns { cancelled: true };
  // each caller then resets its own UI state (usually back to idle).
  if (currentAbortController) {
    write('Cancelled by user');
    currentAbortController.abort();
  }
});
btnReset.addEventListener('click', () => {
  const cleared = anonOutput ? basename(anonOutput) : 'case';
  closeViewer();
  pending = null;
  anonOutput = null;
  studyMeta = null;
  dropDetails.hidden = true;
  dropDetails.open = false;
  dropDetailsBody.innerHTML = '';
  renderStudySummary();
  // Don't wipe the activity log — it's the only timeline a user has of
  // what happened in this session. The Log modal has its own Clear
  // action for when the buffer's actually in the way.
  try { sessionStorage.removeItem(LAST_FOLDER_KEY); } catch { /* ignore */ }
  // Clear the case-draft too: a full reset shouldn't bleed the old case's
  // title/history into the next study the user drops in.
  clearCaseDraft();
  resetCaseForm();
  uploadSeriesListEl.innerHTML = '';
  setState('idle');
  write(`cleared: ${cleared}`);
});

btnRevealMain.addEventListener('click', () => {
  if (anonOutput) window.shellBridge.reveal(anonOutput);
});

// Case metadata form --------------------------------------------------------
// The Case form lives in panel-upload (reached via "Add to Radiopaedia" from
// the Done panel). Per-series Study forms sit inside each upload-series row —
// see renderUploadSeriesList. Studies are keyed by the series' anonymised
// folder; that's the stable primary key between renders and the only thing
// that survives a /scan re-run.

const CASE_DRAFT_KEY = 'radiopaedia-studio:case-draft';
const CASE_DRAFT_VERSION = 4; // bumped when modality moved to per-study and series got perspective+specifics.

type CaseFormShape = Omit<Case, 'source_summary' | 'output_root'>;

interface CaseDraft {
  v: number;
  case: CaseFormShape;
  studyModalities: Array<[number, Modality]>; // [studyIdx, modality]
  series: Array<[string, SeriesState]>;       // [folder, { perspective, specifics }]
  deselected?: string[];                      // folders excluded from upload
}

// Per-DICOM-study modality, keyed by the study's index in studyMeta.studies
// (stable for the life of a single anonymise/scan; resetCaseForm clears it
// alongside the form when a new run starts).
const studyModalityByIdx = new Map<number, Modality>();

// Per-series state, keyed by series folder. `perspective` (plane/projection
// or caption depending on modality) and `specifics` (sequence, contrast,
// stain, …) are sent via image_preparation, NOT on the studies-create POST.
type SeriesState = { perspective?: string; specifics?: string };
const seriesByFolder = new Map<string, SeriesState>();

// Folders the user has chosen NOT to upload. We store deselections rather than
// selections so newly-discovered series default to included.
const deselectedFolders = new Set<string>();
function isFolderSelected(folder: string): boolean {
  return !deselectedFolders.has(folder);
}

function studyIdxFor(st: StudySummary): number {
  return studyMeta?.studies?.indexOf(st) ?? -1;
}
// Identity helper used in renderUploadSeriesList for data-attributes.
function studyKeyFor(st: StudySummary): string | null {
  for (const se of st.series ?? []) {
    if (se.folder) return se.folder;
  }
  return null;
}
function getStudyModality(st: StudySummary): Modality | '' {
  const idx = studyIdxFor(st);
  if (idx < 0) return '';
  return studyModalityByIdx.get(idx) ?? '';
}
function setStudyModality(st: StudySummary, m: Modality | ''): void {
  const idx = studyIdxFor(st);
  if (idx < 0) return;
  if (m) studyModalityByIdx.set(idx, m as Modality);
  else studyModalityByIdx.delete(idx);
}

function emptyCaseForm(): CaseFormShape {
  return {
    title: '',
    system_id: null,
    age: null,
    patient_sex: null,
    clinical_history: '',
    case_discussion: '',
  };
}

// Populate the fixed-list selects exactly once.
function populateCaseSelects(): void {
  for (const opt of SYSTEM_OPTIONS) {
    const o = document.createElement('option');
    o.value = String(opt.id);
    o.textContent = opt.name;
    caseSystem.appendChild(o);
  }
}

function readCaseForm(): CaseFormShape {
  const systemIdStr = caseSystem.value;
  const systemId = systemIdStr ? parseInt(systemIdStr, 10) : NaN;
  return {
    title: caseTitle.value.trim(),
    system_id: Number.isFinite(systemId) ? systemId : null,
    age: null,
    patient_sex: null,
    clinical_history: '',
    case_discussion: '',
  };
}

function writeCaseForm(data: Partial<CaseFormShape>): void {
  if (data.title !== undefined) caseTitle.value = data.title ?? '';
  if (data.system_id !== undefined) {
    caseSystem.value = data.system_id != null ? String(data.system_id) : '';
  }
}

function updateCounter(
  el: HTMLSpanElement,
  value: string,
  max: number,
): void {
  const len = value.length;
  el.textContent = `${len} / ${max}`;
  el.classList.toggle('over', len > max);
}

// Collect each DICOM study with at least one selected series. Returns one
// entry per Study (single modality, multiple Series) — matches the wire
// shape: one POST .../studies + N image_preparation calls per Study.
function collectStudies(): Array<{ study: Study; series: Series[] }> {
  const out: Array<{ study: Study; series: Series[] }> = [];
  if (!studyMeta?.studies) return out;
  for (const st of studyMeta.studies) {
    const selectedSeries: Series[] = [];
    for (const se of st.series ?? []) {
      if (!se.folder) continue;
      if (!isFolderSelected(se.folder)) continue;
      const state = seriesByFolder.get(se.folder) ?? {};
      selectedSeries.push({
        folder: se.folder,
        perspective: state.perspective,
        specifics: state.specifics,
      });
    }
    if (selectedSeries.length === 0) continue;
    const modality = getStudyModality(st);
    if (!modality) continue; // unset modality → skip; validation prevents this
    out.push({ study: { modality }, series: selectedSeries });
  }
  return out;
}

function validateCaseForm(): { ok: boolean; message: string } {
  const title = caseTitle.value.trim();
  caseTitle.classList.toggle('invalid', title.length === 0 || title.length > CASE_TITLE_MAX);
  if (title.length === 0) return { ok: false, message: 'Title is required.' };
  if (title.length > CASE_TITLE_MAX) {
    return { ok: false, message: `Title is too long (max ${CASE_TITLE_MAX}).` };
  }
  const systemId = caseSystem.value ? parseInt(caseSystem.value, 10) : NaN;
  caseSystem.classList.toggle('invalid', !Number.isFinite(systemId));
  if (!Number.isFinite(systemId)) return { ok: false, message: 'Pick a system.' };

  // Each DICOM study with at least one selected series must have a modality
  // picked (modality is per-Study on Radiopaedia, not per-Series).
  let anySelected = false;
  for (const st of studyMeta?.studies ?? []) {
    const hasSelected = (st.series ?? []).some((s) => s.folder && isFolderSelected(s.folder));
    if (!hasSelected) continue;
    anySelected = true;
    if (!getStudyModality(st)) {
      const desc = st.description || st.body_part || `Study ${(studyMeta!.studies!.indexOf(st)) + 1}`;
      return { ok: false, message: `Pick a modality for "${desc}".` };
    }
  }
  if (!anySelected) {
    return { ok: false, message: 'Select at least one series to upload.' };
  }
  return { ok: true, message: '' };
}

function refreshCaseFormUI(): void {
  updateCounter(caseTitleCounter, caseTitle.value, CASE_TITLE_MAX);
  const v = validateCaseForm();
  caseValidation.textContent = v.message;
  caseValidation.classList.toggle('error', !v.ok);
  btnCaseReady.disabled = !v.ok;
  // Mark study-modality selects as invalid when their group has selected
  // series but no modality. Per-series perspective/specifics aren't
  // required, so they don't get an invalid flag.
  for (const sel of uploadSeriesListEl.querySelectorAll<HTMLSelectElement>('.study-modality')) {
    const group = sel.closest<HTMLDivElement>('.upload-study-group');
    let needsModality = false;
    if (group) {
      const checks = group.querySelectorAll<HTMLInputElement>('.upload-row-check');
      for (const c of checks) if (c.checked) { needsModality = true; break; }
    }
    sel.classList.toggle('invalid', needsModality && sel.value === '');
  }
}

function persistCaseDraft(): void {
  try {
    const payload: CaseDraft = {
      v: CASE_DRAFT_VERSION,
      case: readCaseForm(),
      studyModalities: Array.from(studyModalityByIdx.entries()),
      series: Array.from(seriesByFolder.entries()),
      deselected: Array.from(deselectedFolders),
    };
    sessionStorage.setItem(CASE_DRAFT_KEY, JSON.stringify(payload));
  } catch { /* storage full / disabled — drop silently */ }
}

function restoreCaseDraft(): CaseDraft | null {
  try {
    const raw = sessionStorage.getItem(CASE_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CaseDraft>;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CASE_DRAFT_VERSION) {
      // Shape mismatch — drop the draft; there's no real user data to migrate.
      sessionStorage.removeItem(CASE_DRAFT_KEY);
      return null;
    }
    return parsed as CaseDraft;
  } catch {
    try { sessionStorage.removeItem(CASE_DRAFT_KEY); } catch { /* ignore */ }
    return null;
  }
}

function clearCaseDraft(): void {
  try { sessionStorage.removeItem(CASE_DRAFT_KEY); } catch { /* ignore */ }
}

function resetCaseForm(): void {
  writeCaseForm(emptyCaseForm());
  studyModalityByIdx.clear();
  seriesByFolder.clear();
  deselectedFolders.clear();
  refreshCaseFormUI();
}

// Called whenever we have a fresh study summary to work with — either right
// after anonymisation, or after /scan via loadFolder. Pre-fills any field the
// user hasn't already touched (existing values win over derived ones, so a
// reload doesn't clobber in-progress edits).
function hydrateCaseForm(summary: SummaryPayload | null, outputRoot: string | null): void {
  if (!summary || !outputRoot) return;

  const derived = deriveDefaultCase(summary, outputRoot);
  const draft = restoreCaseDraft();
  const current = readCaseForm();
  const hasAnyCurrentInput = !!(current.title || current.system_id != null);

  // Priority: existing in-memory input > sessionStorage draft > derived.
  const seed: Partial<CaseFormShape> = {
    ...(derived as Partial<CaseFormShape>),
    ...(draft?.case ?? {}),
    ...(hasAnyCurrentInput ? current : {}),
  };
  writeCaseForm(seed);

  // Restore per-study modality from draft, gated to indices that still
  // exist in the current summary.
  studyModalityByIdx.clear();
  const studyCount = summary.studies?.length ?? 0;
  if (draft?.studyModalities) {
    for (const [idx, modality] of draft.studyModalities) {
      if (idx >= 0 && idx < studyCount) studyModalityByIdx.set(idx, modality);
    }
  }
  // Restore per-series state from draft, gated to folders that still exist.
  seriesByFolder.clear();
  const liveFolders = new Set<string>();
  for (const st of summary.studies ?? []) {
    for (const se of st.series ?? []) {
      if (se.folder) liveFolders.add(se.folder);
    }
  }
  if (draft?.series) {
    for (const [folder, state] of draft.series) {
      if (liveFolders.has(folder)) seriesByFolder.set(folder, { ...state });
    }
  }
  // Restore deselections (same liveness gate).
  deselectedFolders.clear();
  if (draft?.deselected) {
    for (const folder of draft.deselected) {
      if (liveFolders.has(folder)) deselectedFolders.add(folder);
    }
  }
  // Default-fill anything not in the draft. Modality from the DICOM Modality
  // tag at the study level; perspective from the orientation classifier.
  for (let si = 0; si < studyCount; si++) {
    const st = summary.studies![si];
    if (!studyModalityByIdx.has(si)) {
      const guess = defaultModalityForSeries(st.modality);
      if (guess) studyModalityByIdx.set(si, guess);
    }
    for (const se of st.series ?? []) {
      if (!se.folder) continue;
      if (seriesByFolder.has(se.folder)) continue;
      if (se.orientation) {
        seriesByFolder.set(se.folder, { perspective: titleCase(se.orientation) });
      }
    }
  }
  refreshCaseFormUI();
}

populateCaseSelects();
resetCaseForm();

// Live validation + draft persistence for the case-form side.
for (const el of [caseTitle, caseSystem] as HTMLElement[]) {
  el.addEventListener('input', () => {
    refreshCaseFormUI();
    persistCaseDraft();
  });
  el.addEventListener('change', () => {
    refreshCaseFormUI();
    persistCaseDraft();
  });
}

btnAddCase.addEventListener('click', () => {
  if (!studyMeta || !anonOutput) return;
  setState('upload');
  refreshCaseFormUI();
});

btnUploadBack.addEventListener('click', () => {
  setState('done');
});

btnCaseReady.addEventListener('click', () => {
  const v = validateCaseForm();
  if (!v.ok) {
    refreshCaseFormUI();
    return;
  }
  if (!studyMeta || !anonOutput) {
    write('case: missing anonymise summary or output root');
    return;
  }
  const form = readCaseForm();
  const fullCase: Case = {
    ...form,
    source_summary: studyMeta,
    output_root: anonOutput,
  };
  const casePayload = buildCaseCreatePayload(fullCase);
  const studies = collectStudies();
  const studyBundles = studies.map(({ study, series }, i) => ({
    study: buildStudyCreatePayload(study, i + 2),
    series,
  }));
  const totalSeries = studies.reduce((n, { series }) => n + series.length, 0);
  write(
    `upload preview ready — ${form.title} (${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}, ${totalSeries} series).`,
  );
  showUploadPreview({ title: form.title, casePayload, studyBundles, totalSeries });
});

// Modal state. We keep a snapshot of the most recent submit attempt so the
// Submit handler can read it without re-collecting the form (which the user
// might have closed/reopened the modal over). The image step is intentionally
// out of scope for this slice — see uploadCaseAndStudies below.
interface PreparedUpload {
  title: string;
  casePayload: Record<string, unknown>;
  studyBundles: Array<{ study: Record<string, unknown>; series: Series[] }>;
  totalSeries: number;
}
let lastPrepared: PreparedUpload | null = null;
let uploadInFlight = false;
// Tracks the in-flight or most-recently-failed case on Radiopaedia so the
// error banner can surface a link the user can follow to inspect or delete
// the partial draft. Cleared on success, set as soon as the case-create
// returns an id.
let partialCase: { caseId: number; apiBase: string } | null = null;

// Render the preview modal in its initial (pre-submit) state.
function showUploadPreview(p: PreparedUpload): void {
  lastPrepared = p;
  uploadPreviewBlurb.hidden = false;
  uploadPreviewResult.hidden = true;
  uploadPreviewResult.innerHTML = '';
  btnPreviewSubmit.disabled = false;
  btnPreviewSubmit.textContent = 'Send to Radiopaedia';
  btnPreviewCancel.disabled = false;
  btnPreviewCancel.textContent = 'Cancel';

  // Summary block ----------------------------------------------------------
  uploadPreviewSummary.innerHTML = '';
  const rows: Array<[string, string]> = [
    ['Case title', p.title],
    ['Studies', String(p.studyBundles.length)],
    ['Series', String(p.totalSeries)],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'preview-row';
    const key = document.createElement('span');
    key.className = 'preview-key';
    key.textContent = k;
    const val = document.createElement('span');
    val.textContent = v;
    row.append(key, val);
    uploadPreviewSummary.appendChild(row);
  }

  // Step list (state added by the submit handler) --------------------------
  renderInitialSteps(p.studyBundles.length, p.totalSeries);

  // Reset the progress bar — it's hidden until the byte budget arrives
  // from main, then becomes visible during the upload.
  uploadPreviewProgress.hidden = true;
  uploadProgressBar.value = 0;
  uploadProgressBar.max = 1;
  uploadProgressText.textContent = '';

  uploadPreview.hidden = false;
  syncBodyScrollLock();
}

// Step model — drives the icon column on the left of the modal's step list.
type StepStatus = 'pending' | 'running' | 'done' | 'error';
interface UploadStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}
let steps: UploadStep[] = [];

function renderInitialSteps(studyCount: number, _totalSeries: number): void {
  const list: UploadStep[] = [
    { id: 'auth', label: 'Check auth + quota (GET /users/current)', status: 'pending' },
    { id: 'case', label: 'Create case (POST /cases)', status: 'pending' },
  ];
  for (let i = 0; i < studyCount; i++) {
    list.push({
      id: `study:${i}`,
      label: `Create study ${i + 1} of ${studyCount} (POST /cases/:id/studies)`,
      status: 'pending',
    });
  }
  list.push({
    id: 'anon',
    label: 'Anonymise images (dicomanon)',
    status: 'pending',
  });
  list.push({
    id: 'images',
    label: 'Upload images (S3 + image_preparation)',
    status: 'pending',
  });
  list.push({
    id: 'finalize',
    label: 'Finalise (PUT /cases/:id/mark_upload_finished)',
    status: 'pending',
  });
  steps = list;
  paintSteps();
}

function paintSteps(): void {
  uploadPreviewSteps.innerHTML = '';
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = `step-${s.status}`;
    const icon = document.createElement('span');
    icon.className = 'step-icon';
    if (s.status === 'pending') icon.textContent = '○';
    li.appendChild(icon);
    const label = document.createElement('span');
    label.textContent = s.detail ? `${s.label} — ${s.detail}` : s.label;
    li.appendChild(label);
    uploadPreviewSteps.appendChild(li);
  }
}

function setStep(id: string, status: StepStatus, detail?: string): void {
  const s = steps.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  if (detail !== undefined) s.detail = detail;
  paintSteps();
}

function hideUploadPreview(): void {
  // Always closes the modal. The upload (if running) continues in main —
  // the activity log captures all events so the user can see how it
  // settled even if they dismiss the modal mid-flight.
  uploadPreview.hidden = true;
  syncBodyScrollLock();
}

function maybeHideUploadPreview(): void {
  // For Esc + backdrop click — we don't want a stray keypress or a
  // mis-click on the dim backdrop to dismiss an in-flight upload, but
  // the explicit X / Cancel buttons go via hideUploadPreview() and
  // always close.
  if (uploadInFlight) return;
  hideUploadPreview();
}

// Body-scroll lock for modal overlays. Without this, scrolling inside the
// modal falls through to the page underneath once the modal content fits
// in the viewport — a constant minor irritation. We track which overlays
// are open via a small ref and lock the body whenever any are visible.
function syncBodyScrollLock(): void {
  const anyOpen = !uploadPreview.hidden || !authModal.hidden || !logModal.hidden || !sentModal.hidden;
  document.body.style.overflow = anyOpen ? 'hidden' : '';
}

// Sent-cases modal handlers ----------------------------------------------
function openSentModal(): void {
  renderSentList();
  sentModal.hidden = false;
  syncBodyScrollLock();
  // Auto-refresh the most recent case's job statuses on open. Older
  // entries get the user-driven Refresh button — auto-refreshing
  // everything could be a lot of API calls if the list is long.
  void refreshSentCase(0).catch(() => { /* ignore — UI handles errors per row */ });
}
function closeSentModal(): void {
  sentModal.hidden = true;
  syncBodyScrollLock();
  // Cancel any in-flight status check started from this panel.
  void window.uploadBridge.cancelStatusCheck().catch(() => { /* ignore */ });
}

btnSent.addEventListener('click', openSentModal);
btnSentClose.addEventListener('click', closeSentModal);
btnSentDone.addEventListener('click', closeSentModal);
sentModal.addEventListener('click', (e) => {
  if (e.target === sentModal) closeSentModal();
});
document.addEventListener('keydown', (e) => {
  if (!sentModal.hidden && e.key === 'Escape') closeSentModal();
});
btnSentRefreshAll.addEventListener('click', async () => {
  btnSentRefreshAll.disabled = true;
  btnSentRefreshAll.textContent = 'Refreshing…';
  try {
    const cases = readSentCases();
    for (let i = 0; i < cases.length; i++) {
      await refreshSentCase(i).catch(() => { /* per-row errors handled in UI */ });
    }
  } finally {
    btnSentRefreshAll.disabled = false;
    btnSentRefreshAll.textContent = 'Refresh all';
  }
});

function renderSentList(): void {
  const cases = readSentCases();
  sentList.innerHTML = '';
  sentEmpty.hidden = cases.length > 0;
  for (let i = 0; i < cases.length; i++) {
    sentList.appendChild(buildSentRow(cases[i], i));
  }
}

function buildSentRow(c: SentCase, idx: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'sent-row';
  row.dataset.idx = String(idx);

  const title = document.createElement('div');
  title.className = 'sent-row-title';
  title.textContent = `Case ${c.caseId} — ${c.title || '(untitled)'}`;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'sent-row-meta';
  meta.textContent = `Uploaded ${humanRelative(c.uploadedAt)} · ${c.jobs.length} series`;
  row.appendChild(meta);

  const summary = document.createElement('div');
  summary.className = 'sent-row-summary';
  summary.dataset.role = 'summary';
  summary.appendChild(buildSentSummaryContent(c));
  row.appendChild(summary);

  const actions = document.createElement('div');
  actions.className = 'sent-row-actions';

  const openLink = document.createElement('a');
  const caseUrl = `${c.apiBase}/cases/${c.caseId}`;
  openLink.href = caseUrl;
  openLink.textContent = 'Open on Radiopaedia →';
  openLink.addEventListener('click', (e) => {
    e.preventDefault();
    void window.shellBridge.openExternal(caseUrl);
  });
  actions.appendChild(openLink);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    summary.classList.add('refreshing');
    try {
      await refreshSentCase(idx);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
      summary.classList.remove('refreshing');
    }
  });
  actions.appendChild(refreshBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.textContent = 'Remove';
  removeBtn.title = 'Remove from this list (does not affect the case on Radiopaedia)';
  removeBtn.addEventListener('click', () => {
    removeSentCase(c.caseId, c.apiBase);
    renderSentList();
  });
  actions.appendChild(removeBtn);

  row.appendChild(actions);
  return row;
}

function buildSentSummaryContent(c: SentCase): DocumentFragment {
  const frag = document.createDocumentFragment();
  let ready = 0, processing = 0, failed = 0, unknown = 0;
  for (const j of c.jobs) {
    const s = j.lastKnownStatus;
    if (s === 'ready' || s === 'completed-dicom-processing') ready++;
    else if (s === 'pending-upload' || s === 'pending-dicom-processing') processing++;
    else if (s === 'failed') failed++;
    else unknown++;
  }
  const total = c.jobs.length;

  if (unknown === total) {
    const span = document.createElement('span');
    span.textContent = 'Status not checked yet — click Refresh.';
    span.style.opacity = '0.7';
    frag.appendChild(span);
    return frag;
  }

  if (ready > 0) frag.appendChild(pill('ready', `${ready} ready`));
  if (processing > 0) frag.appendChild(pill('processing', `${processing} processing`));
  if (failed > 0) frag.appendChild(pill('failed', `${failed} failed`));
  if (unknown > 0) frag.appendChild(pill('unknown', `${unknown} unchecked`));
  return frag;
}

function pill(kind: 'ready' | 'processing' | 'failed' | 'unknown', text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `sent-status-pill ${kind}`;
  span.textContent = text;
  return span;
}

async function refreshSentCase(idx: number): Promise<void> {
  const cases = readSentCases();
  const c = cases[idx];
  if (!c) return;
  // Only ask the server about jobs whose status isn't already terminally
  // ready. We deliberately re-check 'failed' jobs: the API doesn't expose
  // a permanent failure flag (handoff doc item #8), so the client-side
  // 'failed' is a heuristic that can correct itself if the user retries.
  const nonTerminal = c.jobs.filter((j) =>
    j.lastKnownStatus !== 'ready'
    && j.lastKnownStatus !== 'completed-dicom-processing');
  if (nonTerminal.length === 0) {
    // Nothing to do; just re-render to update the relative-time hint.
    renderSentList();
    return;
  }
  const wireJobs = nonTerminal.map((j) => ({
    studyIdx: j.studyIdx,
    seriesIdx: j.seriesIdx,
    caseId: c.caseId,
    studyId: j.studyId,
    jobId: j.jobId,
  }));
  const result = await window.uploadBridge.checkStatus(wireJobs);
  // The bridge type returns string status; cast through the known union.
  updateSentCaseJobStatuses(
    c.caseId,
    c.apiBase,
    result.map((r) => ({ jobId: r.jobId, status: r.status as _ProcessingStatus })),
  );
  // Re-render to reflect persisted state.
  renderSentList();
}

// Locale-friendly relative time: "12 minutes ago", "yesterday", etc.
// Fairly coarse — exact timestamps live in lastCheckedAt / uploadedAt
// for anyone who needs them.
function humanRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}

// Log-modal handlers --------------------------------------------------------
function openLogModal(): void {
  logModal.hidden = false;
  syncBodyScrollLock();
  // Pin scroll to the bottom — the user almost always wants the most
  // recent entries first when the modal opens.
  log.scrollTop = log.scrollHeight;
}
function closeLogModal(): void {
  logModal.hidden = true;
  syncBodyScrollLock();
}
btnLog.addEventListener('click', openLogModal);
btnLogClose.addEventListener('click', closeLogModal);
btnLogDone.addEventListener('click', closeLogModal);
btnLogClear.addEventListener('click', () => {
  log.textContent = '';
});
logModal.addEventListener('click', (e) => {
  if (e.target === logModal) closeLogModal();
});
document.addEventListener('keydown', (e) => {
  if (!logModal.hidden && e.key === 'Escape') closeLogModal();
});

// "12.4 MB / 248.7 MB · 5%" — the progress bar's status line. Each byte
// counts twice in the budget (hash + upload), so we display the *upload-
// equivalent* total (totalBytes / 2) so the figure reflects the actual
// data size the user expects to see.
function formatProgress(done: number, total: number, fileCount?: number): string {
  if (total <= 0) return '';
  const pct = Math.round((done / total) * 100);
  const dataDone = humanBytes(done / 2);
  const dataTotal = humanBytes(total / 2);
  const filesPart = fileCount != null ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'}` : '';
  return `${dataDone} / ${dataTotal} · ${pct}%${filesPart}`;
}

// Live API submission --------------------------------------------------------
// First slice: create the case + studies on Radiopaedia. Image upload (S3 +
// image_preparation) lands in a follow-up — see the modal step list. The
// case is left as a draft (no mark_upload_finished call) so the user can
// inspect the shape on the website before we wire up images.

interface ApiError extends Error {
  status?: number;
  body?: string;
}

async function radiopaediaApiPost(
  apiBase: string,
  path: string,
  token: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: ApiError = new Error(`${res.status} ${res.statusText} — ${path}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return (await res.json()) as Record<string, unknown>;
}

async function radiopaediaApiGet(
  apiBase: string,
  path: string,
  token: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: ApiError = new Error(`${res.status} ${res.statusText} — ${path}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return (await res.json()) as Record<string, unknown>;
}

async function uploadCaseAndStudies(p: PreparedUpload): Promise<void> {
  uploadInFlight = true;
  btnPreviewSubmit.disabled = true;
  btnPreviewCancel.disabled = true;
  btnPreviewCancel.textContent = 'Working…';
  uploadPreviewBlurb.hidden = true;
  clearResultBanner();
  write(
    `upload: started — "${p.title}" (${p.studyBundles.length} stud${p.studyBundles.length === 1 ? 'y' : 'ies'}, ${p.totalSeries} series)`,
  );

  let token: string | null;
  let apiBase: string;
  try {
    [token, apiBase] = await Promise.all([
      window.radiopaedia.getValidAccessToken(),
      window.radiopaedia.getApiBase(),
    ]);
  } catch (e) {
    return finishWithError('preflight', `Couldn't reach the auth bridge — ${(e as Error).message}`);
  }
  if (!token) {
    // The header gate should normally prevent this, but tokens can expire
    // between authed-cache refresh and submit. Mark un-authed and redirect.
    setAuthed(false);
    return finishWithError(
      'auth',
      'Token expired or missing. Open the Radiopaedia button in the header to sign in again.',
    );
  }

  // 1. Auth + quota check.
  setStep('auth', 'running');
  let quotaOk = false;
  try {
    const me = await radiopaediaApiGet(apiBase, '/api/v1/users/current', token);
    const quotas = (me.quotas ?? {}) as Record<string, unknown>;
    const allowed = quotas.allowed_draft_cases as number | null | undefined;
    const used = quotas.draft_case_count as number | undefined;
    const login = (me.login as string | undefined)?.trim() || null;
    if (allowed != null && used != null && used >= allowed) {
      setStep('auth', 'error', `over draft quota (${used}/${allowed})`);
      // Surface a deep link to the user's own drafts list so they can
      // delete an old draft and retry. The path is the same shape on
      // staging and prod — only the host changes — so deriving from
      // apiBase is enough.
      const draftsUrl = login
        ? `${apiBase}/users/${encodeURIComponent(login)}/cases?visibility=draft`
        : null;
      return finishWithError(
        'auth',
        `Over draft quota (${used}/${allowed}). Delete a draft case or increase your supporter level before retrying.`,
        draftsUrl ? { label: 'Open my draft cases →', url: draftsUrl } : undefined,
      );
    }
    quotaOk = true;
    setStep('auth', 'done', allowed != null ? `quota ${used ?? '?'}/${allowed}` : 'ok');
    write(`upload: auth ok${login ? ` as @${login}` : ''}${
      allowed != null ? ` (drafts ${used ?? '?'}/${allowed})` : ''}`);
  } catch (e) {
    return apiCallFailed('auth', e);
  }
  if (!quotaOk) return; // already returned, but TS narrowing.

  // 2. Create case.
  setStep('case', 'running');
  partialCase = null; // any prior partial-case link from a previous attempt is now stale.
  let caseId: number | null = null;
  try {
    const created = await radiopaediaApiPost(apiBase, '/api/v1/cases', token, p.casePayload);
    caseId = (created.id ?? (created.case as { id?: number } | undefined)?.id) as number ?? null;
    if (!caseId) throw new Error(`POST /cases response had no id: ${JSON.stringify(created)}`);
    // From here on, any failure leaves a draft case on Radiopaedia we
    // should surface back to the user (so they can inspect or delete it).
    partialCase = { caseId, apiBase };
    setStep('case', 'done', `case_id=${caseId}`);
    write(`upload: case created — id ${caseId}`);
  } catch (e) {
    return apiCallFailed('case', e);
  }

  // 3. Create studies sequentially. Concurrent posts would interleave the
  // server-side position assignments unpredictably; serial is fine because
  // case-create + a handful of study-creates is a sub-second loop.
  const studyIds: number[] = [];
  for (let i = 0; i < p.studyBundles.length; i++) {
    const stepId = `study:${i}`;
    setStep(stepId, 'running');
    try {
      const created = await radiopaediaApiPost(
        apiBase,
        `/api/v1/cases/${caseId}/studies`,
        token,
        p.studyBundles[i].study,
      );
      const studyId =
        (created.id ?? (created.study as { id?: number } | undefined)?.id) as number ?? null;
      if (!studyId) throw new Error(`POST /studies response had no id: ${JSON.stringify(created)}`);
      studyIds.push(studyId);
      setStep(stepId, 'done', `study_id=${studyId}`);
      const modality = (p.studyBundles[i].study as { modality?: string }).modality ?? '';
      write(`upload: study ${i + 1} of ${p.studyBundles.length} created — id ${studyId}${modality ? ` (${modality})` : ''}`);
    } catch (e) {
      return apiCallFailed(stepId, e);
    }
  }

  // 4. Image upload + finalise. Driven from main via the upload bridge so
  // the orchestrator can stream large DICOM files off disk, hash them,
  // PUT to S3, and feed /image_preparation. We listen for events to
  // update the modal step list.
  const imagesOk = await runImageUploadViaBridge(p, caseId!, studyIds);
  if (!imagesOk) return;

  finishWithSuccess(apiBase, caseId!, p.title, studyIds);
}

async function runImageUploadViaBridge(
  p: PreparedUpload,
  caseId: number,
  studyIds: number[],
): Promise<boolean> {
  setStep('images', 'running', 'starting…');

  // Build the upload spec from the prepared bundles. p.studyBundles already
  // has the original Series objects with folder + perspective + specifics
  // — we just pair them with the studyIds we got back from the create.
  const studies = p.studyBundles.map(({ series }, i) => ({
    studyId: studyIds[i],
    series: series.map((s) => ({
      folder: s.folder,
      perspective: s.perspective,
      specifics: s.specifics,
    })),
  }));

  // Allow Cancel to abort the upload mid-flight. While the upload is
  // running, Cancel calls uploadBridge.abort() instead of just closing
  // the modal — closing wouldn't stop main's pipeline.
  btnPreviewCancel.disabled = false;
  btnPreviewCancel.textContent = 'Cancel upload';
  const cancelHandler = (): void => {
    btnPreviewCancel.disabled = true;
    btnPreviewCancel.textContent = 'Aborting…';
    void window.uploadBridge.abort();
  };
  btnPreviewCancel.addEventListener('click', cancelHandler);

  const off = window.uploadBridge.onEvent(handleUploadEvent);
  try {
    const result = await window.uploadBridge.startImages({ caseId, studies });
    if (result.status === 'ok') {
      // anon should already be done from the first non-stage event, but
      // close it explicitly in case there were no series (shouldn't
      // happen in practice — guarded by validateCaseForm).
      const anonStep = steps.find((s) => s.id === 'anon');
      if (anonStep && anonStep.status !== 'done') setStep('anon', 'done');
      setStep('images', 'done');
      return true;
    }
    if (result.status === 'aborted') {
      setStep('images', 'error', 'aborted by user');
      setStep('finalize', 'pending', 'skipped — upload aborted');
      finishWithError('images', 'Upload aborted. The case is left as a draft on Radiopaedia.');
      return false;
    }
    setStep('images', 'error', result.message ?? 'unknown error');
    setStep('finalize', 'pending', 'skipped — image upload failed');
    finishWithError('images', result.message ?? 'image upload failed');
    return false;
  } finally {
    off();
    btnPreviewCancel.removeEventListener('click', cancelHandler);
  }
}

// Mirrors the UploadEventPayload union in globals.d.ts. Defined locally
// because globals.d.ts is a module file (it has top-level exports), so the
// types within it aren't visible from renderer.ts via the global scope.
type _ProcessingStatus =
  | 'pending-upload'
  | 'pending-dicom-processing'
  | 'completed-dicom-processing'
  | 'ready'
  | 'failed';
interface _UploadedJob {
  studyIdx: number;
  seriesIdx: number;
  caseId: number;
  studyId: number;
  jobId: string;
}
type _UploadEventPayload =
  | { type: 'budget'; totalBytes: number; totalFiles: number }
  | { type: 'bytes-progress'; doneBytes: number; totalBytes: number }
  | { type: 'series-start'; studyIdx: number; seriesIdx: number; folder: string; sliceCount: number }
  | { type: 'series-progress'; studyIdx: number; seriesIdx: number; phase: 'stage' | 'hash' | 'presign' | 'upload' | 'prepare'; done: number; total: number }
  | { type: 'series-done'; studyIdx: number; seriesIdx: number }
  | { type: 'series-error'; studyIdx: number; seriesIdx: number; message: string }
  | { type: 'finalize-start' }
  | { type: 'finalize-done' }
  | { type: 'finalize-error'; message: string }
  | { type: 'all-done'; caseId: number; jobs: _UploadedJob[] }
  | { type: 'aborted' };

// Sent-cases persistence (#25). Each successful upload appends an entry
// here; the Sent-cases panel reads + refreshes from this store. Survives
// renderer reloads via localStorage; lost on a full uninstall (we'd
// reach for the user-data directory if persistence-across-reinstall
// matters — not yet needed).
const SENT_CASES_KEY = 'radiopaedia-studio:sent-cases';
const SENT_CASES_VERSION = 1;
const SENT_CASES_MAX = 50;

function readSentCases(): SentCase[] {
  try {
    return parseSentCases(localStorage.getItem(SENT_CASES_KEY), SENT_CASES_VERSION);
  } catch {
    return [];
  }
}

function writeSentCases(cases: SentCase[]): void {
  try {
    localStorage.setItem(SENT_CASES_KEY, JSON.stringify(capSentCases(cases, SENT_CASES_MAX)));
  } catch {
    // Storage full / disabled — non-fatal; the upload itself succeeded.
  }
}

function recordSentCase(
  caseId: number,
  apiBase: string,
  title: string,
  jobs: _UploadedJob[],
): void {
  const entry = buildSentCase(SENT_CASES_VERSION, caseId, apiBase, title, jobs, new Date().toISOString());
  writeSentCases(addOrReplaceSentCase(readSentCases(), entry));
}

function updateSentCaseJobStatuses(
  caseId: number,
  apiBase: string,
  updates: Array<{ jobId: string; status: _ProcessingStatus }>,
): void {
  writeSentCases(mergeJobStatuses(readSentCases(), caseId, apiBase, updates, new Date().toISOString()));
}

function removeSentCase(caseId: number, apiBase: string): void {
  writeSentCases(removeSentCaseCore(readSentCases(), caseId, apiBase));
}

function phaseLabel(phase: 'stage' | 'hash' | 'presign' | 'upload' | 'prepare'): string {
  switch (phase) {
    case 'stage':   return 'anonymising';
    case 'hash':    return 'hashing';
    case 'presign': return 'presigning';
    case 'upload':  return 'uploading';
    case 'prepare': return 'preparing';
  }
}

function handleUploadEvent(e: _UploadEventPayload): void {
  switch (e.type) {
    case 'budget':
      // First event after discovery — we know the total byte budget. Show
      // the progress bar from here on; main will start emitting
      // bytes-progress as files get hashed and uploaded.
      uploadPreviewProgress.hidden = false;
      uploadProgressBar.value = 0;
      uploadProgressBar.max = e.totalBytes * 2;
      uploadProgressText.textContent = formatProgress(0, e.totalBytes * 2, e.totalFiles);
      break;
    case 'bytes-progress':
      uploadProgressBar.value = e.doneBytes;
      uploadProgressBar.max = e.totalBytes;
      uploadProgressText.textContent = formatProgress(e.doneBytes, e.totalBytes);
      break;
    case 'series-start':
      // Always belongs to the upload phase — anonymise emits its own
      // series-progress { phase: 'stage' } before discovery hits this.
      setStep('images', 'running',
        `study ${e.studyIdx + 1}, series ${e.seriesIdx + 1} — ${e.sliceCount} slice${e.sliceCount === 1 ? '' : 's'}`);
      break;
    case 'series-progress': {
      const detail =
        `study ${e.studyIdx + 1}, series ${e.seriesIdx + 1} — ${phaseLabel(e.phase)} ${e.done}/${e.total}`;
      // Stage events drive the discrete Anonymise row; everything else
      // drives the Upload row. The anon step is marked done implicitly
      // when the first non-stage event arrives (see below).
      if (e.phase === 'stage') {
        setStep('anon', 'running', detail);
      } else {
        // First non-stage event after staging: close out the anon row.
        const anonStep = steps.find((s) => s.id === 'anon');
        if (anonStep && anonStep.status === 'running') {
          setStep('anon', 'done');
        }
        setStep('images', 'running', detail);
      }
      break;
    }
    case 'series-done':
      // Don't paint the parent step done yet — more series may follow.
      // Log so the activity log has a per-series breadcrumb that
      // outlives the modal session.
      write(`upload: series ${e.studyIdx + 1}.${e.seriesIdx + 1} uploaded`);
      break;
    case 'series-error':
      // Route the error to whichever step we were in when it fired.
      // series-error comes after any in-flight series-progress, so the
      // most-recently-running step is the right target.
      {
        const target = steps.find((s) => s.status === 'running')?.id ?? 'images';
        setStep(target, 'error',
          `study ${e.studyIdx + 1}, series ${e.seriesIdx + 1}: ${e.message}`);
      }
      break;
    case 'finalize-start':
      setStep('finalize', 'running');
      write('upload: finalising case (mark_upload_finished)');
      break;
    case 'finalize-done':
      setStep('finalize', 'done');
      write('upload: case finalised on Radiopaedia');
      break;
    case 'finalize-error':
      setStep('finalize', 'error', e.message);
      write(`upload: finalise failed: ${e.message}`);
      break;
    case 'all-done':
      // Persist a record of this upload for the Sent-cases panel.
      // partialCase carries the apiBase + caseId we used; lastPrepared
      // has the title. Both should be set by this point — guarded
      // anyway because the assertion isn't free.
      if (partialCase && lastPrepared) {
        recordSentCase(partialCase.caseId, partialCase.apiBase, lastPrepared.title, e.jobs);
      }
      break;
    case 'aborted':
      // The startImages promise resolves with the final status; the
      // surrounding helper handles the UI transitions there.
      break;
  }
}

function apiCallFailed(stepId: string, err: unknown): void {
  const e = err as ApiError;
  const status = e?.status ? ` (HTTP ${e.status})` : '';
  const body = e?.body ? ` — ${e.body.slice(0, 200)}` : '';
  setStep(stepId, 'error', `${e?.message ?? 'unknown error'}${status}`);
  finishWithError(stepId, `${e?.message ?? 'request failed'}${status}${body}`);
}

// Header-driven auth -------------------------------------------------------
// The user signs in once via the header button before they ever reach the
// Add-to-Radiopaedia path; setState() gates that button on `isAuthed`. The
// auth modal here is the only place the OOB OAuth dance lives.

function setAuthed(authed: boolean): void {
  isAuthed = authed;
  btnAuth.classList.toggle('authed', authed);
  btnAuth.textContent = authed ? 'Radiopaedia ✓' : 'Sign in to Radiopaedia';
  // Re-paint state-dependent UI (Add-to-Radiopaedia disabled flag, etc.).
  if (state === 'done') setState('done');
}

async function refreshAuthState(): Promise<void> {
  try {
    const token = await window.radiopaedia.getValidAccessToken();
    setAuthed(token !== null);
  } catch {
    setAuthed(false);
  }
}

function paintAuthModal(): void {
  authSignedOut.hidden = isAuthed;
  authSignedIn.hidden = !isAuthed;
  authModalTitle.textContent = isAuthed ? 'Radiopaedia account' : 'Radiopaedia sign-in';
  authOpenError.hidden = true;
  authOpenError.textContent = '';
  authExchangeError.hidden = true;
  authExchangeError.textContent = '';
  btnAuthOpen.disabled = false;
  btnAuthOpen.textContent = 'Open Radiopaedia →';
  btnAuthSubmit.disabled = false;
  btnAuthSubmit.textContent = 'Submit code';
  authCodeInput.disabled = false;
  authCodeInput.value = '';
  if (isAuthed) {
    authProfile.textContent = 'Loading account info…';
  }
}

function openAuthModal(): void {
  paintAuthModal();
  authModal.hidden = false;
  syncBodyScrollLock();
  if (isAuthed) void refreshAuthProfile();
  else authCodeInput.focus();
}
function closeAuthModal(): void {
  authModal.hidden = true;
  syncBodyScrollLock();
}

// Fetch /users/current and render login + quotas in the profile block.
// Reuses the renderer's existing apiBase + token bridges so we don't
// duplicate auth plumbing. Errors render inline so a stale token shows
// up here rather than silently failing on the next upload.
async function refreshAuthProfile(): Promise<void> {
  let token: string | null;
  let apiBase: string;
  try {
    [token, apiBase] = await Promise.all([
      window.radiopaedia.getValidAccessToken(),
      window.radiopaedia.getApiBase(),
    ]);
  } catch (e) {
    renderAuthProfileError(`Couldn't reach the auth bridge: ${(e as Error).message ?? e}`);
    return;
  }
  if (!token) {
    renderAuthProfileError('No valid access token. Sign in again.');
    setAuthed(false);
    paintAuthModal();
    return;
  }
  try {
    const me = await radiopaediaApiGet(apiBase, '/api/v1/users/current', token);
    renderAuthProfile(apiBase, me);
  } catch (e) {
    const err = e as ApiError;
    const detail = err?.status ? ` (HTTP ${err.status})` : '';
    renderAuthProfileError(`Couldn't load account info${detail}.`);
  }
}

function renderAuthProfileError(message: string): void {
  authProfile.innerHTML = '';
  const span = document.createElement('span');
  span.style.color = '#d14';
  span.style.fontSize = '12px';
  span.textContent = message;
  authProfile.appendChild(span);
}

function renderAuthProfile(apiBase: string, me: Record<string, unknown>): void {
  const login = (me.login as string | undefined)?.trim() || '(unknown)';
  const quotas = (me.quotas ?? {}) as Record<string, unknown>;
  const draftAllowed = quotas.allowed_draft_cases as number | null | undefined;
  const draftUsed = (quotas.draft_case_count as number | undefined) ?? 0;
  const unlistedAllowed = quotas.allowed_unlisted_cases as number | null | undefined;
  const unlistedUsed = (quotas.unlisted_case_count as number | undefined) ?? 0;

  authProfile.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'auth-profile-login';
  heading.textContent = `Signed in as @${login}`;
  authProfile.appendChild(heading);

  const draftsUrl = `${apiBase}/users/${encodeURIComponent(login)}/cases?visibility=draft`;
  const draftsLink = document.createElement('div');
  draftsLink.style.marginTop = '4px';
  draftsLink.style.fontSize = '12px';
  const a = document.createElement('a');
  a.href = draftsUrl;
  a.textContent = 'Open my draft cases →';
  a.style.color = 'var(--accent)';
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    void window.shellBridge.openExternal(draftsUrl);
  });
  draftsLink.appendChild(a);
  authProfile.appendChild(draftsLink);

  const grid = document.createElement('div');
  grid.className = 'auth-profile-rows';
  appendQuotaRow(grid, 'Draft cases', draftUsed, draftAllowed);
  appendQuotaRow(grid, 'Unlisted cases', unlistedUsed, unlistedAllowed);
  authProfile.appendChild(grid);
}

function appendQuotaRow(
  grid: HTMLDivElement,
  label: string,
  used: number,
  allowed: number | null | undefined,
): void {
  const key = document.createElement('span');
  key.className = 'auth-profile-key';
  key.textContent = label;
  grid.appendChild(key);

  const val = document.createElement('span');
  if (allowed == null) {
    val.textContent = `${used} (no limit)`;
  } else {
    const ratio = allowed > 0 ? Math.min(used / allowed, 1) : 0;
    const bar = document.createElement('span');
    bar.className = 'auth-profile-bar' + (used >= allowed ? ' full' : '');
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(ratio * 100)}%`;
    bar.appendChild(fill);
    val.appendChild(bar);
    val.appendChild(document.createTextNode(`${used} / ${allowed}`));
  }
  grid.appendChild(val);
}

btnAuth.addEventListener('click', openAuthModal);
btnAuthClose.addEventListener('click', closeAuthModal);
btnAuthDone.addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (e) => {
  if (e.target === authModal) closeAuthModal();
});
document.addEventListener('keydown', (e) => {
  if (!authModal.hidden && e.key === 'Escape') closeAuthModal();
});

btnAuthOpen.addEventListener('click', async () => {
  btnAuthOpen.disabled = true;
  btnAuthOpen.textContent = 'Opening browser…';
  authOpenError.hidden = true;
  authOpenError.textContent = '';
  try {
    const result = await window.radiopaedia.openAuthorizationPage();
    if (result === 'error') {
      btnAuthOpen.disabled = false;
      btnAuthOpen.textContent = 'Open Radiopaedia →';
      authOpenError.hidden = false;
      authOpenError.innerHTML =
        'Failed to open the authorization page. Most common cause: missing ' +
        'OAuth client credentials. Set <code>RADIOPAEDIA_CLIENT_ID</code> ' +
        'and <code>RADIOPAEDIA_CLIENT_SECRET</code> in ' +
        '<code>src/main/radiopaedia-config.ts</code> (gitignored), then ' +
        're-run <code>npm run build:frontend</code> and restart the app.';
      write('failed to open the authorization page — check OAuth client config');
      return;
    }
    btnAuthOpen.textContent = 'Browser opened — paste the code below';
    authCodeInput.focus();
  } catch (e) {
    btnAuthOpen.disabled = false;
    btnAuthOpen.textContent = 'Open Radiopaedia →';
    authOpenError.hidden = false;
    authOpenError.textContent = `Auth error: ${(e as Error).message ?? e}`;
    write(`auth: ${(e as Error).message ?? e}`);
  }
});

btnAuthSubmit.addEventListener('click', async () => {
  const code = authCodeInput.value.trim();
  if (!code) { authCodeInput.focus(); return; }
  btnAuthSubmit.disabled = true;
  authCodeInput.disabled = true;
  btnAuthSubmit.textContent = 'Exchanging…';
  authExchangeError.hidden = true;
  try {
    const result = await window.radiopaedia.exchangeAuthorizationCode(code);
    if (result === 'ok') {
      setAuthed(true);
      paintAuthModal();
      void refreshAuthProfile();
      write('signed in to Radiopaedia');
    } else {
      btnAuthSubmit.disabled = false;
      authCodeInput.disabled = false;
      btnAuthSubmit.textContent = 'Submit code';
      authExchangeError.hidden = false;
      authExchangeError.textContent =
        'Exchange failed. Codes are single-use and short-lived — try signing in again to get a fresh one.';
      write('auth-code exchange failed');
    }
  } catch (e) {
    btnAuthSubmit.disabled = false;
    authCodeInput.disabled = false;
    btnAuthSubmit.textContent = 'Submit code';
    authExchangeError.hidden = false;
    authExchangeError.textContent = `Exchange error: ${(e as Error).message ?? e}`;
  }
});
authCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnAuthSubmit.click();
});

btnAuthSignout.addEventListener('click', async () => {
  btnAuthSignout.disabled = true;
  try {
    await window.credentials.clearRadiopaediaTokens();
    setAuthed(false);
    paintAuthModal();
    write('signed out of Radiopaedia');
  } finally {
    btnAuthSignout.disabled = false;
  }
});

function finishWithError(
  _stepId: string,
  message: string,
  helpLink?: { label: string; url: string },
): void {
  uploadInFlight = false;
  btnPreviewSubmit.disabled = false;
  btnPreviewSubmit.textContent = 'Try again';
  btnPreviewCancel.disabled = false;
  btnPreviewCancel.textContent = 'Close';
  uploadPreviewProgress.hidden = true;
  uploadPreviewResult.hidden = false;
  uploadPreviewResult.innerHTML = '';

  const banner = document.createElement('div');
  banner.className = 'modal-error';
  banner.textContent = message;
  uploadPreviewResult.appendChild(banner);

  if (helpLink) {
    const linkRow = document.createElement('div');
    linkRow.style.marginTop = '8px';
    const a = document.createElement('a');
    a.href = helpLink.url;
    a.textContent = helpLink.label;
    a.style.color = 'var(--accent)';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      void window.shellBridge.openExternal(helpLink.url);
    });
    linkRow.appendChild(a);
    uploadPreviewResult.appendChild(linkRow);
  }

  // If a partial draft was created on Radiopaedia, surface a link so the
  // user can inspect or delete it. "Try again" creates a fresh draft —
  // it doesn't resume — so the partial one stays orphaned until they
  // delete it on the website.
  if (partialCase) {
    const note = document.createElement('div');
    note.style.marginTop = '10px';
    note.style.fontSize = '12px';
    note.style.lineHeight = '1.5';
    const caseUrl = `${partialCase.apiBase}/cases/${partialCase.caseId}`;
    note.innerHTML =
      `A partial draft case was created on Radiopaedia (id ${partialCase.caseId}). ` +
      `<strong>Try again</strong> will create a fresh draft — open the partial one ` +
      `to inspect what made it through, and delete it there before retrying if you ` +
      `don't want it lingering.`;
    const linkRow = document.createElement('div');
    linkRow.style.marginTop = '6px';
    const a = document.createElement('a');
    a.href = caseUrl;
    a.textContent = `Open partial case ${partialCase.caseId} →`;
    a.style.color = 'var(--accent)';
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      void window.shellBridge.openExternal(caseUrl);
    });
    linkRow.appendChild(a);
    uploadPreviewResult.appendChild(note);
    uploadPreviewResult.appendChild(linkRow);
  }

  write(`upload failed: ${message}`);
}

function finishWithSuccess(
  apiBase: string,
  caseId: number,
  title: string,
  studyIds: number[],
): void {
  uploadInFlight = false;
  partialCase = null;
  btnPreviewSubmit.disabled = true;
  btnPreviewSubmit.textContent = 'Sent ✓';
  btnPreviewCancel.disabled = false;
  btnPreviewCancel.textContent = 'Close';
  uploadPreviewProgress.hidden = true;
  uploadPreviewResult.hidden = false;
  uploadPreviewResult.innerHTML = '';
  const caseUrl = `${apiBase}/cases/${caseId}`;

  const heading = document.createElement('div');
  heading.innerHTML = `<strong>Uploaded case ${caseId}</strong> — ${escapeHtmlText(title)}`;
  const sub = document.createElement('div');
  sub.style.marginTop = '6px';
  sub.style.opacity = '0.75';
  sub.textContent = `${studyIds.length} stud${studyIds.length === 1 ? 'y' : 'ies'} created with images, finalised on Radiopaedia.`;
  // Safety-story callout — every byte we sent went through dicomanon
  // first. Worth surfacing explicitly in the success state so the user
  // (and anyone they share the case with) has the privacy answer right
  // there next to the case URL.
  const anon = document.createElement('div');
  anon.style.marginTop = '4px';
  anon.style.opacity = '0.75';
  anon.style.fontSize = '12px';
  anon.textContent = '✓ All series anonymised by dicomanon before upload.';
  // Heads-up about Radiopaedia's async DICOM-to-PNG processing.
  // Polling for per-series state lives in a separate (future) Sent UI —
  // see #25 — so the upload modal doesn't block on minutes of waiting.
  const heads = document.createElement('div');
  heads.style.marginTop = '8px';
  heads.style.fontSize = '12px';
  heads.style.opacity = '0.75';
  heads.textContent =
    'Radiopaedia processes the uploaded DICOMs in the background — '
    + 'this can take from a few seconds to many minutes for large cases. '
    + 'Refresh the case page periodically to see the series as they finish '
    + 'converting.';
  const link = document.createElement('div');
  link.style.marginTop = '8px';
  const a = document.createElement('a');
  a.href = caseUrl;
  a.textContent = 'Open on Radiopaedia →';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    void window.shellBridge.openExternal(caseUrl).catch((err) => {
      write(`failed to open browser: ${(err as Error).message ?? err}`);
    });
  });
  link.appendChild(a);

  uploadPreviewResult.appendChild(heading);
  uploadPreviewResult.appendChild(sub);
  uploadPreviewResult.appendChild(anon);
  uploadPreviewResult.appendChild(heads);
  uploadPreviewResult.appendChild(link);
  write(`case created on Radiopaedia: ${caseUrl} (${studyIds.length} studies)`);
}

function clearResultBanner(): void {
  uploadPreviewResult.innerHTML = '';
  uploadPreviewResult.hidden = true;
}

function escapeHtmlText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
}

// Modal close + submit wiring -----------------------------------------------
btnPreviewClose.addEventListener('click', hideUploadPreview);
// Cancel: when an upload is in flight, the per-attempt cancelHandler
// (in runImageUploadViaBridge) is also bound and aborts the upload.
// When idle, the same button just closes the modal.
btnPreviewCancel.addEventListener('click', hideUploadPreview);
btnPreviewSubmit.addEventListener('click', () => {
  if (!lastPrepared) return;
  void uploadCaseAndStudies(lastPrepared);
});
uploadPreview.addEventListener('click', (e) => {
  if (e.target === uploadPreview) maybeHideUploadPreview();
});
document.addEventListener('keydown', (e) => {
  if (!uploadPreview.hidden && e.key === 'Escape') maybeHideUploadPreview();
});

// Try to restore any previously-saved draft at startup. We restore the
// in-memory maps now so the form's own (Title/System) fields are populated
// before the user reaches the upload view; per-study modality and per-series
// state get re-validated against any new summary in hydrateCaseForm.
const bootDraft = restoreCaseDraft();
if (bootDraft) {
  writeCaseForm(bootDraft.case);
  for (const [idx, modality] of bootDraft.studyModalities) {
    studyModalityByIdx.set(idx, modality);
  }
  for (const [folder, state] of bootDraft.series) {
    seriesByFolder.set(folder, { ...state });
  }
  if (bootDraft.deselected) {
    for (const f of bootDraft.deselected) deselectedFolders.add(f);
  }
  refreshCaseFormUI();
}

setState('idle');
loadPresets();
void restoreLastFolder();
void refreshAuthState();
