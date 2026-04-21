// Node sidecar: runs the Radiopaedia dicom-anonymiser behind a local HTTP
// server. Streams NDJSON events like the Python sidecar so the renderer can
// treat both uniformly. Takes absolute file paths — we share the filesystem
// with the renderer, no multipart uploads.
//
// Usage:   node server.mjs --port 12345

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { Message, Anonymize } from 'dicomanon';

// ---------------------------------------------------------------- args

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});
const PORT = parseInt(values.port ?? process.env.PORT ?? '0', 10);
const HOST = values.host;
if (!PORT) {
  console.error('--port is required');
  process.exit(2);
}

// ---------------------------------------------------------------- helpers

function isDicomFile(filePath) {
  const name = path.basename(filePath);
  if (name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  if (ext === '.dcm' || ext === '.dicom') return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 128);
    fs.closeSync(fd);
    return buf.toString('ascii') === 'DICM';
  } catch {
    return false;
  }
}

function findDicoms(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isDicomFile(full)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// Read a tag from a parsed dict by DICOM keyword. Returns the first value
// or null. dicomanon's dict is keyed by 8-digit hex tags like "00100010".
// We need tag lookups by keyword, so derive them from the dictionary.
import { dictionary } from 'dicomanon';

// dicomanon's dictionary is keyed like "(0020,000D)" but parsed DICOM dicts
// use the flat "0020000D" form. Normalise when building the lookup.
function normKey(k) {
  return k.replace(/[(),]/g, '').toUpperCase();
}

const KEYWORD_TO_TAG = (() => {
  const m = new Map();
  for (const [tagKey, entry] of Object.entries(dictionary)) {
    if (entry?.name) m.set(entry.name, normKey(tagKey));
  }
  return m;
})();

function getTag(dict, keyword) {
  const tagKey = KEYWORD_TO_TAG.get(keyword);
  if (!tagKey) return null;
  const v = dict[tagKey];
  if (!v || !Array.isArray(v.Value) || v.Value.length === 0) return null;
  return v.Value[0];
}

function safeStr(v) {
  if (v == null) return null;
  return String(v).trim() || null;
}

function safeNum(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function classifyOrientation(iop) {
  if (!iop || typeof iop !== 'object' || !iop.Value) {
    // iop may be a TagValue; try to extract Values array
    return null;
  }
}

// We classify from an explicit 6-number IOP array. Use Tag lookup helper
// instead (see commonTags below).
function classifyOrientationArr(values) {
  if (!values || values.length !== 6) return null;
  const r = values.slice(0, 3).map(Number);
  const c = values.slice(3).map(Number);
  if (r.some(Number.isNaN) || c.some(Number.isNaN)) return null;
  const n = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const absN = n.map(Math.abs);
  const idx = absN.indexOf(Math.max(...absN));
  return ['sagittal', 'coronal', 'axial'][idx];
}

function getTagValues(dict, keyword) {
  const tagKey = KEYWORD_TO_TAG.get(keyword);
  if (!tagKey) return null;
  const v = dict[tagKey];
  return v && Array.isArray(v.Value) ? v.Value : null;
}

function commonParent(paths) {
  if (paths.length === 0) return null;
  if (paths.length === 1) return path.dirname(paths[0]);
  const parts = paths.map((p) => p.split(path.sep));
  const out = [];
  const n = Math.min(...parts.map((p) => p.length));
  for (let i = 0; i < n; i++) {
    const first = parts[0][i];
    if (parts.every((p) => p[i] === first)) out.push(first);
    else break;
  }
  return out.length ? out.join(path.sep) || '/' : path.dirname(paths[0]);
}

// ---------------------------------------------------------------- anonymise

function anonymiseBuffer(inputBuffer) {
  // dicomanon wants an ArrayBuffer; Node Buffers are views onto one.
  const ab = inputBuffer.buffer.slice(
    inputBuffer.byteOffset,
    inputBuffer.byteOffset + inputBuffer.byteLength,
  );
  const data = Message.readFile(ab);
  const originalDict = data.dict;
  data.dict = Anonymize(originalDict);
  return { data, originalDict };
}

// Stream NDJSON events for a folder or file input.
async function *iterAnonymise(inputPath, outputPath) {
  const stat = fs.statSync(inputPath);
  const isDir = stat.isDirectory();
  const files = isDir
    ? findDicoms(inputPath)
    : (isDicomFile(inputPath) ? [inputPath] : []);
  const total = files.length;

  yield { type: 'start', mode: isDir ? 'folder' : 'file', total, output: outputPath };

  const studies = new Map(); // StudyInstanceUID -> study dict with ._series Map
  const seriesPaths = new Map(); // SeriesInstanceUID -> [dst paths]
  let count = 0;
  let errorCount = 0;

  for (const src of files) {
    const rel = isDir ? path.relative(inputPath, src) : path.basename(src);
    const dst = isDir ? path.join(outputPath, rel) : outputPath;

    try {
      const inputBuffer = fs.readFileSync(src);
      const { data, originalDict } = anonymiseBuffer(inputBuffer);

      // Collect study/series metadata from the ORIGINAL dict (before anon
      // strips it — StudyDescription, modality, etc.)
      const origStudy = safeStr(getTag(originalDict, 'StudyInstanceUID'));
      const origSeries = safeStr(getTag(originalDict, 'SeriesInstanceUID'));

      if (origStudy && !studies.has(origStudy)) {
        studies.set(origStudy, {
          description: safeStr(getTag(originalDict, 'StudyDescription')),
          modality: safeStr(getTag(originalDict, 'Modality')),
          body_part: safeStr(getTag(originalDict, 'BodyPartExamined')),
          study_date: safeStr(getTag(originalDict, 'StudyDate')),
          total_slices: 0,
          _series: new Map(),
        });
      }
      if (origStudy) {
        const st = studies.get(origStudy);
        st.total_slices += 1;
        if (origSeries && !st._series.has(origSeries)) {
          const iopValues = getTagValues(originalDict, 'ImageOrientationPatient');
          st._series.set(origSeries, {
            description: safeStr(getTag(originalDict, 'SeriesDescription')),
            modality: safeStr(getTag(originalDict, 'Modality')),
            orientation: classifyOrientationArr(iopValues),
            slice_thickness: safeNum(getTag(originalDict, 'SliceThickness')),
            slice_count: 0,
          });
        }
        if (origSeries) {
          st._series.get(origSeries).slice_count += 1;
          if (!seriesPaths.has(origSeries)) seriesPaths.set(origSeries, []);
          seriesPaths.get(origSeries).push(dst);
        }
      }

      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const outAb = data.write();
      fs.writeFileSync(dst, Buffer.from(outAb));

      count += 1;
      yield { type: 'file', input: src, output: dst };
    } catch (e) {
      errorCount += 1;
      yield { type: 'error', input: src, error: `${e.name}: ${e.message}` };
    }
  }

  // Flatten studies -> summary with series + folder paths for downstream
  // thumbnail / reformat targeting.
  const outStudies = [];
  for (const study of studies.values()) {
    const seriesList = [];
    for (const [origUid, s] of study._series.entries()) {
      const paths = seriesPaths.get(origUid) || [];
      seriesList.push({ ...s, folder: commonParent(paths) });
    }
    const { _series, ...rest } = study;
    outStudies.push({ ...rest, series_count: seriesList.length, series: seriesList });
  }
  yield { type: 'summary', studies: outStudies };
  yield { type: 'done', count, error_count: errorCount, output: outputPath };
}

// ---------------------------------------------------------------- server

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/anonymize') {
      const body = await readJson(req);
      if (!body.input || !body.output) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'input and output required' }));
        return;
      }
      if (!fs.existsSync(body.input)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: `input not found: ${body.input}` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for await (const evt of iterAnonymise(body.input, body.output)) {
        res.write(JSON.stringify(evt) + '\n');
      }
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: `${e.name}: ${e.message}` }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[node] listening on http://${HOST}:${PORT}`);
});
