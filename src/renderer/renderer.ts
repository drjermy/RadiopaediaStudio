import type {
  Case,
  CompressSpec,
  DeleteSeriesRequest,
  InspectResponse,
  Modality,
  ReformatSpec,
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
} from '../shared/api.js';
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
const log = req<HTMLDivElement>('log');

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
  // "Add to Radiopaedia" only shown when we have a finished case.
  btnAddCase.hidden = next !== 'done' || !studyMeta || !anonOutput;
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
        const tech: string[] = [];
        if (se.modality) tech.push(se.modality);
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
        if (se.transfer_syntax?.name) sizeBits.push(se.transfer_syntax.name);
        const size = document.createElement('div');
        size.className = 'series-meta';
        size.textContent = sizeBits.join(' · ');

        li.append(desc, meta, size);

        // Compression pill on the thumbnail (top-right) — grey for lossless,
        // amber for lossy. No pill for uncompressed.
        const ts = se.transfer_syntax;
        if (ts?.compressed) {
          const pill = document.createElement('span');
          pill.className = 'compression-tag' + (ts.lossy ? ' lossy' : '');
          pill.textContent = ts.lossy ? 'LOSSY' : 'LOSSLESS';
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

// Upload-view series list ----------------------------------------------------
// One row per series. Each row carries a checkbox (default included), a
// thumbnail, the series description + key metadata, and the per-series Study
// form (modality / caption / findings). Deselecting a row excludes it from
// the upload payload and skips its modality requirement during validation.
function renderUploadSeriesList(): void {
  uploadSeriesListEl.innerHTML = '';
  if (!studyMeta?.studies?.length) return;

  for (let si = 0; si < studyMeta.studies.length; si++) {
    const st = studyMeta.studies[si];
    for (const se of st.series ?? []) {
      if (!se.folder) continue;
      const row = document.createElement('div');
      row.className = 'upload-series-row';
      row.dataset.folder = se.folder;
      const selected = isFolderSelected(se.folder);
      row.classList.toggle('unselected', !selected);

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'upload-row-check';
      check.checked = selected;
      check.addEventListener('change', () => {
        if (!se.folder) return;
        if (check.checked) deselectedFolders.delete(se.folder);
        else deselectedFolders.add(se.folder);
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

      // First meta line: modality, orientation, slice thickness/spacing, count.
      // Mirrors the format used in the Studio thumbnail meta so the user sees
      // the same numbers they were just looking at.
      const tech: string[] = [];
      if (se.modality) tech.push(se.modality);
      if (se.orientation) tech.push(se.orientation);
      if (se.slice_thickness != null) {
        const th = se.slice_thickness;
        const sp = se.slice_spacing;
        if (sp == null) tech.push(`${fmtMm(th)} mm`);
        else if (sp > th + 0.01) tech.push(`${fmtMm(th)}+${fmtMm(sp - th)} mm`);
        else tech.push(`${fmtMm(th)}/${fmtMm(sp)} mm`);
      }
      tech.push(`${se.slice_count} slice${se.slice_count === 1 ? '' : 's'}`);
      const meta = document.createElement('div');
      meta.className = 'upload-row-meta';
      meta.textContent = `Study ${si + 1} · ${tech.join(' · ')}`;
      body.appendChild(meta);

      // Second meta line: stack size, per-slice size, transfer syntax.
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

      body.appendChild(buildSeriesStudyForm(se));
      row.appendChild(body);
      uploadSeriesListEl.appendChild(row);
    }
  }
}

// Per-series Study form ------------------------------------------------------
// Carries the Study fields the user can edit: modality (required) and plane
// (free text — Radiopaedia's web form is a typeahead with axial / coronal /
// sagittal suggestions). Writes go straight into studyByFolder and
// re-validate the form.
function buildSeriesStudyForm(se: SeriesSummary): HTMLDivElement {
  const folder = se.folder!;
  // Ensure we have a Study object for this folder so the controls have
  // somewhere to write. Default-pick modality from the DICOM tag and seed
  // plane from the DICOM-derived orientation where we can.
  let current = studyByFolder.get(folder);
  if (!current) {
    const guess = defaultModalityForSeries(se.modality);
    const plane = se.orientation ? titleCase(se.orientation) : undefined;
    current = { modality: (guess ?? '') as Modality, plane };
    if (guess || plane) studyByFolder.set(folder, current);
  } else if (current.plane === undefined && se.orientation) {
    // Late-bind plane if a prior render created the Study without it.
    current = { ...current, plane: titleCase(se.orientation) };
    studyByFolder.set(folder, current);
  }

  const wrap = document.createElement('div');
  wrap.className = 'series-study';
  // Block clicks from reaching the <li> (which opens the viewer).
  wrap.addEventListener('click', (ev) => ev.stopPropagation());

  const modLabel = document.createElement('label');
  modLabel.textContent = 'Modality';
  const modSelect = document.createElement('select');
  modSelect.className = 'series-modality';
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
  modSelect.value = current.modality || '';
  modSelect.addEventListener('change', () => {
    const existing = studyByFolder.get(folder) ?? { modality: '' as Modality };
    if (modSelect.value) {
      studyByFolder.set(folder, { ...existing, modality: modSelect.value as Modality });
    } else {
      // Selecting "(pick modality)" invalidates the series — keep other
      // fields but blank the modality so validation trips.
      studyByFolder.set(folder, { ...existing, modality: '' as Modality });
    }
    refreshCaseFormUI();
    persistCaseDraft();
  });
  modLabel.appendChild(modSelect);

  // Plane — free text with typeahead suggestions, matching Radiopaedia's UI.
  const planeLabel = document.createElement('label');
  planeLabel.textContent = 'Plane';
  const planeInput = document.createElement('input');
  planeInput.type = 'text';
  planeInput.className = 'series-plane';
  planeInput.placeholder = 'e.g. Axial';
  planeInput.setAttribute('list', 'series-plane-options');
  planeInput.value = current.plane ?? '';
  planeInput.addEventListener('input', () => {
    const existing = studyByFolder.get(folder) ?? { modality: '' as Modality };
    studyByFolder.set(folder, { ...existing, plane: planeInput.value });
    persistCaseDraft();
  });
  planeLabel.appendChild(planeInput);

  wrap.append(modLabel, planeLabel);
  return wrap;
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
    doneTitle.textContent = `Loaded ${nSeries} series from ${basename(folderPath)}`;
    // No drop-details for load — nothing was dropped/scrubbed.
    dropDetails.hidden = true;
    hydrateCaseForm(studyMeta, anonOutput);
    setState('done');
    persistLastFolder(folderPath);
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
    // Seed a Study entry for the newly-appended derived series so the user
    // isn't forced to re-pick modality when it can be guessed from the tag.
    if (next.folder && !studyByFolder.has(next.folder)) {
      const guess = defaultModalityForSeries(next.modality);
      if (guess) studyByFolder.set(next.folder, { modality: guess });
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
    // Drop the per-series Study state for this folder so it stops gating
    // the upload button and doesn't round-trip through the draft.
    if (se.folder) studyByFolder.delete(se.folder);
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
  closeViewer();
  pending = null;
  anonOutput = null;
  studyMeta = null;
  dropDetails.hidden = true;
  dropDetails.open = false;
  dropDetailsBody.innerHTML = '';
  renderStudySummary();
  log.textContent = '';
  try { sessionStorage.removeItem(LAST_FOLDER_KEY); } catch { /* ignore */ }
  // Clear the case-draft too: a full reset shouldn't bleed the old case's
  // title/history into the next study the user drops in.
  clearCaseDraft();
  resetCaseForm();
  uploadSeriesListEl.innerHTML = '';
  setState('idle');
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
const CASE_DRAFT_VERSION = 3; // bumped when selected[] added for upload-series picker.

type CaseFormShape = Omit<Case, 'source_summary' | 'output_root'>;

interface CaseDraft {
  v: number;
  case: CaseFormShape;
  studies: Array<[string, Study]>; // [folder, Study]
  deselected?: string[]; // folders the user excluded from the upload
}

// Per-series Study state, keyed by the series folder.
const studyByFolder = new Map<string, Study>();

// Folders the user has chosen NOT to upload. We store deselections rather than
// selections so newly-discovered series default to included.
const deselectedFolders = new Set<string>();
function isFolderSelected(folder: string): boolean {
  return !deselectedFolders.has(folder);
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

// Collect every Study we have a form for that corresponds to a series still
// present in the current summary. Ordered by study-in-summary, then by
// series-in-study to match how the thumbnails render.
function collectStudies(): Array<{ folder: string; study: Study }> {
  const out: Array<{ folder: string; study: Study }> = [];
  if (!studyMeta?.studies) return out;
  for (const st of studyMeta.studies) {
    for (const se of st.series ?? []) {
      if (!se.folder) continue;
      if (!isFolderSelected(se.folder)) continue;
      const s = studyByFolder.get(se.folder);
      if (s) out.push({ folder: se.folder, study: s });
    }
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

  // Every SELECTED series must have a modality picked. Deselected series are
  // excluded from the upload, so we don't validate them.
  const series = (studyMeta?.studies ?? [])
    .flatMap((st) => st.series ?? [])
    .filter((s) => s.folder && isFolderSelected(s.folder));
  if (series.length === 0) {
    return { ok: false, message: 'Select at least one series to upload.' };
  }
  for (const se of series) {
    const s = se.folder ? studyByFolder.get(se.folder) : undefined;
    if (!s?.modality) {
      return {
        ok: false,
        message: `Pick a modality for "${se.description || 'unnamed series'}".`,
      };
    }
  }
  return { ok: true, message: '' };
}

function refreshCaseFormUI(): void {
  updateCounter(caseTitleCounter, caseTitle.value, CASE_TITLE_MAX);
  const v = validateCaseForm();
  caseValidation.textContent = v.message;
  caseValidation.classList.toggle('error', !v.ok);
  btnCaseReady.disabled = !v.ok;
  // Reflect per-series validity on any open select. Selects live inside the
  // upload-series rows; only flag rows that are actually selected for upload.
  for (const sel of uploadSeriesListEl.querySelectorAll<HTMLSelectElement>('.series-modality')) {
    const row = sel.closest<HTMLDivElement>('.upload-series-row');
    const folder = row?.dataset.folder ?? '';
    const selected = folder ? isFolderSelected(folder) : true;
    sel.classList.toggle('invalid', selected && sel.value === '');
  }
}

function persistCaseDraft(): void {
  try {
    const payload: CaseDraft = {
      v: CASE_DRAFT_VERSION,
      case: readCaseForm(),
      studies: Array.from(studyByFolder.entries()),
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
  studyByFolder.clear();
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

  // Seed per-series studies for any series we have a draft for, then fill in
  // the rest by default-picking modality from the series' DICOM modality tag.
  if (draft?.studies) {
    for (const [folder, study] of draft.studies) {
      studyByFolder.set(folder, { ...study });
    }
  }
  // Restore selection state. Only retain deselections for folders that still
  // exist in the current summary, so stale entries can't quietly drop a series.
  deselectedFolders.clear();
  if (draft?.deselected) {
    const liveFolders = new Set<string>();
    for (const st of summary.studies ?? []) {
      for (const se of st.series ?? []) {
        if (se.folder) liveFolders.add(se.folder);
      }
    }
    for (const folder of draft.deselected) {
      if (liveFolders.has(folder)) deselectedFolders.add(folder);
    }
  }
  for (const st of summary.studies ?? []) {
    for (const se of st.series ?? []) {
      if (!se.folder) continue;
      if (studyByFolder.has(se.folder)) continue;
      const guess = defaultModalityForSeries(se.modality);
      const study: Study = {
        modality: (guess ?? '') as Modality, // empty until user picks if no guess
      };
      if (guess) studyByFolder.set(se.folder, study);
      // If guess is null, leave unset so validation fails until user picks.
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
  // Upload is still a future issue. For now log the request bodies so the
  // flow is visible end-to-end: one Case create + one Study create per series
  // (positions start at 2; position 1 is the discussion slot).
  const casePayload = buildCaseCreatePayload(fullCase);
  const studies = collectStudies();
  const studyPayloads = studies.map(
    ({ study }, i) => buildStudyCreatePayload(study, i + 2),
  );
  write(`case ready — ${form.title} (${studies.length} stud${studies.length === 1 ? 'y' : 'ies'})`);
  console.info('[renderer] case create payload:', casePayload);
  console.info('[renderer] study create payloads:', studyPayloads);
});

// Try to restore any previously-saved draft at startup — harmless if no
// summary is loaded yet, because the fields will be hidden until one is.
const bootDraft = restoreCaseDraft();
if (bootDraft) {
  writeCaseForm(bootDraft.case);
  for (const [folder, study] of bootDraft.studies) {
    studyByFolder.set(folder, { ...study });
  }
  if (bootDraft.deselected) {
    for (const f of bootDraft.deselected) deselectedFolders.add(f);
  }
  refreshCaseFormUI();
}

setState('idle');
loadPresets();
void restoreLastFolder();
