"""FastAPI app exposing the DICOM anonymiser over localhost HTTP.

Runs as a child process spawned by Electron. Binds to 127.0.0.1 on a port
chosen by the parent (passed via --port). Paths are absolute local paths
— no multipart uploads, since Electron and Python share the filesystem.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.anonymizer import find_dicoms, is_dicom_file, iter_scrub_folder, scrub_file, scan_folder
from app.classify import (
    classify_transfer_syntax as _classify_transfer_syntax,
    slice_normal as _slice_normal,
)
from app.compress import iter_compress_folder, iter_recompress_in_place
from app.logsafe import redact_error_message, redact_path
from app.reformat import MODES as REFORMAT_MODES, ORIENTATIONS, iter_reformat_series
from app.windowing import (
    PRESETS as WINDOW_PRESETS,
    apply_window_file,
    iter_apply_window_folder,
)

app = FastAPI(title='radiopaedia-studio-backend', version='0.1.0')


class InspectRequest(BaseModel):
    input: str


class ThumbnailsRequest(BaseModel):
    folders: list[str]


class SeriesInfoRequest(BaseModel):
    folder: str
    label: str | None = None


class AnonymizeRequest(BaseModel):
    input: str
    output: str


class WindowRequest(BaseModel):
    input: str
    output: str
    center: float
    width: float


class ReformatSpec(BaseModel):
    orientation: str  # axial / coronal / sagittal
    thickness: float
    spacing: float
    mode: str  # avg / mip / minip


class WindowSpec(BaseModel):
    center: float
    width: float


class CompressSpec(BaseModel):
    # None / omitted → no compression; 'lossless' → J2K lossless; 'lossy'
    # with ratio>1 → J2K lossy at that ratio.
    mode: str  # 'lossless' | 'lossy'
    ratio: float | None = None


class TrimRequest(BaseModel):
    input: str
    output: str
    start: int  # inclusive 0-based index into sorted series
    end: int    # inclusive


class TransformRequest(BaseModel):
    input: str
    output: str
    reformat: ReformatSpec | None = None
    window: WindowSpec | None = None
    compress: CompressSpec | None = None


class DeleteSeriesRequest(BaseModel):
    folder: str
    # Anonymise-output root that owns this folder. The renderer supplies it
    # from the anonymise `summary.output` (or the last-loaded folder). We
    # refuse to delete anything outside this parent so a malformed/injected
    # request can't wipe arbitrary paths on disk.
    allowed_parent: str


@app.post('/inspect')
def inspect(req: InspectRequest) -> dict:
    in_path = Path(req.input)
    if in_path.is_file():
        return {
            'kind': 'file',
            'name': in_path.name,
            'input': str(in_path),
            'dicom_count': 1 if is_dicom_file(in_path) else 0,
            'total_bytes': in_path.stat().st_size,
        }
    if in_path.is_dir():
        from app.anonymizer import find_dicoms
        dcms = find_dicoms(in_path)
        return {
            'kind': 'folder',
            'name': in_path.name,
            'input': str(in_path),
            'dicom_count': len(dcms),
            'total_bytes': sum(p.stat().st_size for p in dcms),
        }
    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


def _line(obj: dict) -> bytes:
    return (json.dumps(obj) + '\n').encode('utf-8')


def _make_cancel_flag(request: Request) -> tuple[threading.Event, asyncio.Task]:
    """Watch `request` for client disconnect and flip a threadsafe Event.

    Our streaming generators are sync (heavy pydicom work off the event
    loop); they accept an ``is_cancelled`` callable and poll it between
    files. ``StreamingResponse`` iterates sync generators in a threadpool,
    so a plain ``threading.Event.is_set`` gives the generator a safe way
    to observe client disconnect without awaiting anything.

    Returns (flag, watchdog_task) — caller doesn't need to await the task;
    it self-terminates when the flag flips or the generator stops iterating.
    """
    flag = threading.Event()

    async def _watch() -> None:
        # Poll every 250ms — fast enough that clicking Cancel stops the
        # next file, slow enough that a big folder doesn't hammer the loop.
        try:
            while not flag.is_set():
                if await request.is_disconnected():
                    flag.set()
                    return
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(_watch())
    return flag, task


@app.get('/health')
def health() -> dict:
    return {'status': 'ok'}


@app.get('/files')
def serve_file(path: str = Query(...)) -> FileResponse:
    """Stream a single file. Used by the renderer's Cornerstone viewer to
    load DICOMs off the user's local filesystem via wadouri:http://…"""
    p = Path(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail=f'not a file: {path}')
    return FileResponse(p, media_type='application/dicom')


