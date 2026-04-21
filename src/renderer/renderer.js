console.log('[renderer] script loaded');

const drop = document.getElementById('drop');
const log = document.getElementById('log');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');

console.log('[renderer] elements:', { drop, log, progressWrap, progressBar, progressLabel });
console.log('[renderer] window.backend:', window.backend, 'window.fsBridge:', window.fsBridge);

function write(msg) {
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
  console.log('[renderer]', msg);
}

write('ready');

function showProgress(total) {
  progressBar.max = Math.max(total, 1);
  progressBar.value = 0;
  progressLabel.textContent = `0 / ${total}`;
  progressWrap.classList.add('active');
}

function updateProgress(done, total) {
  progressBar.value = done;
  progressLabel.textContent = `${done} / ${total}`;
}

function hideProgress() {
  progressWrap.classList.remove('active');
}

function deriveOutputPath(inputPath, isDirectory) {
  if (isDirectory) {
    return inputPath.replace(/\/+$/, '') + '_anon';
  }
  const slash = inputPath.lastIndexOf('/');
  const base = slash >= 0 ? inputPath.slice(slash + 1) : inputPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return inputPath + '_anon';
  return inputPath.slice(0, slash + 1 + dot) + '_anon' + inputPath.slice(slash + 1 + dot);
}

async function anonymize(inputPath) {
  const port = await window.backend.getPort();
  if (!port) {
    write('error: backend not ready');
    return;
  }
  const isDir = await window.fsBridge.isDirectory(inputPath);
  const outputPath = deriveOutputPath(inputPath, isDir);

  write(`anonymizing ${isDir ? 'folder' : 'file'}: ${inputPath}`);
  let total = 0;
  let done = 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/anonymize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: inputPath, output: outputPath }),
    });
    if (!res.ok) {
      const body = await res.text();
      write(`error ${res.status}: ${body}`);
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
        const evt = JSON.parse(line);
        handleEvent(evt);
      }
    }
    // Drain any trailing buffered line (shouldn't normally happen).
    if (buffer.trim()) handleEvent(JSON.parse(buffer.trim()));
  } catch (e) {
    write(`error: ${e.message || e}`);
    hideProgress();
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case 'start':
        total = evt.total;
        showProgress(total);
        break;
      case 'file':
        done += 1;
        updateProgress(done, total);
        if (total === 1) {
          write(`  kept ${evt.kept}, dropped ${evt.dropped}${evt.dropped_tags.length ? ': ' + evt.dropped_tags.join(', ') : ''}`);
        }
        break;
      case 'error':
        done += 1;
        updateProgress(done, total);
        write(`  error: ${evt.input}: ${evt.error}`);
        break;
      case 'done':
        hideProgress();
        write(`wrote ${evt.count} file(s) to ${evt.output}${evt.error_count ? ` (${evt.error_count} error(s))` : ''}`);
        break;
      default:
        write(`unexpected response (old backend? restart the app): ${JSON.stringify(evt).slice(0, 200)}`);
    }
  }
}

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
  console.log('[renderer] drop event', e);
  console.log('[renderer] dataTransfer.files:', e.dataTransfer?.files);
  console.log('[renderer] dataTransfer.items:', e.dataTransfer?.items);
  const files = Array.from(e.dataTransfer?.files || []);
  log.textContent = '';
  hideProgress();
  write(`drop: ${files.length} item(s)`);
  if (files.length === 0) {
    write('no file dropped');
    return;
  }
  for (const f of files) {
    const p = window.fsBridge.pathForFile(f);
    write(`  path: ${p || '(none)'} name=${f.name} type=${f.type}`);
    if (!p) {
      write('dropped item has no path (not a file?)');
      continue;
    }
    anonymize(p);
  }
});
