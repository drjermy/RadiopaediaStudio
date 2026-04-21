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
const donePath = document.getElementById('done-path');

const btnAnonymise = document.getElementById('btn-anonymise');
const btnCancelInspect = document.getElementById('btn-cancel-inspect');
const btnReveal = document.getElementById('btn-reveal');
const btnReset = document.getElementById('btn-reset');

// State ---------------------------------------------------------------------
let state = 'idle'; // 'idle' | 'inspected' | 'processing' | 'done'
let pending = null; // { input, output, kind, name, dicom_count, total_bytes }
let result = null;  // { output, count, error_count, aggregate_drops }

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

function deriveOutputPath(inputPath, isDirectory) {
  if (isDirectory) return inputPath.replace(/\/+$/, '') + '_anon';
  const slash = inputPath.lastIndexOf('/');
  const base = slash >= 0 ? inputPath.slice(slash + 1) : inputPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return inputPath + '_anon';
  return inputPath.slice(0, slash + 1 + dot) + '_anon' + inputPath.slice(slash + 1 + dot);
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
  pending = {
    ...info,
    output: deriveOutputPath(inputPath, isDir),
  };
  inspectedTitle.textContent = isDir
    ? `Folder: ${info.name}`
    : `File: ${info.name}`;
  inspectedSummary.textContent = isDir
    ? `${info.dicom_count} DICOM file${info.dicom_count === 1 ? '' : 's'} · ${humanBytes(info.total_bytes)}`
    : `${humanBytes(info.total_bytes)}`;
  inspectedPath.textContent = info.input;
  setState('inspected');
}

// Anonymise -----------------------------------------------------------------
async function runAnonymise() {
  if (!pending) return;
  const port = await window.backend.getPort();
  if (!port) { write('error: backend not ready'); return; }

  processingSummary.textContent =
    pending.kind === 'folder'
      ? `${pending.dicom_count} files → ${pending.output}`
      : `${pending.name} → ${pending.output}`;
  progressBar.max = Math.max(pending.dicom_count, 1);
  progressBar.value = 0;
  progressLabel.textContent = `0 / ${pending.dicom_count}`;
  setState('processing');

  let done = 0;
  const aggregateDrops = new Map(); // tag → count
  const errors = [];

  try {
    const res = await fetch(`http://127.0.0.1:${port}/anonymize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: pending.input, output: pending.output }),
    });
    if (!res.ok) {
      const body = await res.text();
      write(`anonymise failed ${res.status}: ${body}`);
      setState('inspected');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        handleEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer.trim()));
  } catch (e) {
    write(`error: ${e.message || e}`);
    setState('inspected');
    return;
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'start':
        // total is known from inspect; ignore backend total
        break;
      case 'file':
        done += 1;
        progressBar.value = done;
        progressLabel.textContent = `${done} / ${pending.dicom_count}`;
        for (const tag of evt.dropped_tags || []) {
          aggregateDrops.set(tag, (aggregateDrops.get(tag) || 0) + 1);
        }
        break;
      case 'error':
        done += 1;
        progressBar.value = done;
        progressLabel.textContent = `${done} / ${pending.dicom_count}`;
        errors.push({ input: evt.input, error: evt.error });
        write(`  error: ${evt.input}: ${evt.error}`);
        break;
      case 'done':
        result = {
          output: evt.output,
          count: evt.count,
          error_count: evt.error_count,
          aggregateDrops,
        };
        finish();
        break;
    }
  }

  function finish() {
    if (!result) return;
    doneTitle.textContent = result.error_count > 0
      ? `Done — ${result.count} written, ${result.error_count} failed`
      : `Done — ${result.count} file${result.count === 1 ? '' : 's'} written`;

    const topDrops = [...result.aggregateDrops.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([tag, n]) => pending.kind === 'folder' ? `${tag} (${n})` : tag)
      .join(', ');
    doneSummary.textContent = topDrops
      ? `Dropped: ${topDrops}${result.aggregateDrops.size > 4 ? ' …' : ''}`
      : 'No tags dropped';
    donePath.textContent = result.output;
    setState('done');
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
  if (state !== 'idle') return; // drops only accepted from idle
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const f = files[0]; // first item only
  const p = window.fsBridge.pathForFile(f);
  if (!p) { write('dropped item has no path'); return; }
  inspect(p);
});

// Buttons -------------------------------------------------------------------
btnAnonymise.addEventListener('click', runAnonymise);
btnCancelInspect.addEventListener('click', () => {
  pending = null;
  setState('idle');
});
btnReveal.addEventListener('click', () => {
  if (result?.output) window.shellBridge.reveal(result.output);
});
btnReset.addEventListener('click', () => {
  pending = null;
  result = null;
  log.textContent = '';
  setState('idle');
});

setState('idle');
