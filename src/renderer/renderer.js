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
const doneSummary = document.getElementById('done-summary');
const outputsList = document.getElementById('outputs-list');

const btnAnonymise = document.getElementById('btn-anonymise');
const btnCancelInspect = document.getElementById('btn-cancel-inspect');
const btnReset = document.getElementById('btn-reset');
const btnCreateVersion = document.getElementById('btn-create-version');
const opTypeSelect = document.getElementById('op-type');
const windowPresetSelect = document.getElementById('window-preset');

// State ---------------------------------------------------------------------
let state = 'idle'; // 'idle' | 'inspected' | 'processing' | 'done'
let pending = null; // { input, output, kind, name, dicom_count, total_bytes }
let anonOutput = null; // path string — source for additional versions
let outputs = []; // [{ label, path, kind }]
let windowPresets = {};

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

function renderOutputs() {
  outputsList.innerHTML = '';
  for (const out of outputs) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'out-label';
    label.textContent = out.label;
    const pathEl = document.createElement('span');
    pathEl.className = 'out-path';
    pathEl.textContent = out.path;
    const btn = document.createElement('button');
    btn.textContent = 'Reveal';
    btn.addEventListener('click', () => window.shellBridge.reveal(out.path));
    li.append(label, pathEl, btn);
    outputsList.appendChild(li);
  }
}

// Streaming runner ----------------------------------------------------------
async function runStream(url, body, totalHint) {
  const port = await window.backend.getPort();
  if (!port) throw new Error('backend not ready');

  progressBar.max = Math.max(totalHint, 1);
  progressBar.value = 0;
  progressLabel.textContent = `0 / ${totalHint}`;

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
  const aggregateDrops = new Map();
  let final = null;

  const consume = (line) => {
    const evt = JSON.parse(line);
    switch (evt.type) {
      case 'start':
        break;
      case 'file':
        done += 1;
        progressBar.value = done;
        progressLabel.textContent = `${done} / ${totalHint}`;
        for (const tag of evt.dropped_tags || []) {
          aggregateDrops.set(tag, (aggregateDrops.get(tag) || 0) + 1);
        }
        break;
      case 'error':
        done += 1;
        progressBar.value = done;
        progressLabel.textContent = `${done} / ${totalHint}`;
        write(`  error: ${evt.input}: ${evt.error}`);
        break;
      case 'done':
        final = evt;
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
  return { ...final, aggregateDrops };
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
  processingSummary.textContent =
    pending.kind === 'folder'
      ? `Anonymising ${pending.dicom_count} files → ${pending.output}`
      : `Anonymising ${pending.name} → ${pending.output}`;
  setState('processing');

  try {
    const result = await runStream(
      '/anonymize',
      { input: pending.input, output: pending.output },
      pending.dicom_count,
    );

    anonOutput = result.output;
    outputs = [{ label: 'Anonymised', path: result.output, kind: pending.kind }];
    renderOutputs();

    const topDrops = [...result.aggregateDrops.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([tag, n]) => pending.kind === 'folder' ? `${tag} (${n})` : tag)
      .join(', ');
    doneTitle.textContent = result.error_count > 0
      ? `Anonymised — ${result.count} written, ${result.error_count} failed`
      : `Anonymised — ${result.count} file${result.count === 1 ? '' : 's'} written`;
    doneSummary.textContent = topDrops
      ? `Dropped: ${topDrops}${result.aggregateDrops.size > 4 ? ' …' : ''}`
      : 'No tags dropped';
    setState('done');
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('inspected');
  }
}

// Additional versions -------------------------------------------------------
async function createVersion() {
  if (!anonOutput) return;
  const op = opTypeSelect.value;
  if (op !== 'window') return; // only window wired for now

  const preset = windowPresetSelect.value;
  const config = windowPresets[preset];
  if (!config) return;

  const output = appendOutputSuffix(anonOutput, preset, pending.kind);
  processingSummary.textContent = `Applying ${preset} window → ${output}`;
  setState('processing');

  try {
    const result = await runStream(
      '/window',
      { input: anonOutput, output, center: config.center, width: config.width },
      pending.dicom_count,
    );
    outputs.push({ label: `Windowed (${preset})`, path: result.output, kind: pending.kind });
    renderOutputs();
    setState('done');
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('done');
  }
}

async function loadWindowPresets() {
  const port = await window.backend.getPort();
  if (!port) return;
  const res = await fetch(`http://127.0.0.1:${port}/window/presets`);
  if (!res.ok) return;
  windowPresets = await res.json();
  windowPresetSelect.innerHTML = '';
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

// Buttons -------------------------------------------------------------------
btnAnonymise.addEventListener('click', runAnonymise);
btnCancelInspect.addEventListener('click', () => { pending = null; setState('idle'); });
btnCreateVersion.addEventListener('click', createVersion);
btnReset.addEventListener('click', () => {
  pending = null;
  anonOutput = null;
  outputs = [];
  renderOutputs();
  log.textContent = '';
  setState('idle');
});

setState('idle');
loadWindowPresets();