@app.get('/files/list')
def list_files(folder: str = Query(...)) -> dict:
    """Return the list of DICOM files in `folder`, sorted. Viewer uses
    these to build the stack. Filename order is a reasonable proxy for
    slice order for most PACS exports; Cornerstone re-sorts by
    ImagePositionPatient on load anyway."""
    f = Path(folder)
    if not f.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {folder}')
    paths = [str(p) for p in sorted(find_dicoms(f))]
    return {'folder': str(f), 'files': paths}


@app.get('/window/presets')
def window_presets() -> dict:
    return {name: {'center': c, 'width': w} for name, (c, w) in WINDOW_PRESETS.items()}


@app.get('/reformat/options')
def reformat_options() -> dict:
    return {'orientations': list(ORIENTATIONS), 'modes': list(REFORMAT_MODES)}


@app.post('/series-info')
def series_info(req: SeriesInfoRequest) -> dict:
    """Scan a single-series folder and return summary metadata + thumbnail
    of the middle slice. Used after a new version is created to refresh
    the study summary with the newly-produced series."""
    import pydicom
    from app.classify import classify_orientation
    from app.thumbnails import make_thumbnail

    folder = Path(req.folder)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {folder}')

    files = sorted(find_dicoms(folder))
    if not files:
        return {
            'folder': str(folder),
            'description': req.label,
            'slice_count': 0,
            'total_bytes': 0,
            'thumbnail': None,
        }

    first = pydicom.dcmread(files[0])
    middle = pydicom.dcmread(files[len(files) // 2])
    thumb = None
    try:
        thumb = make_thumbnail(middle)
    except Exception:
        pass

    total_bytes = sum(p.stat().st_size for p in files)
    ts_uid = str(first.file_meta.TransferSyntaxUID) if getattr(first, 'file_meta', None) else None
    ts_info = _classify_transfer_syntax(ts_uid)

    def _tag(ds, kw):
        return ds.get(kw, None)

    desc = req.label
    if not desc and _tag(first, 'SeriesDescription'):
        desc = str(first.SeriesDescription).strip()

    def _safe(attr):
        if _tag(first, attr) is None:
            return None
        try:
            return float(getattr(first, attr))
        except (ValueError, TypeError):
            return None

    # Spacing from ImagePositionPatient projection along the slice normal —
    # SpacingBetweenSlices is often missing for CT and unreliable when
    # reconstructions overlap. Read just first + last to derive average gap.
    spacing = _safe('SpacingBetweenSlices')
    if len(files) >= 2:
        try:
            last = pydicom.dcmread(files[-1])
            iop = _tag(first, 'ImageOrientationPatient')
            ipp_a = _tag(first, 'ImagePositionPatient')
            ipp_b = _tag(last, 'ImagePositionPatient')
            n = _slice_normal(iop) if iop else None
            if n and ipp_a and ipp_b:
                pa = [float(x) for x in ipp_a]
                pb = [float(x) for x in ipp_b]
                da = pa[0] * n[0] + pa[1] * n[1] + pa[2] * n[2]
                db = pb[0] * n[0] + pb[1] * n[1] + pb[2] * n[2]
                gap = abs(db - da) / (len(files) - 1)
                if gap > 1e-4:
                    spacing = round(gap * 100) / 100
        except Exception:
            pass

    # First-slice window center/width — cornerstone's volume viewport doesn't
    # reliably pick these up during streaming load, so we pass them through
    # and apply explicitly once the first slice has rendered.
    def _first_num(attr):
        v = _tag(first, attr)
        if v is None:
            return None
        # DICOM allows multi-value; take the first.
        try:
            if hasattr(v, '__iter__') and not isinstance(v, str):
                v = next(iter(v), None)
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    return {
        'folder': str(folder),
        'description': desc,
        'modality': str(first.Modality) if _tag(first, 'Modality') else None,
        'orientation': classify_orientation(_tag(first, 'ImageOrientationPatient')),
        'slice_thickness': _safe('SliceThickness'),
        'slice_spacing': spacing,
        'slice_count': len(files),
        'total_bytes': total_bytes,
        'transfer_syntax': ts_info,
        'thumbnail': thumb,
        'window_center': _first_num('WindowCenter'),
        'window_width':  _first_num('WindowWidth'),
    }


@app.post('/thumbnails')
def thumbnails(req: ThumbnailsRequest) -> dict:
    """For each folder path, pick the middle DICOM file and render a
    data-URL thumbnail. Returns { folder_path: 'data:image/png;base64...' }
    or null per folder when no previewable slice is found."""
    import pydicom
    from app.thumbnails import make_thumbnail

    out: dict[str, str | None] = {}
    for folder_str in req.folders:
        folder = Path(folder_str)
        thumb = None
        if folder.is_dir():
            files = sorted(find_dicoms(folder))
            if files:
                middle = files[len(files) // 2]
                try:
                    thumb = make_thumbnail(pydicom.dcmread(middle))
                except Exception:
                    thumb = None
        out[folder_str] = thumb
    return out


@app.post('/anonymize')
async def anonymize(req: AnonymizeRequest, request: Request) -> StreamingResponse:
    """Stream NDJSON — one JSON object per line. Event types:
      start   {mode, total, output}
      file    {input, output, kept, dropped, dropped_tags}
      error   {input, error}
      done    {count, error_count, output}

    Client disconnect is observed via a watchdog and propagated into the
    generator so big runs bail out promptly instead of writing every file.
    """
    in_path = Path(req.input)
    out_path = Path(req.output)

    if in_path.is_file():
        def gen_file():
            yield _line({'type': 'start', 'mode': 'file', 'total': 1, 'output': str(out_path)})
            try:
                info = scrub_file(in_path, out_path)
                yield _line({'type': 'file', 'input': str(in_path), 'output': str(out_path), **info})
                yield _line({'type': 'done', 'count': 1, 'error_count': 0, 'output': str(out_path)})
            except Exception as e:
                yield _line({'type': 'error', 'input': redact_path(in_path), 'error': redact_error_message(f'{type(e).__name__}: {e}')})
                yield _line({'type': 'done', 'count': 0, 'error_count': 1, 'output': str(out_path)})
        return StreamingResponse(gen_file(), media_type='application/x-ndjson')

    if in_path.is_dir():
        total = len(find_dicoms(in_path))
        cancel_flag, _watchdog = _make_cancel_flag(request)

        def gen_folder():
            yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
            count = 0
            error_count = 0
            summary: dict = {}
            for result in iter_scrub_folder(
                in_path, out_path, summary_out=summary,
                is_cancelled=cancel_flag.is_set,
            ):
                if 'error' in result:
                    error_count += 1
                    yield _line({'type': 'error', **result})
                else:
                    count += 1
                    yield _line({'type': 'file', **result})
            if cancel_flag.is_set():
                return
            if summary:
                yield _line({'type': 'summary', **summary})
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_folder(), media_type='application/x-ndjson')

    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


@app.post('/window')
async def window(req: WindowRequest, request: Request) -> StreamingResponse:
    in_path = Path(req.input)
    out_path = Path(req.output)

    if in_path.is_file():
        def gen_file():
            yield _line({'type': 'start', 'mode': 'file', 'total': 1, 'output': str(out_path)})
            try:
                apply_window_file(in_path, out_path, req.center, req.width)
                yield _line({'type': 'file', 'input': str(in_path), 'output': str(out_path)})
                yield _line({'type': 'done', 'count': 1, 'error_count': 0, 'output': str(out_path)})
            except Exception as e:
                yield _line({'type': 'error', 'input': redact_path(in_path), 'error': redact_error_message(f'{type(e).__name__}: {e}')})
                yield _line({'type': 'done', 'count': 0, 'error_count': 1, 'output': str(out_path)})
        return StreamingResponse(gen_file(), media_type='application/x-ndjson')

    if in_path.is_dir():
        total = len(find_dicoms(in_path))
        cancel_flag, _watchdog = _make_cancel_flag(request)

        def gen_folder():
            yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
            count = 0
            error_count = 0
            for result in iter_apply_window_folder(
                in_path, out_path, req.center, req.width,
                is_cancelled=cancel_flag.is_set,
            ):
                if 'error' in result:
                    error_count += 1
                    yield _line({'type': 'error', **result})
                else:
                    count += 1
                    yield _line({'type': 'file', **result})
            if cancel_flag.is_set():
                return
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_folder(), media_type='application/x-ndjson')

    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


@app.post('/trim')
async def trim(req: TrimRequest, request: Request) -> StreamingResponse:
    """Copy a contiguous sub-range of DICOM files into a new folder with a
    fresh SeriesInstanceUID + fresh SOPInstanceUIDs, preserving Study +
    FrameOfReference UIDs so it still groups under the same case."""
    import pydicom
    from pydicom.uid import generate_uid

    in_path = Path(req.input)
    out_path = Path(req.output)
    if not in_path.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {in_path}')

    files = sorted(find_dicoms(in_path))
    start = max(0, req.start)
    end = min(len(files) - 1, req.end)
    if end < start:
        raise HTTPException(status_code=400, detail='end < start')
    subset = files[start:end + 1]
    print(
        f'[trim] in={redact_path(in_path)} found={len(files)} start={start} end={end} '
        f'subset={len(subset)} → out={redact_path(out_path)}',
        flush=True,
    )
    cancel_flag, _watchdog = _make_cancel_flag(request)

    def gen():
        yield _line({'type': 'start', 'mode': 'folder', 'total': len(subset), 'output': str(out_path)})
        count = 0
        error_count = 0
        series_remap: dict[str, str] = {}

        def remap_series(orig):
            if orig not in series_remap:
                series_remap[orig] = generate_uid(prefix='2.25.')
            return series_remap[orig]

        for src in subset:
            if cancel_flag.is_set():
                return
            rel = src.relative_to(in_path)
            dst = out_path / rel
            try:
                ds = pydicom.dcmread(src)
                if 'SeriesInstanceUID' in ds:
                    ds.SeriesInstanceUID = remap_series(ds.SeriesInstanceUID)
                ds.SOPInstanceUID = generate_uid(prefix='2.25.')
                if hasattr(ds, 'file_meta'):
                    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
                dst.parent.mkdir(parents=True, exist_ok=True)
                ds.save_as(dst, enforce_file_format=True)
                count += 1
                yield _line({'type': 'file', 'input': str(src), 'output': str(dst)})
            except Exception as e:
                error_count += 1
                yield _line({'type': 'error', 'input': redact_path(src), 'error': redact_error_message(f'{type(e).__name__}: {e}')})
        yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})

    return StreamingResponse(gen(), media_type='application/x-ndjson')


