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

### Radiopaedia OAuth client credentials

The app uses the Radiopaedia OAuth 2.0 authorization-code flow. Client
credentials for the OAuth application are baked into the build at build
time, not shipped alongside the user's data:

- `RADIOPAEDIA_CLIENT_ID` — the OAuth app's client_id.
- `RADIOPAEDIA_CLIENT_SECRET` — the OAuth app's client_secret.
- `RADIOPAEDIA_REDIRECT_URI` — optional; defaults to
  `urn:ietf:wg:oauth:2.0:oob`. Radiopaedia's OAuth app-registration
  form rejects non-HTTPS redirect URIs, so an RFC 8252 loopback
  (`http://127.0.0.1:<port>/...`) isn't accepted — OOB is the only
  viable redirect for a desktop app. With OOB the user authorises in
  their system browser, Radiopaedia shows the authorization code on
  its confirmation page, and the user pastes it into our Settings UI.

The `build:frontend` step runs `scripts/write-radiopaedia-config.mjs`
first. It:

1. If `RADIOPAEDIA_CLIENT_ID` / `RADIOPAEDIA_CLIENT_SECRET` are set in
   the environment, writes `src/main/radiopaedia-config.ts` with those
   literals. This is the CI / packaging path.
2. Otherwise, if `src/main/radiopaedia-config.ts` doesn't exist, copies
   `src/main/radiopaedia-config.example.ts` into place so tsc has
   something to typecheck.
3. Otherwise, does nothing (lets devs hand-maintain their local copy).

`src/main/radiopaedia-config.ts` is gitignored. For CI, set the two env
vars in the job's secrets. For local dev either:

- copy `src/main/radiopaedia-config.example.ts` to
  `src/main/radiopaedia-config.ts` and paste in your values, or
- `export RADIOPAEDIA_CLIENT_ID=... RADIOPAEDIA_CLIENT_SECRET=...` and
  let the build script generate the file, or
- leave the credentials empty and use the in-app institutional override
  (stored encrypted via `safeStorage`, overrides the baked values).

### Running

```sh
npm run dev
```

Compiles TypeScript and launches Electron. The main process spawns the Python
backend and the Node sidecar on free `127.0.0.1` ports, waits for `/health`,
then opens the window. Drop a `.dcm` file or folder onto the drop zone — the
anonymised output is written alongside it with an `_anon` suffix.

### Smoke-testing the Radiopaedia upload flow

Before wiring the upload path into the UI, you can exercise the full pipeline
end-to-end against the Radiopaedia staging site with
`scripts/smoke-test-radiopaedia-upload.mjs`. The script creates a **real draft
case** on the configured host and uploads the `dicomanon` test-pattern fixture
through `POST /api/v1/cases` → `POST .../studies` → `POST /direct_s3_uploads`
→ S3 presigned `PUT` → `POST /image_preparation/.../series` → `PUT
.../mark_upload_finished`. When it finishes it prints the case URL — open it
in a browser and **delete the draft case manually** when you're done.

```sh
# Grab a fresh access token from the app (Settings → OAuth) or any other
# source. Then:
RADIOPAEDIA_API_BASE=https://env-develop.radiopaedia-dev.org \
RADIOPAEDIA_ACCESS_TOKEN=<access_token> \
node scripts/smoke-test-radiopaedia-upload.mjs
```

Env vars:

- `RADIOPAEDIA_ACCESS_TOKEN` — **required.** The bearer token to use. Never
  logged; only a 3-char head prefix is printed (so you can spot a
  `Bearer <wrong-thing>` paste).
- `RADIOPAEDIA_API_BASE` — optional, defaults to
  `https://env-develop.radiopaedia-dev.org`. Point it at production at your
  own risk.
- `RADIOPAEDIA_REFRESH_TOKEN`, `RADIOPAEDIA_CLIENT_ID`,
  `RADIOPAEDIA_CLIENT_SECRET` — optional trio. If all three are set and the
  first `GET /api/v1/users/current` returns 401, the script will exchange the
  refresh token at `/oauth/token`, cache the fresh pair in
  `.radiopaedia-tokens.json` (gitignored; mode 0600), and retry the request
  once. Without them a 401 aborts with a clear message.

What to look for in the output:

- A `→ METHOD url` log line before each HTTP request and a `← status` line
  after. On a non-2xx the full response body is dumped to stderr.
- `[smoke] login=…`, `[smoke] CASE_ID=…`, `[smoke] STUDY_ID=…`, and finally
  `[smoke] SUCCESS` plus a `view at: <host>/cases/:id` URL.
- If you see `[smoke] DICOM fixture not found`, run `cd backend-js && npm
  install` to pull the `dicomanon` dep (it ships the fixture under
  `fixtures/TestPattern_JPEG-Baseline_YBRFull.dcm`).

The script never logs the bearer, refresh token, or client secret. It does
print short (3-char) head prefixes for the bearer and refresh tokens so you
can diagnose mis-paste issues without leaking the whole value.

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
