# PACS Anonymizer Desktop App — Project Handoff

## Project Summary

A cross-platform (macOS and Windows) desktop application for DICOM anonymization and processing, with planned integration to the Radiopaedia API for direct case upload. The application wraps an existing Python-based DICOM processing pipeline in an Electron frontend, providing a unified user experience while keeping the image processing logic platform-agnostic.

## Goals

1. **Primary goal**: Provide a simple, functional desktop app that anonymizes DICOM files/folders via an existing Python pipeline.
2. **Secondary goal**: Expose additional DICOM manipulation features already written in Python (orientation changes, windowing, slab thickness).
3. **Stretch goal**: In-app DICOM viewing via Cornerstone.js (or Cornerstone3D) and direct upload to Radiopaedia via its API.

## Architecture Overview

The app is a single distributable installer that, under the hood, runs **two processes**:

```
┌─────────────────────────────────────────────────────┐
│                  User-facing app                    │
│  ┌───────────────────────┐   ┌───────────────────┐  │
│  │  Electron frontend    │◄─►│  Python backend   │  │
│  │  (TypeScript + React) │   │  (DICOM pipeline) │  │
│  └───────────────────────┘   └───────────────────┘  │
│           Local HTTP / socket IPC                   │
└─────────────────────────────────────────────────────┘
                         │
                         ▼
              (Optional) Radiopaedia API
```

- **Frontend**: Electron app written in TypeScript with React (or Vue — TBD). Handles file selection, user interaction, progress display, and (eventually) DICOM preview via Cornerstone.js.
- **Backend**: The existing Python DICOM anonymizer (built on pydicom / similar), run as a local HTTP server (e.g. FastAPI or Flask) bundled with the app via PyInstaller.
- **IPC**: Electron frontend communicates with the Python backend over `localhost` HTTP. Simple, well-understood, easy to debug.

### User experience

The user downloads **one installer** for their platform, double-clicks it, and launches **one app**. They are unaware that two processes are running behind the scenes. On launch, Electron spawns the bundled Python backend as a child process; on quit, it shuts the backend down cleanly.

## Cross-platform approach

- **Single codebase** for both macOS and Windows.
- Electron's build tooling (`electron-builder`) produces separate installers from the same source: a `.dmg` for macOS and an `.exe`/`.msi` for Windows.
- The Python backend is also cross-platform; PyInstaller produces a platform-specific binary at build time.
- Linux builds are essentially free if ever needed — just add another build target.
- No platform-specific code branches expected.

## Distribution

- **Initial plan**: GitHub Releases. Upload the macOS and Windows installers as release artifacts. Users download the one matching their OS.
- **Mac App Store** (future, optional): Possible but involves code signing, Apple notarisation, App Store review, and a privacy/data-handling policy — non-trivial for a tool with clinical data implications. Not a priority for v1.

## Development roadmap

### Phase 1 — MVP anonymiser
- [ ] Set up Electron + TypeScript + React project skeleton.
- [ ] Set up Python backend project (FastAPI or Flask wrapping the existing anonymiser).
- [ ] Wire up Electron to spawn/kill the Python backend process on app start/quit.
- [ ] Implement file/folder selection in the frontend.
- [ ] POST files to the backend, receive anonymised output, write to a user-specified location.
- [ ] Build and test installers for macOS and Windows.
- [ ] Publish v0.1 to GitHub Releases.

### Phase 2 — Additional DICOM processing
- [ ] Expose existing Python functions (orientation, windowing, slab thickness) as additional backend endpoints.
- [ ] Add corresponding UI controls in the Electron frontend.

### Phase 3 — Viewing and upload
- [ ] Integrate Cornerstone.js (or Cornerstone3D) for in-app DICOM preview.
- [ ] Add Radiopaedia API integration for direct case upload post-anonymisation.
- [ ] Case metadata entry UI (patient age, modality, clinical context, etc.) feeding into the Radiopaedia upload payload.

## Tech stack summary

| Layer | Choice | Notes |
|---|---|---|
| Frontend shell | Electron | Cross-platform desktop runtime |
| Frontend framework | React + TypeScript | Familiar, well-supported |
| Backend language | Python | Reuses existing anonymiser code |
| Backend framework | FastAPI (preferred) or Flask | HTTP API over localhost |
| DICOM processing | pydicom (existing code) | Already working |
| Backend bundling | PyInstaller | Packages Python as a standalone binary |
| App packaging | electron-builder | Produces `.dmg` and `.exe`/`.msi` |
| DICOM viewing (Phase 3) | Cornerstone.js / Cornerstone3D | Industry standard in-browser DICOM |
| Distribution | GitHub Releases | Simple, free, sufficient for now |

## Proposed repository structure

```
pacs-anonymizer/
├── package.json                 # Electron + React dependencies
├── electron-builder.yml         # Build config for installers
├── tsconfig.json
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App entry point, spawns Python backend
│   │   └── python-manager.ts    # Lifecycle management for the backend process
│   ├── renderer/                # React UI
│   │   ├── App.tsx
│   │   ├── components/
│   │   └── api/                 # HTTP client for the Python backend
│   └── shared/                  # Types shared between main and renderer
├── backend/
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── app/
│   │   ├── main.py              # FastAPI entry point
│   │   ├── anonymizer.py        # Existing anonymisation logic
│   │   ├── processing.py        # Orientation / windowing / slab thickness
│   │   └── radiopaedia.py       # (Phase 3) API client
│   └── build.spec               # PyInstaller spec
├── build/                       # Build artifacts (gitignored)
└── README.md
```

## Key open questions

1. Flask or FastAPI for the backend? (FastAPI recommended — async, typed, auto-documented.)
2. React or Vue for the frontend? (React recommended — larger ecosystem, more Cornerstone examples.)
3. How to handle large DICOM studies — stream files to the backend, or batch? (TBD based on real-world file sizes.)
4. Where does the anonymised output go by default — user-chosen folder each time, or a persistent app-managed location?
5. Do we need a settings/preferences panel from day one (e.g. default output folder, Radiopaedia credentials)?

## Notes for Claude Code

- Reuse the existing Python anonymiser as the starting point for `backend/app/anonymizer.py`. Wrap it in FastAPI endpoints rather than rewriting the core logic.
- Keep the Electron frontend thin in v0.1 — a drop zone, a start button, a progress indicator, and a results summary is enough.
- Use `electron-builder` from the start so builds for both platforms are reproducible.
- Local backend should listen on `127.0.0.1` on an unused port, not `0.0.0.0` — no external network exposure.
- All DICOM data must stay on the local machine unless the user explicitly triggers a Radiopaedia upload.
