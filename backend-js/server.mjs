// Node sidecar: runs the Radiopaedia dicom-anonymiser behind a local HTTP
// server. Streams NDJSON events like the Python sidecar so the renderer can
// treat both uniformly. Takes absolute file paths — we share the filesystem
// with the renderer, no multipart uploads.
//
// Why this exists: `dicomanon` is Radiopaedia's canonical anonymiser, so the
// upload path runs through it verbatim. Everything else (MPR, windowing,
// compression, thumbnails, scan, trim) lives in the Python backend.
//
// Usage:   node server.mjs --port 12345

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Message, Anonymize } from 'dicomanon';

import {
  classifyOrientationArr,
  classifyTransferSyntax,
  medianSpacing,
  sliceNormal,
} from './classify.mjs';

// Keep absolute filesystem paths out of logs and streaming `error` events —
// once upload/telemetry is live, a pre-anon folder name like
// `PATIENT_SMITH_JOHN_2026` is PHI. Return just enough context (parent-folder
// basename + file basename) for a user to tell which file failed without
// leaking the full tree. Mirrors backend/app/logsafe.py:redact_path().
// See GitHub issue #7.
export function redactPath(p) {
  if (p == null) return '';
  const s = String(p);
  if (!s) return '';
  const norm = s.replace(/\\/g, '/');
  // Strip a leading anchor (POSIX '/' or Windows 'C:/').
  const noAnchor = norm.replace(/^([a-zA-Z]:)?\/+/, '');
  if (!noAnchor) return '';
  const parts = noAnchor.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// Node's built-in error messages (ENOENT, EACCES, etc.) embed absolute
// paths verbatim, e.g. `ENOENT: no such file or directory, open
// '/Volumes/.../PATIENT_SMITH_JOHN/1.dcm'`. Replace any quoted POSIX or
// Windows path with its redacted form, so the error stays informative
// without the ancestor folder names.
export function redactErrorMessage(msg) {
  if (msg == null) return '';
  const s = String(msg);
  // Match '/abs/path' or "/abs/path" or C:\... style paths inside quotes.
  return s.replace(/(['"])((?:[A-Za-z]:)?[\/\\][^'"]+)\1/g, (_m, q, p) => `${q}${redactPath(p)}${q}`);
}

// Top-level side effects (arg parsing, server start) only run when this
// module is executed directly. Importing it for tests should be free.
const IS_MAIN = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

// ---------------------------------------------------------------- args

let PORT = 0;
let HOST = '127.0.0.1';
if (IS_MAIN) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
    },
  });
  PORT = parseInt(values.port ?? process.env.PORT ?? '0', 10);
  HOST = values.host;
  if (!PORT) {
    console.error('--port is required');
    process.exit(2);
  }
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

export function anonymiseBuffer(inputBuffer) {
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
//
// `isCancelled`, if passed, is a zero-arg function that returns true once
// the client has disconnected — the loop checks it before each file and
// bails out mid-stream. Partial output left on disk is intentional
// (matches the Python sidecar's semantics); no cleanup is attempted.
export async function *iterAnonymise(inputPath, outputPath, isCancelled) {
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
    if (isCancelled && isCancelled()) return;
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
          total_bytes: 0,
          _series: new Map(),
        });
      }
      if (origStudy) {
        const st = studies.get(origStudy);
        st.total_slices += 1;
        const fileSize = inputBuffer.length;
        st.total_bytes += fileSize;
        if (origSeries && !st._series.has(origSeries)) {
          const iopValues = getTagValues(originalDict, 'ImageOrientationPatient');
          const tsuid = safeStr(getTag(data.meta, 'TransferSyntaxUID'));
          st._series.set(origSeries, {
            description: safeStr(getTag(originalDict, 'SeriesDescription')),
            modality: safeStr(getTag(originalDict, 'Modality')),
            orientation: classifyOrientationArr(iopValues),
            slice_thickness: safeNum(getTag(originalDict, 'SliceThickness')),
            slice_spacing: safeNum(getTag(originalDict, 'SpacingBetweenSlices')),
            slice_count: 0,
            total_bytes: 0,
            transfer_syntax: classifyTransferSyntax(tsuid),
            _normal: sliceNormal(iopValues),
            _positions: [],
          });
        }
        if (origSeries) {
          const s = st._series.get(origSeries);
          s.slice_count += 1;
          s.total_bytes += fileSize;
          if (!seriesPaths.has(origSeries)) seriesPaths.set(origSeries, []);
          seriesPaths.get(origSeries).push(dst);
          if (s._normal) {
            const ipp = getTagValues(originalDict, 'ImagePositionPatient');
            if (ipp && ipp.length === 3) {
              const p = ipp.map(Number);
              if (p.every(Number.isFinite)) {
                s._positions.push(p[0] * s._normal[0] + p[1] * s._normal[1] + p[2] * s._normal[2]);
              }
            }
          }
        }
      }

      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const outAb = data.write();
      fs.writeFileSync(dst, Buffer.from(outAb));

      count += 1;
      yield { type: 'file', input: src, output: dst };
    } catch (e) {
      errorCount += 1;
      yield { type: 'error', input: redactPath(src), error: `${e.name}: ${e.message}` };
    }
  }

  if (isCancelled && isCancelled()) return;

  // Flatten studies -> summary with series + folder paths for downstream
  // thumbnail / reformat targeting.
  const outStudies = [];
  for (const study of studies.values()) {
    const seriesList = [];
    for (const [origUid, s] of study._series.entries()) {
      const paths = seriesPaths.get(origUid) || [];
      // Prefer spacing computed from ImagePositionPatient — SpacingBetweenSlices
      // is often missing for CT and reconstructions can overlap (3mm thick at
      // 2mm spacing, 600 slices over 300 unique positions).
      const computed = medianSpacing(s._positions);
      const { _positions, _normal, ...rest } = s;
      const spacing = computed != null ? computed : s.slice_spacing;
      seriesList.push({ ...rest, slice_spacing: spacing, folder: commonParent(paths) });
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
        res.end(JSON.stringify({ detail: `input not found: ${redactPath(body.input)}` }));
        return;
      }
      // Client disconnect: flip a flag so the generator can bail out
      // between files. Node's `req` fires 'close' whether the body was
      // fully read or the socket was torn down mid-response, and
      // `aborted` covers explicit abort. We cover both.
      let clientClosed = false;
      const markClosed = () => { clientClosed = true; };
      req.on('aborted', markClosed);
      req.on('close', markClosed);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for await (const evt of iterAnonymise(body.input, body.output, () => clientClosed)) {
        if (clientClosed) break;
        res.write(JSON.stringify(evt) + '\n');
      }
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    // Node error messages routinely embed absolute paths (ENOENT, EACCES).
    // Log the error name and a stack trace minus the message so we keep
    // operationally useful detail without the PHI-shaped folder names.
    console.error(`[server] ${e.name}: ${redactErrorMessage(e.message)}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: `${e.name}: ${redactErrorMessage(e.message)}` }));
    }
  }
});

if (IS_MAIN) {
  server.listen(PORT, HOST, () => {
    console.log(`[node] listening on http://${HOST}:${PORT}`);
  });
}