@app.post('/transform')
async def transform(req: TransformRequest, request: Request) -> StreamingResponse:
    """Compose reformat + window in one call.

    - reformat set, window unset → MPR reformat (window tags copied from input)
    - reformat set, window set   → MPR reformat with new window tags baked in
    - reformat unset, window set → apply window only (fast tag rewrite)
    - both unset                 → 400
    """
    in_path = Path(req.input)
    out_path = Path(req.output)

    if req.reformat is None and req.window is None and req.compress is None:
        raise HTTPException(status_code=400, detail='at least one of reformat/window/compress required')
    if not in_path.exists():
        raise HTTPException(status_code=400, detail=f'input not found: {in_path}')

    compress_ratio: float | None = None
    if req.compress is not None:
        if req.compress.mode == 'lossy':
            if not req.compress.ratio or req.compress.ratio <= 1:
                raise HTTPException(status_code=400, detail='lossy compression needs ratio > 1')
            compress_ratio = float(req.compress.ratio)
        elif req.compress.mode != 'lossless':
            raise HTTPException(status_code=400, detail=f'unknown compress mode: {req.compress.mode}')

    cancel_flag, _watchdog = _make_cancel_flag(request)

    if req.reformat is not None:
        spec = req.reformat
        wc = req.window.center if req.window else None
        ww = req.window.width if req.window else None

        def gen_reformat():
            yield _line({'type': 'start', 'mode': 'reformat', 'total': 0, 'output': str(out_path)})
            count = 0
            error_count = 0
            for evt in iter_reformat_series(
                in_path, out_path, spec.orientation, spec.thickness, spec.spacing,
                spec.mode, window_center=wc, window_width=ww,
                is_cancelled=cancel_flag.is_set,
            ):
                if evt['type'] == 'error':
                    error_count += 1
                    yield _line(evt)
                elif evt['type'] == 'file':
                    count += 1
                    yield _line(evt)
                else:
                    yield _line(evt)
            if cancel_flag.is_set():
                return
            if req.compress is not None and count > 0:
                yield _line({'type': 'phase', 'label': 'Compressing'})
                for evt in iter_recompress_in_place(
                    out_path, ratio=compress_ratio,
                    is_cancelled=cancel_flag.is_set,
                ):
                    if 'error' in evt:
                        error_count += 1
                        yield _line({'type': 'error', **evt})
                if cancel_flag.is_set():
                    return
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_reformat(), media_type='application/x-ndjson')

    # Paths without reformat ---------------------------------------------------
    total = 1 if in_path.is_file() else len(find_dicoms(in_path))

    def gen_folder():
        yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
        count = 0
        error_count = 0

        if req.window is not None:
            w = req.window
            if in_path.is_file():
                try:
                    apply_window_file(in_path, out_path, w.center, w.width)
                    yield _line({'type': 'file', 'input': str(in_path), 'output': str(out_path)})
                    count += 1
                except Exception as e:
                    error_count += 1
                    yield _line({'type': 'error', 'input': redact_path(in_path), 'error': redact_error_message(f'{type(e).__name__}: {e}')})
            else:
                for result in iter_apply_window_folder(
                    in_path, out_path, w.center, w.width,
                    is_cancelled=cancel_flag.is_set,
                ):
                    if 'error' in result:
                        error_count += 1
                        yield _line({'type': 'error', **result})
                    else:
                        count += 1
                        yield _line({'type': 'file', **result})
            if cancel_flag.is_set():
                return
            # Apply compression to window output if requested
            if req.compress is not None and count > 0:
                yield _line({'type': 'phase', 'label': 'Compressing'})
                for evt in iter_recompress_in_place(
                    out_path if out_path.is_dir() else out_path.parent, ratio=compress_ratio,
                    is_cancelled=cancel_flag.is_set,
                ):
                    if 'error' in evt:
                        error_count += 1
                        yield _line({'type': 'error', **evt})
                if cancel_flag.is_set():
                    return
        elif req.compress is not None:
            # Compress-only path
            if in_path.is_file():
                try:
                    from app.compress import compress_file
                    compress_file(in_path, out_path, ratio=compress_ratio)
                    yield _line({'type': 'file', 'input': str(in_path), 'output': str(out_path)})
                    count += 1
                except Exception as e:
                    error_count += 1
                    yield _line({'type': 'error', 'input': redact_path(in_path), 'error': redact_error_message(f'{type(e).__name__}: {e}')})
            else:
                for result in iter_compress_folder(
                    in_path, out_path, ratio=compress_ratio,
                    is_cancelled=cancel_flag.is_set,
                ):
                    if 'error' in result:
                        error_count += 1
                        yield _line({'type': 'error', **result})
                    else:
                        count += 1
                        yield _line({'type': 'file', **result})
            if cancel_flag.is_set():
                return

        yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
    return StreamingResponse(gen_folder(), media_type='application/x-ndjson')


