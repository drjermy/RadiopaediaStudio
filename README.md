# PACS Anonymizer

DICOM anonymiser desktop app. Electron (TypeScript) frontend + Python (FastAPI + pydicom) backend, one installer, two processes communicating over localhost HTTP.

See `pacs-anonymizer-handoff.md` for the full project plan.

## Development

### One-time setup

```sh
# Backend: create venv and install the FastAPI app
python3 -m venv backend/.venv
backend/.venv/bin/pip install -e backend

# Frontend: install Electron + TypeScript
npm install
```

Requires Python 3.11+.

### Running

```sh
npm run dev
```

Compiles TypeScript and launches Electron. The main process spawns the Python backend on a free `127.0.0.1` port, waits for `/health`, then opens the window. Drop a `.dcm` file onto the drop zone — the anonymised file is written alongside it with an `_anon` suffix.

### Packaging

```sh
npm run pack    # unpacked .app in build/mac-arm64/, for smoke-testing
npm run dist    # full .dmg in build/
```

Output builds currently **do not run standalone** — the packaged `.app` expects a Python venv at `Contents/Resources/backend/.venv/bin/python`, which isn't bundled. Replacing that with a PyInstaller-built binary is the next milestone (see below).

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

- **No PyInstaller bundling yet.** Packaged `.app` won't run without a matching `.venv` on disk. Next milestone.
- **No code signing / notarisation.** `identity: null` in `electron-builder.yml` — Gatekeeper will block the app on first launch until right-click → Open.
- **Drop zone only accepts single files.** Folder / batch support is Phase 1 scope but not wired yet.
- **No React.** Intentional for v0.1 per the handoff.
