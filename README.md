# PACS Anonymizer

DICOM anonymiser desktop app. Electron (TypeScript) frontend + Python (FastAPI + pydicom) backend, one installer, two processes communicating over localhost HTTP.

See `pacs-anonymizer-handoff.md` for the full project plan.

## Development

### One-time setup

```sh
# Backend: create venv and install the FastAPI app (+ pytest for tests)
python3 -m venv backend/.venv
backend/.venv/bin/pip install -e 'backend[dev]'

# Frontend: install Electron + TypeScript
npm install
```

Requires Python 3.11+.

### Running

```sh
npm run dev
```

Compiles TypeScript and launches Electron. The main process spawns the Python backend on a free `127.0.0.1` port, waits for `/health`, then opens the window. Drop a `.dcm` file onto the drop zone — the anonymised file is written alongside it with an `_anon` suffix.

### Tests

```sh
backend/.venv/bin/pytest backend/tests/
```

Covers the `scrub()` core function: PHI stripping, UID regeneration, de-id flag setting, private-tag removal, nested SQ handling. Tests target **invariants**, not specific tag lists — adding a tag to `KEEP_TAGS` shouldn't require updating tests.

### Packaging

```sh
npm run build:backend   # PyInstaller → backend/dist/pacs-anonymizer-backend/
npm run pack            # unpacked .app in build/mac-arm64/
npm run dist            # full .dmg in build/
```

`pack`/`dist` call `build:backend` first. The backend is shipped as a standalone PyInstaller onedir (~40 MB) at `Contents/Resources/backend-bin/` inside the `.app`. The packaged build runs without a Python install on the user's machine.

Currently arm64-only. Adding x64 / universal2 requires either running the PyInstaller step on an x64 host or switching to universal2 target — not wired yet.

## Architecture

```
Electron main (dist/main/index.js)
 ├─ python-manager.ts   picks free port → spawns backend → waits on /health
 └─ preload.ts           exposes backend.getPort() and fsBridge.pathForFile() to renderer

Renderer (src/renderer/)
 └─ plain HTML + JS drop zone, POSTs {input, output} paths to the backend

Backend (backend/app/)
 ├─ main.py              FastAPI: GET /health, POST /anonymize
 └─ anonymizer.py        allowlist-based pydicom scrub (vendored from dicom-dev-kit)
```

IPC is **path-based, not multipart** — Electron and Python share the filesystem, so we pass absolute paths rather than streaming bytes.

## Known gaps (v0.1)

- **No code signing / notarisation.** `identity: null` in `electron-builder.yml` — Gatekeeper will block the app on first launch until right-click → Open.
- **arm64 only.** The bundled PyInstaller binary is host-arch. Needs universal2 work or a parallel x64 build for Intel Macs.
- **No React.** Intentional for v0.1 per the handoff.