@app.post('/scan')
def scan(req: InspectRequest) -> dict:
    """Read-only study/series summary for a folder — same shape the
    anonymiser emits, used by the 'Load' flow and the on-startup reload
    of the last-viewed folder."""
    folder = Path(req.input)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {folder}')
    return scan_folder(folder)


@app.post('/delete-series')
def delete_series(req: DeleteSeriesRequest) -> dict:
    """Remove a series folder from disk. Used by the Delete button on the
    thumbnail to drop anonymised or derived series. The folder must resolve
    to a subpath of the caller-supplied `allowed_parent` (the anonymise
    output root) AND contain DICOM files — belt-and-braces against both
    traversal (`..`) and bare paths the app never produced."""
    folder = Path(req.folder).resolve()
    allowed_parent = Path(req.allowed_parent).resolve()
    if not allowed_parent.is_dir():
        raise HTTPException(status_code=400, detail=f'allowed_parent is not a directory: {allowed_parent}')
    if folder == allowed_parent:
        raise HTTPException(status_code=400, detail=f'refusing to delete allowed_parent itself: {folder}')
    try:
        folder.relative_to(allowed_parent)
    except ValueError:
        raise HTTPException(status_code=400, detail=f'{folder} is not under allowed_parent {allowed_parent}')
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {folder}')
    if not find_dicoms(folder):
        raise HTTPException(status_code=400, detail=f'no DICOMs under {folder}; refusing to delete')
    shutil.rmtree(folder)
    return {'deleted': str(folder)}


