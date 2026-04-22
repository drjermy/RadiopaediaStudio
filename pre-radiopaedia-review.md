# Pre-Radiopaedia Critical Review

Date: 2026-04-22

A critical review of the Radiopaedia Studio codebase before starting Radiopaedia
API integration. The goal is to surface structural issues and foundation gaps
that would make bolting on upload painful, so they can be addressed in parallel
with the API client.

## The big picture

We've gone well past the Phase 1 handoff: the app now has scan, thumbnails,
viewer (Cornerstone3D), trim, reformat, windowing, and compression on top of
anonymisation. The code is coherent and the architecture is basically sound.

The most interesting structural question is the **two-backend split**, which
isn't accidental — it's an explicit per-call router in `renderer.js:161`
(`sidecar === 'node' ? window.nodeBackend : window.backend`). Node handles
`/anonymize`; Python handles everything else.

## Things to flag before touching Radiopaedia

### 1. The Python/Node split is load-bearing but undocumented

Node (`backend-js/server.mjs`) exists because we chose `dicomanon` for the
anonymiser itself. Python does everything else (scan, thumbnails, reformat,
compress, windowing, trim). That's a real decision but it's not written down
anywhere in README or the handoff. Capture the rationale in the README so
future-us doesn't stare at it.

There is one real cost: transfer syntax / orientation / spacing classification
is implemented in both `main.py:273-309` and `server.mjs:164-209`. If a
classification edge case is fixed in one, the other will silently drift.

### 2. `/delete-series` is looser than its own docstring claims

`main.py:603-615` — the guard is "the folder contains at least one DICOM".
That's true for any randomly-navigated folder a user might drag in, not just
folders this app produced. Before Radiopaedia lands (where users will be making
more destructive choices post-upload), either:

- (a) restrict to folders under a known app-managed output root, or
- (b) require a parent-path whitelist passed in from the renderer.

### 3. No cancellation anywhere

`renderer.js` doesn't use `AbortController`, and the streaming generators in
`main.py` don't check for client disconnect. For anonymise+thumbnails on a
small study it doesn't matter. For a Radiopaedia upload of a multi-GB series
over a flaky connection, it will. Wire `AbortController` into `runStream` now
so the upload work inherits it.

### 4. Error messages leak input paths

Multiple endpoints emit `f'{type(e).__name__}: {e}'` (main.py:355, 395, 471,
etc.) plus `print(f'[trim] in={in_path} …')` at main.py:438. These end up in
the renderer log and in stderr. For a purely-local anonymiser it's tolerable,
but once remote upload is added, the same code paths will log anonymised-output
paths and, if anything goes wrong before scrub, pre-anon paths. Scrub paths to
basenames in both log output and streaming `error` events.

### 5. No persistent settings / credentials storage yet

We'll need this for the Radiopaedia token. Electron's `safeStorage`
(keychain-backed on macOS) is the right tool; there's no `settings.ts` or
similar anywhere in `src/main/`. Also no `userData`-path writing at all yet —
the app is pure stateless-per-launch today.

### 6. Summary → upload payload is a lossy shape

The anonymise `summary` event produces studies → series with `folder`
(absolute path), `slice_count`, `transfer_syntax`, `orientation`, etc.
(`server.mjs:332-349`). Radiopaedia will want a different shape (case title,
modality hint, description, patient age band, clinical context, findings).
There's no `Case` model anywhere yet; the renderer just stuffs the summary
into a DOM-rendered panel.

Before upload, we need a small case-metadata model — either another Pydantic
model backend-side, or a TypeScript `Case` type in a new `src/shared/` —
otherwise the Radiopaedia client will turn into ad-hoc field-munging.

### 7. Test coverage is good on the Python core, nothing covers the Node sidecar

`test_scrub.py` (172 lines) and `test_uid_remap.py` (197) are the heavy hitters,
and they test invariants rather than tag lists — that's the right approach. But:

- `backend-js/` has **no tests**. Since that's the path `/anonymize` actually
  takes, that's the most important gap. Minimum: one test that round-trips a
  synthesised DICOM through `dicomanon` and asserts no PHI tags, matching the
  Python `test_scrub.py` invariants.
- No test asserts that the two backends produce the same summary shape. The
  renderer relies on this (it displays Python-scan and Node-anonymise summaries
  through the same `renderStudySummary`). A schema mismatch will only show up
  as a blank thumbnail in the UI.
- No integration test for stream-abort / partial-failure.

### 8. `renderer.js` is 971 lines of plain JS

Everything else in `src/` is TypeScript. The renderer is where Radiopaedia UI
(auth form, case metadata, upload progress) will land — this is the right
moment to TS-ify it, or at least extract a small `src/renderer/api.ts` that
types the backend responses. Otherwise the new upload code will be untyped at
the exact boundary where typing matters most.

### 9. DevTools gate is a weak signal

`index.ts:28` opens DevTools if `DEVTOOLS=1`. For a signed release, also block
DevTools entirely in packaged builds (`webContents.on('devtools-opened', …)`
close, or `webPreferences.devTools: false` when `app.isPackaged`). With a
Radiopaedia token in memory post-auth, DevTools access to the renderer is now
a credential-exfiltration path.

## What to do before writing the first Radiopaedia call

In rough order:

1. **Decide and document the Python/Node split.** One paragraph in README plus
   a note in `server.mjs`.
2. **Extract shared classification helpers** (transfer syntax, orientation,
   spacing) so there's one source of truth — Python-only is fine; Node can
   call a tiny `/classify` endpoint, or just accept the duplication *with a
   comment in both places pointing at each other*.
3. **Add a `Case` type** and a renderer panel that gathers the metadata
   Radiopaedia needs. Do this before the API client — it clarifies what the
   upload payload looks like.
4. **Add `safeStorage`-backed credentials** via a new `src/main/credentials.ts`
   with `get/set/clear` IPC handlers. Don't put the token in `localStorage`.
5. **Add `AbortController` to `runStream`** and propagate it through the UI's
   processing state.
6. **Tighten `/delete-series`** to an app-managed output root.
7. **Sanitize error/log output** to basenames.
8. **One Node anonymiser test.**

Nothing on the list is a blocker to *starting* Radiopaedia work — they're
things to do in parallel with the API client so the foundation is ready when
the HTTP plumbing is.

The Radiopaedia client itself is probably ~200 lines: auth, create-case,
presigned-upload-of-folder, finalise, with retry. The hard parts will be the
UX around it (progress, cancel, retry, quota), which is where the items above
pay off.
