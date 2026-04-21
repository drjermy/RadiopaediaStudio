// Plain JS renderer — kept out of TS build for simplicity in v0.1.
const drop = document.getElementById('drop');
const log = document.getElementById('log');

function write(msg) {
  const stamp = new Date().toLocaleTimeString();
  log.textContent += `[${stamp}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}

async function anonymize(inputPath) {
  const port = await window.backend.getPort();
  if (!port) {
    write('error: backend not ready');
    return;
  }
  const dot = inputPath.lastIndexOf('.');
  const outputPath = dot > 0
    ? inputPath.slice(0, dot) + '_anon' + inputPath.slice(dot)
    : inputPath + '_anon';

  write(`anonymizing ${inputPath}`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/anonymize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: inputPath, output: outputPath }),
    });
    const body = await res.json();
    if (!res.ok) {
      write(`error ${res.status}: ${body.detail || JSON.stringify(body)}`);
      return;
    }
    write(`wrote ${body.output}`);
    write(`  kept ${body.kept}, dropped ${body.dropped}${body.dropped_tags.length ? ': ' + body.dropped_tags.join(', ') : ''}`);
  } catch (e) {
    write(`error: ${e.message || e}`);
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
  const files = Array.from(e.dataTransfer?.files || []);
  log.textContent = '';
  if (files.length === 0) {
    write('no file dropped');
    return;
  }
  for (const f of files) {
    const p = window.fsBridge.pathForFile(f);
    if (!p) {
      write('dropped item has no path (not a file?)');
      continue;
    }
    anonymize(p);
  }
});