def _install_warning_redactor() -> None:
    """Route all Python warnings through ``redact_error_message`` before
    they hit stderr. pydicom emits user warnings that embed the absolute
    file path verbatim — e.g.
    ``End of file reached before delimiter (FFFE,E0DD) found in file /abs/path/PATIENT_X/I1.dcm``
    — and for a local anonymiser destined to be uploaded, those ancestor
    folder names are PHI. See GitHub issue #11.

    We wrap (don't replace) ``warnings.showwarning`` so the default
    formatting/filtering behaviour is preserved; we only scrub the
    message payload. Warnings are still surfaced — just with the path
    reduced to ``<parent>/<file>``.
    """
    import sys
    import warnings

    original = warnings.showwarning

    def showwarning_redacted(message, category, filename, lineno, file=None, line=None):  # type: ignore[no-untyped-def]
        try:
            redacted = redact_error_message(str(message))
            # Rebuild as the same warning type to preserve category formatting.
            new_message = category(redacted) if isinstance(message, Warning) or isinstance(message, str) else message
        except Exception:
            new_message = message
        # `filename` is the source file that issued the warning — usually
        # site-packages, but redact just in case a third-party module
        # writes warnings from under a PHI-shaped path.
        try:
            safe_filename = redact_path(filename) if filename else filename
        except Exception:
            safe_filename = filename
        try:
            original(new_message, category, safe_filename, lineno, file=file, line=line)
        except Exception:
            # Last-resort fallback: don't let a logging hook take down the server.
            print(f'{category.__name__}: {new_message}', file=file or sys.stderr)

    warnings.showwarning = showwarning_redacted


def main() -> None:
    _install_warning_redactor()
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
