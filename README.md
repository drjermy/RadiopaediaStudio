# Radiopaedia Studio

Desktop app for preparing and uploading DICOM cases to Radiopaedia. Anonymise,
view, reformat, window, trim, and compress DICOM studies locally, then (once
the API integration lands) push finished cases straight to Radiopaedia.

Electron (TypeScript) frontend + Python (FastAPI + pydicom) backend + Node
sidecar (dicomanon) for anonymisation — one installer, three processes
communicating over localhost HTTP.

See `pacs-anonymizer-handoff.md` for the original project plan (historical)
and `pre-radiopaedia-review.md` for the pre-upload-integration review.

## Development

### One-time setup

```sh
# Backend: create venv and install the FastAPI app (+ pytest for tests)
python3 -m venv backend/.venv
backend/.venv/bin/pip install -e 'backend[dev]'

# Node sidecar (dicomanon anonymiser)
cd backend-js && npm install && cd ..

# Frontend: install Electron + TypeScript
npm install
```

Requires Python 3.11+.

### Running

```sh
npm run dev
```

Compiles TypeScript and launches Electron. The main process spawns the Python
backend and the Node sidecar on free `127.0.0.1` ports, waits for `/health`,
then opens the window. Drop a `.dcm` file or folder onto the drop zone — the
anonymised output is written alongside it with an `_anon` suffix.

### Tests

```sh
backend/.venv/bin/pytest backend/tests/
```

Covers the Python `scrub()` core: PHI stripping, UID regeneration, de-id flag
setting, private-tag removal, nested SQ handling. Tests target **invariants**,
not specific tag lists — adding a tag to `KEEP_TAGS` shouldn't require updating
tests. The Node sidecar does not yet have its own tests.

### Packaging

```sh
npm run build:backend   # PyInstaller → backend/dist/radiopaedia-studio-backend/
npm run pack            # unpacked .app in build/mac-arm64/
npm run dist            # full .dmg in build/
```

`pack`/`dist` call `build:backend` first. The backend is shipped as a
standalone PyInstaller onedir (~40 MB) at `Contents/Resources/backend-bin/`
inside the `.app`. The packaged build runs without a Python install on the
user's machine.

Currently arm64-only. Adding x64 / universal2 requires either running the
PyInstaller step on an x64 host or switching to universal2 target — not
wired yet.

## Architecture

```
Electron main (dist/main/index.js)
 ├─ python-manager.ts   picks free port → spawns Python backend → waits on /health
 ├─ node-manager.ts     picks free port → spawns Node sidecar  → waits on /health
 └─ preload.ts           exposes backend.getPort(), nodeBackend.getPort(),
                         fsBridge, dialog, and shell bridges to the renderer

Renderer (src/renderer/)
 ├─ plain HTML/JS UI with Cornerstone3D viewer
 └─ POSTs {input, output} paths to whichever backend owns the route

Python backend (backend/app/)
 ├─ main.py              FastAPI: scan, thumbnails, trim, transform (reformat +
 │                       window + compress), series-info, delete-series, files
 ├─ anonymizer.py        allowlist-based pydicom scrub (vendored from dicom-dev-kit)
 ├─ reformat.py          MPR volume → new series at target orientation/spacing
 ├─ windowing.py         apply WindowCenter/WindowWidth (+ presets)
 ├─ compress.py          J2K lossless / lossy recompress
 └─ thumbnails.py        middle-slice PNG thumbnails

Node sidecar (backend-js/)
 └─ server.mjs           /anonymize via dicomanon (Radiopaedia's own anonymiser)
```

IPC is **path-based, not multipart** — Electron and the backends share the
filesystem, so we pass absolute paths rather than streaming bytes.

**Why two backends?** Anonymisation goes through Radiopaedia's own
`dicomanon` (Node) so anonymised output matches what the Radiopaedia pipeline
expects. Everything else (MPR, windowing, compression, thumbnails) stays in
Python where pydicom + numpy are the right tools.

## Known gaps (v0.1)

- **No code signing / notarisation.** `identity: null` in `electron-builder.yml`
  — Gatekeeper will block the app on first launch until right-click → Open.
- **arm64 only.** The bundled PyInstaller binary is host-arch. Needs universal2
  work or a parallel x64 build for Intel Macs.
- **macOS only for now.** Windows/Linux builds are planned — Electron +
  PyInstaller + Node sidecar are all cross-platform, so this is a packaging
  task rather than a porting one.
- **No Radiopaedia API integration yet.** See `pre-radiopaedia-review.md` for
  the foundation work that should land alongside it.
