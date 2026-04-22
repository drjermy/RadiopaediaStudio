// Elements ------------------------------------------------------------------
const drop = document.getElementById('drop');
const btnOpenFolder = document.getElementById('btn-open-folder');
const panelInspected = document.getElementById('panel-inspected');
const panelProcessing = document.getElementById('panel-processing');
const panelDone = document.getElementById('panel-done');
const viewerSection = document.getElementById('viewer-section');
const viewerCanvas = document.getElementById('viewer-canvas');
const viewerTitle = document.getElementById('viewer-title');
const viewerHint = document.getElementById('viewer-hint');
const viewerStatus = document.getElementById('viewer-status');
const btnCloseViewer = document.getElementById('btn-close-viewer');
const btnSaveViewer = document.getElementById('btn-save-viewer');
const viewerPresetSelect = document.getElementById('viewer-preset');
const viewerCompressMode = document.getElementById('viewer-compress-mode');
const viewerCompressRatio = document.getElementById('viewer-compress-ratio');
const viewerCompressRatioLabel = document.getElementById('viewer-compress-ratio-label');
const viewerTrim = document.getElementById('viewer-trim');
const trimStart = document.getElementById('trim-start');
const trimEnd = document.getElementById('trim-end');
const trimFill = document.getElementById('trim-fill');
const trimLabel = document.getElementById('trim-label');
const btnTrim = document.getElementById('btn-trim');
const log = document.getElementById('log');

const inspectedTitle = document.getElementById('inspected-title');
const inspectedSummary = document.getElementById('inspected-summary');
const inspectedPath = document.getElementById('inspected-path');
const processingSummary = document.getElementById('processing-summary');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const doneTitle = document.getElementById('done-title');
const btnRevealMain = document.getElementById('btn-reveal-main');
const dropDetails = document.getElementById('drop-details');
const dropDetailsBody = document.getElementById('drop-details-body');
const studySummaryEl = document.getElementById('study-summary');

const btnAnonymise = document.getElementById('btn-anonymise');
const btnCancelInspect = document.getElementById('btn-cancel-inspect');
const btnReset = document.getElementById('btn-reset');

// State ---------------------------------------------------------------------
let state = 'idle'; // 'idle' | 'inspected' | 'processing' | 'done'
let pending = null;
let anonOutput = null;
let windowPresets = {};
let studyMeta = null; // { studies: [{ ..., series: [...] }, ...] }
let viewerContext = null; // { studyIdx, seriesIdx, folder } for Save
let viewerState = null;   // latest { isVolume, orientation, slabThickness, slabSpacing, center, width }
let trimCount = 0;

// Helpers -------------------------------------------------------------------
function write(msg) {
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  for (let i = 0; i < units.length; i++) {
    if (v < 1024 || i === units.length - 1) return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
    v /= 1024;
  }
  return `${n} B`;
}

function setState(next) {
  state = next;
  drop.style.display = next === 'idle' ? '' : 'none';
  if (btnOpenFolder) btnOpenFolder.hidden = next !== 'idle';
  panelInspected.classList.toggle('active', next === 'inspected');
  panelProcessing.classList.toggle('active', next === 'processing');
  panelDone.classList.toggle('active', next === 'done');
  btnReset.hidden = next === 'idle';
}

function basename(p) {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function appendOutputSuffix(basePath, suffix, kind) {
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

function deriveAnonPath(inputPath, kind) {
  return appendOutputSuffix(inputPath, 'anon', kind);
}

async function attachThumbnails() {
  if (!studyMeta?.studies?.length) return;
  const folders = [];
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
      body: JSON.stringify({ folders }),
    });
    if (!res.ok) return;
    const map = await res.json();
    for (const st of studyMeta.studies) {
      for (const se of st.series || []) {
        if (se.folder && map[se.folder]) se.thumbnail = map[se.folder];
      }
    }
  } catch (e) {
    console.warn('[renderer] thumbnail fetch failed:', e);
  }
}

function renderDropDetails(aggregateDrops, fileCount, kind) {
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
async function runStream(url, body, { sidecar = 'python' } = {}) {
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
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status}: ${err}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let done = 0;
  let total = 0;
  const aggregateDrops = new Map();
  let final = null;

  const consume = (line) => {
    const evt = JSON.parse(line);
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
        final = { ...(final || {}), summary: { studies: evt.studies } };
        break;
      case 'done':
        final = { ...(final || {}), ...evt };
        break;
    }
  };

  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) consume(line);
    }
  }
  if (buffer.trim()) consume(buffer.trim());
  return { ...(final || {}), aggregateDrops };
}

// Viewer --------------------------------------------------------------------
async function openViewerForSeries(studyIdx, seriesIdx, opts = {}) {
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
    write(`viewer error: ${e.message || e}`);
    closeViewer();
  }
}

