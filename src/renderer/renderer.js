// Elements ------------------------------------------------------------------
const drop = document.getElementById('drop');
const panelInspected = document.getElementById('panel-inspected');
const panelProcessing = document.getElementById('panel-processing');
const panelDone = document.getElementById('panel-done');
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
const btnCreateVersion = document.getElementById('btn-create-version');

const reformatOrientation = document.getElementById('reformat-orientation');
const reformatThickness = document.getElementById('reformat-thickness');
const reformatMode = document.getElementById('reformat-mode');
const addVersionPanel = document.getElementById('add-version');
const addVersionTitle = document.getElementById('add-version-title');
const baseSeriesSelect = document.getElementById('base-series');
const windowPresetSelect = document.getElementById('window-preset');
const versionSuffixPreview = document.getElementById('version-suffix-preview');

// State ---------------------------------------------------------------------
let state = 'idle'; // 'idle' | 'inspected' | 'processing' | 'done'
let pending = null;
let anonOutput = null;
let windowPresets = {};
let studyMeta = null; // { studies: [{ ..., series: [...] }, ...] }
let selectedStudyIndex = null;
let selectedSeriesIndex = null;

// Helpers -------------------------------------------------------------------
function write(msg) {
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
  console.log('[renderer]', msg);
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
  panelInspected.classList.toggle('active', next === 'inspected');
  panelProcessing.classList.toggle('active', next === 'processing');
  panelDone.classList.toggle('active', next === 'done');
  btnReset.hidden = next === 'idle';
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

// Version configuration -----------------------------------------------------
function parseThickness(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;
  if (raw.includes('/')) {
    const [t, s] = raw.split('/').map((v) => parseFloat(v.trim()));
    if (Number.isFinite(t) && Number.isFinite(s) && t > 0 && s > 0) {
      return { thickness: t, spacing: s };
    }
    return null;
  }
  const v = parseFloat(raw);
  if (Number.isFinite(v) && v > 0) return { thickness: v, spacing: v };
  return null;
}

function currentVersionSpec() {
  const orient = reformatOrientation.value;
  const preset = windowPresetSelect.value;
  const thickness = parseThickness(reformatThickness.value);
  const spec = {};
  if (orient && thickness) {
    spec.reformat = {
      orientation: orient,
      thickness: thickness.thickness,
      spacing: thickness.spacing,
      mode: reformatMode.value,
    };
  }
  if (preset) {
    const p = windowPresets[preset];
    if (p) spec.window = { center: p.center, width: p.width };
  }
  return { orient, preset, thickness, spec };
}

function currentSuffix() {
  const { orient, preset, thickness } = currentVersionSpec();
  const parts = [];
  if (orient && thickness) {
    const { thickness: t, spacing: s } = thickness;
    const slab = t === s ? `${t}mm` : `${t}-${s}mm`;
    parts.push(`${orient}-${slab}`);
    const m = reformatMode.value;
    if (m !== 'avg') parts.push(m);
  }
  if (preset) parts.push(preset);
  return parts.join('-');
}

function updateVersionPreview() {
  const suffix = currentSuffix();
  if (suffix) {
    versionSuffixPreview.textContent = '→ _' + suffix;
    versionSuffixPreview.classList.remove('empty');
    btnCreateVersion.disabled = false;
  } else {
    versionSuffixPreview.textContent = 'Pick at least one option';
    versionSuffixPreview.classList.add('empty');
    btnCreateVersion.disabled = true;
  }
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

function selectedSeries() {
  if (selectedStudyIndex == null || selectedSeriesIndex == null) return null;
  const st = studyMeta?.studies?.[selectedStudyIndex];
  return st?.series?.[selectedSeriesIndex] || null;
}

baseSeriesSelect.addEventListener('change', () => {
  const [si, i] = baseSeriesSelect.value.split(',').map((v) => parseInt(v, 10));
  if (Number.isFinite(si) && Number.isFinite(i)) openVersionPanel(si, i);
});

function setStudyCollapsed(studyIdx, collapsed) {
  const block = studySummaryEl.querySelector(`.study-block[data-study-idx="${studyIdx}"]`);
  if (block) block.classList.toggle('collapsed', collapsed);
}

function populateBaseSeriesSelect(studyIdx) {
  baseSeriesSelect.innerHTML = '';
  const st = studyMeta?.studies?.[studyIdx];
  if (!st?.series?.length) return;
  for (let i = 0; i < st.series.length; i++) {
    const se = st.series[i];
    const opt = document.createElement('option');
    opt.value = `${studyIdx},${i}`;
    const tech = [];
    if (se.orientation) tech.push(se.orientation);
    if (se.slice_thickness != null) tech.push(`${se.slice_thickness}mm`);
    tech.push(`${se.slice_count} slice${se.slice_count === 1 ? '' : 's'}`);
    opt.textContent = `${se.description || `series ${i + 1}`}  (${tech.join(' · ')})`;
    baseSeriesSelect.appendChild(opt);
  }
}

function openVersionPanel(studyIdx, seriesIdx) {
  const st = studyMeta?.studies?.[studyIdx];
  if (!st?.series?.[seriesIdx]) return;
  selectedStudyIndex = studyIdx;
  selectedSeriesIndex = seriesIdx;

  populateBaseSeriesSelect(studyIdx);
  baseSeriesSelect.value = `${studyIdx},${seriesIdx}`;

  // Highlight the "+" card of the originating study; clear others.
  for (const card of studySummaryEl.querySelectorAll('.add-card-wrap')) {
    card.classList.toggle('selected', parseInt(card.dataset.studyIdx, 10) === studyIdx);
  }

  // Collapse any study that isn't the one the selection lives in.
  if (studyMeta?.studies?.length) {
    for (let i = 0; i < studyMeta.studies.length; i++) {
      setStudyCollapsed(i, i !== studyIdx);
    }
  }
  addVersionTitle.textContent = 'Create additional version';
  addVersionPanel.hidden = false;
  updateVersionPreview();
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
        if (se.kind === 'derived') li.classList.add('derived');

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

        if (se.kind === 'derived') {
          const tag = document.createElement('span');
          tag.className = 'derived-tag';
          tag.textContent = 'DERIVED';
          li.appendChild(tag);
        }

        const desc = document.createElement('div');
        desc.className = 'series-desc';
        desc.textContent = se.description || '(no description)';
        const tech = [];
        if (se.modality) tech.push(se.modality);
        if (se.orientation) tech.push(se.orientation);
        if (se.slice_thickness != null) tech.push(`${se.slice_thickness}mm`);
        tech.push(`${se.slice_count} slice${se.slice_count === 1 ? '' : 's'}`);
        const meta = document.createElement('div');
        meta.className = 'series-meta';
        meta.textContent = tech.join(' · ');
        li.append(desc, meta);

        ul.appendChild(li);
      }

      // "+" card to open the Create panel without preselecting a specific
      // series beyond this study's first one.
      const addLi = document.createElement('li');
      addLi.className = 'add-card-wrap';
      addLi.dataset.studyIdx = String(si);
      const card = document.createElement('div');
      card.className = 'add-card';
      card.textContent = '+';
      const addLabel = document.createElement('div');
      addLabel.className = 'add-card-label';
      addLabel.textContent = 'New version';
      addLi.append(card, addLabel);
      addLi.addEventListener('click', () => openVersionPanel(si, 0));
      ul.appendChild(addLi);

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

  const isDir = info.kind === 'folder';
  pending = { ...info, output: deriveAnonPath(inputPath, info.kind) };
  inspectedTitle.textContent = isDir ? `Folder: ${info.name}` : `File: ${info.name}`;
  inspectedSummary.textContent = isDir
    ? `${info.dicom_count} DICOM file${info.dicom_count === 1 ? '' : 's'} · ${humanBytes(info.total_bytes)}`
    : humanBytes(info.total_bytes);
  inspectedPath.textContent = info.input;
  setState('inspected');
}

// Anonymise -----------------------------------------------------------------
async function runAnonymise() {
  if (!pending) return;
  processingSummary.textContent = pending.kind === 'folder'
    ? `Anonymising & analysing ${pending.dicom_count} files → ${pending.output}`
    : `Anonymising & analysing ${pending.name} → ${pending.output}`;
  setState('processing');

  try {
    const result = await runStream('/anonymize',
      { input: pending.input, output: pending.output }, { sidecar: 'node' });

    anonOutput = result.output;
    studyMeta = result.summary || null;
    selectedStudyIndex = null;
    selectedSeriesIndex = null;
    addVersionPanel.hidden = true;

    // Node doesn't render thumbnails — ask Python to do a batch pass on the
    // anonymised series folders, then merge results into the summary.
    await attachThumbnails();

    renderStudySummary();
    // Panel stays hidden — user explicitly clicks a "+" card to open it.
    addVersionPanel.hidden = true;
    updateVersionPreview();

    doneTitle.textContent = result.error_count > 0
      ? `Anonymised — ${result.count} written, ${result.error_count} failed`
      : `Anonymised — ${result.count} file${result.count === 1 ? '' : 's'} written`;
    renderDropDetails(result.aggregateDrops, result.count, pending.kind);
    setState('done');
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('inspected');
  }
}

// Additional versions -------------------------------------------------------
async function createVersion() {
  if (!anonOutput) return;
  const suffix = currentSuffix();
  if (!suffix) return;
  const { spec } = currentVersionSpec();

  const series = selectedSeries();
  const inputPath = series?.folder || anonOutput;
  const output = appendOutputSuffix(inputPath, suffix, 'folder');
  processingSummary.textContent = `Creating ${suffix} version → ${output}`;
  setState('processing');

  try {
    await runStream('/transform', { input: inputPath, output, ...spec });
    write(`created ${suffix} → ${output}`);

    // Refresh summary: scan the new folder, build a series entry, append it
    // under the same study the version came from, and re-render.
    await appendNewSeries(output, suffix, selectedStudyIndex);

    setState('done');
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('done');
  }
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
      slice_count: info.slice_count,
      folder: info.folder,
      thumbnail: info.thumbnail,
      kind: 'derived',
      operation: label,
    });
    st.series_count = st.series.length;
    st.total_slices = (st.total_slices || 0) + (info.slice_count || 0);
    renderStudySummary();
    // Re-apply selection highlight to the study the version came from.
    const addCard = studySummaryEl.querySelector(
      `.add-card-wrap[data-study-idx="${studyIdx}"]`,
    );
    if (addCard) addCard.classList.add('selected');
  } catch (e) {
    console.warn('[renderer] series-info fetch failed:', e);
  }
}

