// Bundle the Cornerstone 3D viewer + its decode worker + copy codec wasm
// files into src/renderer/ so the file:// script/worker loads resolve
// cleanly at runtime.
//
// Two esbuild passes:
//   1. viewer.js          → viewer.bundle.js           (main thread, ESM)
//   2. decodeImageFrameWorker.js → decodeImageFrameWorker.js (worker, ESM)
// Both passes then get their `new URL('<@cornerstonejs/codec-xxx/…>', import.meta.url)`
// calls rewritten to point at local wasm siblings.

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = join(root, 'src', 'renderer');

const specs = [
  { spec: '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm',
    pkgDir: '@cornerstonejs/codec-libjpeg-turbo-8bit',
    local: 'libjpegturbowasm_decode.wasm' },
  { spec: '@cornerstonejs/codec-charls/decodewasm',
    pkgDir: '@cornerstonejs/codec-charls',
    local: 'charlswasm_decode.wasm' },
  { spec: '@cornerstonejs/codec-openjpeg/decodewasm',
    pkgDir: '@cornerstonejs/codec-openjpeg',
    local: 'openjpegwasm_decode.wasm' },
  { spec: '@cornerstonejs/codec-openjph/wasm',
    pkgDir: '@cornerstonejs/codec-openjph',
    local: 'openjphjs.wasm' },
];

const specToLocal = {};
for (const { spec, pkgDir, local } of specs) {
  const pkgJsonPath = join(root, 'node_modules', pkgDir, 'package.json');
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const subpath = './' + spec.split('/').slice(-1)[0];
  const target = pkgJson.exports?.[subpath];
  if (!target) throw new Error(`no export for ${subpath} in ${pkgJsonPath}`);
  const src = resolve(dirname(pkgJsonPath), target);
  if (!existsSync(src)) throw new Error(`wasm not found: ${src}`);
  specToLocal[spec] = { src, local };
}

mkdirSync(outDir, { recursive: true });

for (const { src, local } of Object.values(specToLocal)) {
  cpSync(src, join(outDir, local));
  console.log(`copied ${local}`);
}

function rewriteWasmUrls(filePath) {
  let code = readFileSync(filePath, 'utf8');
  for (const [spec, { local }] of Object.entries(specToLocal)) {
    const pattern = new RegExp(
      'new URL\\(\\s*["\']' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s*,\\s*import\\.meta\\.url\\s*\\)',
      'g',
    );
    const before = code;
    code = code.replace(pattern, `new URL("./${local}", import.meta.url)`);
    if (code !== before) console.log(`  rewrote ${spec} → ./${local}`);
  }
  writeFileSync(filePath, code);
}

async function bundleEntry({ entry, out, label }) {
  console.log(`bundling ${label}…`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: out,
    loader: { '.wasm': 'file' },
    external: ['fs', 'path', 'crypto', 'worker_threads', 'perf_hooks'],
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    legalComments: 'none',
  });
  rewriteWasmUrls(out);
}

await bundleEntry({
  entry: join(root, 'src', 'renderer', 'viewer.js'),
  out: join(outDir, 'viewer.bundle.js'),
  label: 'viewer',
});

// The decode worker source lives inside @cornerstonejs/dicom-image-loader.
// We bundle directly from there — we never commit the raw worker file.
await bundleEntry({
  entry: join(
    root, 'node_modules', '@cornerstonejs', 'dicom-image-loader',
    'dist', 'esm', 'decodeImageFrameWorker.js',
  ),
  out: join(outDir, 'decodeImageFrameWorker.js'),
  label: 'decode worker',
});

console.log('viewer bundles ready');