async function setupTrim(series) {
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

function currentTrim() {
  if (viewerTrim.hidden || !trimCount) return null;
  const start = parseInt(trimStart.value, 10) || 0;
  const end = parseInt(trimEnd.value, 10) || 0;
  if (start === 0 && end === trimCount - 1) return null; // untouched
  return { start, end };
}

function updateTrimUI() {
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
function updateTrimButtonState() {
  if (!btnTrim) return;
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  const moved = !(lo === 0 && hi === trimCount - 1);
  const vs = viewerState;
  const indicesAreSourceSlices = vs
    && (!vs.isVolume || (vs.isVolume && vs.isAtNative));
  btnTrim.disabled = !moved || !indicesAreSourceSlices || !viewerContext?.folder;
}

function pushTrimRangeToViewer() {
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
  if (btnTrim.disabled || !viewerContext?.folder || viewerContext.studyIdx == null) return;
  const lo = parseInt(trimStart.value, 10);
  const hi = parseInt(trimEnd.value, 10);
  if (!(hi > lo)) return;
  const { folder, studyIdx } = viewerContext;
  const label = `trim-${lo + 1}-${hi + 1}`;
  const output = appendOutputSuffix(folder, label, 'folder');
  btnTrim.disabled = true;
  processingSummary.textContent = `Trimming → ${basename(output)}`;
  setState('processing');
  try {
    await runStream('/trim', { input: folder, output, start: lo, end: hi });
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
    write(`trim failed: ${e.message || e}`);
    setState('done');
    updateTrimButtonState();
  }
});

function closeViewer() {
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
function refreshActiveThumbnail() {
  const active = viewerContext;
  for (const li of studySummaryEl.querySelectorAll('.series-list li')) {
    const match = active
      && String(active.studyIdx)  === li.dataset.studyIdx
      && String(active.seriesIdx) === li.dataset.seriesIdx;
    li.classList.toggle('active', !!match);
  }
}

async function saveViewerAsVersion() {
  if (!viewerContext || !viewerState) return;
  const { studyIdx, folder } = viewerContext;
  const { isVolume, orientation, slabThickness, slabSpacing, center, width } = viewerState;

  const spec = {};
  const suffixParts = [];
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
  setState('processing');

  try {
    if (trim && !spec.reformat && !spec.window && !spec.compress) {
      // Trim only — fast path via /trim (copy subset with fresh UIDs)
      await runStream('/trim', {
        input: folder, output, start: trim.start, end: trim.end,
      });
    } else if (trim) {
      // Combining trim with other ops isn't supported yet — fall through
      // to /transform with the other ops and drop the trim, with a warning.
      write('note: trim is not combined with other ops yet — saved without trim');
      await runStream('/transform', { input: folder, output, ...spec });
    } else {
      await runStream('/transform', { input: folder, output, ...spec });
    }
    await appendNewSeries(output, suffix, studyIdx);
    setState('done');
    write(`saved ${suffix}`);
  } catch (e) {
    write(`save failed: ${e.message || e}`);
    setState('done');
  }
}

btnCloseViewer.addEventListener('click', closeViewer);
btnSaveViewer.addEventListener('click', saveViewerAsVersion);

function fmtMm(mm) {
  return (Math.round(mm * 10) / 10).toString().replace(/\.0$/, '');
}

// Always show thickness/spacing as the slash form ("3/3 mm", "5/2 mm").
// Append "(native)" when both are at the per-orientation floor.
function thicknessLabel({ slabThickness, slabSpacing, isAtNative }) {
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
  const bits = [];
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

function setStudyCollapsed(studyIdx, collapsed) {
  const block = studySummaryEl.querySelector(`.study-block[data-study-idx="${studyIdx}"]`);
  if (block) block.classList.toggle('collapsed', collapsed);
}

function renderStudySummary() {
  studySummaryEl.innerHTML = '';
  if (!studyMeta?.studies?.length) {
    studySummaryEl.hidden = true;
    return;
  }
  studySummaryEl.hidden = false;

  for (let si = 0; si < studyMeta.studies.length; si++) {
    const st = studyMeta.studies[si];
    const block = document.createElement('div');
    block.className = 'study-block';
    block.dataset.studyIdx = String(si);

    const headParts = [];
    if (st.modality) headParts.push(st.modality);
    if (st.body_part) headParts.push(st.body_part);
    if (st.description) headParts.push(st.description);
    const headerText = headParts.join(' · ') || `Study ${si + 1}`;

    const metaBits = [];
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
        const tech = [];
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

        const sizeBits = [];
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

// Inspect -------------------------------------------------------------------
async function inspect(inputPath) {
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
  const info = await res.json();
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
async function runAnonymise() {
  if (!pending) return;
  processingSummary.textContent = pending.kind === 'folder'
    ? `Anonymising & analysing ${pending.dicom_count} files → ${basename(pending.output)}`
    : `Anonymising & analysing ${pending.name} → ${basename(pending.output)}`;
  setState('processing');

  try {
    const result = await runStream('/anonymize',
      { input: pending.input, output: pending.output }, { sidecar: 'node' });

    anonOutput = result.output;
    studyMeta = result.summary || null;

    // Node doesn't render thumbnails — ask Python to do a batch pass on the
    // anonymised series folders, then merge results into the summary.
    await attachThumbnails();

    renderStudySummary();

    doneTitle.textContent = result.error_count > 0
      ? `Anonymised — ${result.count} written, ${result.error_count} failed`
      : `Anonymised — ${result.count} file${result.count === 1 ? '' : 's'} written`;
    renderDropDetails(result.aggregateDrops, result.count, pending.kind);
    setState('done');
    // Remember the anonymised output so Cmd+R reloads it without re-running.
    persistLastFolder(result.output);
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('inspected');
  }
}

// Load (read-only) ----------------------------------------------------------
async function loadFolder(folderPath) {
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
    const summary = await res.json();
    studyMeta = summary;
    anonOutput = folderPath;
    renderStudySummary();
    const nSeries = summary.studies?.reduce((a, s) => a + (s.series?.length ?? 0), 0) ?? 0;
    doneTitle.textContent = `Loaded ${nSeries} series from ${basename(folderPath)}`;
    // No drop-details for load — nothing was dropped/scrubbed.
    dropDetails.hidden = true;
    setState('done');
    persistLastFolder(folderPath);
  } catch (e) {
    write(`load failed: ${e.message || e}`);
    setState('idle');
  }
}

const LAST_FOLDER_KEY = 'radiopaedia-studio:last-folder';

function persistLastFolder(folder) {
  try { sessionStorage.setItem(LAST_FOLDER_KEY, folder); } catch {}
}

async function restoreLastFolder() {
  let saved = null;
  try { saved = sessionStorage.getItem(LAST_FOLDER_KEY); } catch {}
  if (!saved) return;
  // Soft-reload: if the folder vanished between sessions, loadFolder's
  // /scan call will fail cleanly and we fall back to idle.
  await loadFolder(saved);
}

async function appendNewSeries(folder, label, studyIdx) {
  if (studyIdx == null || !studyMeta?.studies?.[studyIdx]) return;
  const port = await window.backend.getPort();
  if (!port) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/series-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, label }),
    });
    if (!res.ok) return;
    const info = await res.json();
    const st = studyMeta.studies[studyIdx];
    st.series.push({
      description: info.description || label,
      modality: info.modality,
      orientation: info.orientation,
      slice_thickness: info.slice_thickness,
      slice_spacing: info.slice_spacing,
      slice_count: info.slice_count,
      total_bytes: info.total_bytes,
      transfer_syntax: info.transfer_syntax,
      folder: info.folder,
      thumbnail: info.thumbnail,
      window_center: info.window_center,
      window_width:  info.window_width,
      operation: label,
    });
    if (info.total_bytes) st.total_bytes = (st.total_bytes || 0) + info.total_bytes;
    st.series_count = st.series.length;
    st.total_slices = (st.total_slices || 0) + (info.slice_count || 0);
    renderStudySummary();
  } catch (e) {
    console.warn('[renderer] series-info fetch failed:', e);
  }
}