async function loadPresets() {
  const port = await window.backend.getPort();
  if (!port) return;
  const res = await fetch(`http://127.0.0.1:${port}/window/presets`);
  if (!res.ok) return;
  windowPresets = await res.json();
  for (const name of Object.keys(windowPresets)) {
    const opt = document.createElement('option');
    opt.value = name;
    const p = windowPresets[name];
    opt.textContent = `${name} (C ${p.center} / W ${p.width})`;
    windowPresetSelect.appendChild(opt);
  }
}

// Drop handling -------------------------------------------------------------
['dragenter', 'dragover'].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.add('hover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  drop.addEventListener(evt, (e) => {
    e.preventDefault();
    drop.classList.remove('hover');
  })
);

drop.addEventListener('drop', (e) => {
  if (state !== 'idle') return;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const p = window.fsBridge.pathForFile(files[0]);
  if (!p) { write('dropped item has no path'); return; }
  inspect(p);
});

// Buttons & config listeners -----------------------------------------------
btnAnonymise.addEventListener('click', runAnonymise);
btnCancelInspect.addEventListener('click', () => { pending = null; setState('idle'); });
btnCreateVersion.addEventListener('click', createVersion);
btnReset.addEventListener('click', () => {
  pending = null;
  anonOutput = null;
  studyMeta = null;
  selectedStudyIndex = null;
  selectedSeriesIndex = null;
  addVersionPanel.hidden = true;
  dropDetails.hidden = true;
  dropDetails.open = false;
  dropDetailsBody.innerHTML = '';
  renderStudySummary();
  log.textContent = '';
  setState('idle');
});

btnRevealMain.addEventListener('click', () => {
  if (anonOutput) window.shellBridge.reveal(anonOutput);
});

for (const el of [reformatOrientation, reformatThickness, reformatMode, windowPresetSelect]) {
  el.addEventListener('input', updateVersionPreview);
  el.addEventListener('change', updateVersionPreview);
}

setState('idle');
loadPresets().then(updateVersionPreview);