async function deleteSeries(studyIdx, seriesIdx) {
  const st = studyMeta?.studies?.[studyIdx];
  const se = st?.series?.[seriesIdx];
  if (!se?.folder) return;
  const label = se.description || `Series ${seriesIdx + 1}`;
  if (!confirm(`Delete "${label}" and its ${se.slice_count ?? '?'} files from disk?\n\n${se.folder}`)) return;
  // Close viewer first if it's showing the series we're about to delete —
  // otherwise Cornerstone holds file handles and the folder can't be removed.
  if (viewerContext?.folder === se.folder) closeViewer();
  const port = await window.backend.getPort();
  if (!port) { write('backend not ready'); return; }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/delete-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: se.folder }),
    });
    if (!res.ok) throw new Error(await res.text());
    // Mutate the study summary and re-render.
    st.series.splice(seriesIdx, 1);
    st.series_count = st.series.length;
    if (se.total_bytes) st.total_bytes = Math.max(0, (st.total_bytes || 0) - se.total_bytes);
    if (se.slice_count) st.total_slices = Math.max(0, (st.total_slices || 0) - se.slice_count);
    renderStudySummary();
    write(`deleted ${label}`);
  } catch (e) {
    write(`delete failed: ${e.message || e}`);
  }
}

async function loadPresets() {
  const port = await window.backend.getPort();
  if (!port) return;
  const res = await fetch(`http://127.0.0.1:${port}/window/presets`);
  if (!res.ok) return;
  windowPresets = await res.json();
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
function bindDropZone(zone, onDrop) {
  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('hover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('hover');
    })
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
  try { sessionStorage.removeItem(LAST_FOLDER_KEY); } catch {}
  setState('idle');
});

btnRevealMain.addEventListener('click', () => {
  if (anonOutput) window.shellBridge.reveal(anonOutput);
});

setState('idle');
loadPresets();
void restoreLastFolder();
