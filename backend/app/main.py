"""FastAPI app exposing the DICOM anonymiser over localhost HTTP.

Runs as a child process spawned by Electron. Binds to 127.0.0.1 on a port
chosen by the parent (passed via --port). Paths are absolute local paths
— no multipart uploads, since Electron and Python share the filesystem.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.anonymizer import find_dicoms, is_dicom_file, iter_scrub_folder, scrub_file
from app.reformat import MODES as REFORMAT_MODES, ORIENTATIONS, iter_reformat_series
from app.windowing import (
    PRESETS as WINDOW_PRESETS,
    apply_window_file,
    iter_apply_window_folder,
)

app = FastAPI(title='pacs-anonymizer-backend', version='0.1.0')


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


class TransformRequest(BaseModel):
    input: str
    output: str
    reformat: ReformatSpec | None = None
    window: WindowSpec | None = None


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


@app.get('/health')
def health() -> dict:
    return {'status': 'ok'}


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
    from app.anonymizer import classify_orientation
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

    thickness = None
    if _tag(first, 'SliceThickness') is not None:
        try:
            thickness = float(first.SliceThickness)
        except (ValueError, TypeError):
            thickness = None

    return {
        'folder': str(folder),
        'description': desc,
        'modality': str(first.Modality) if _tag(first, 'Modality') else None,
        'orientation': classify_orientation(_tag(first, 'ImageOrientationPatient')),
        'slice_thickness': thickness,
        'slice_count': len(files),
        'total_bytes': total_bytes,
        'transfer_syntax': ts_info,
        'thumbnail': thumb,
    }


_TS_NAMES = {
    '1.2.840.10008.1.2':       'uncompressed (implicit LE)',
    '1.2.840.10008.1.2.1':     'uncompressed',
    '1.2.840.10008.1.2.2':     'uncompressed (explicit BE)',
    '1.2.840.10008.1.2.4.50':  'JPEG baseline',
    '1.2.840.10008.1.2.4.51':  'JPEG extended',
    '1.2.840.10008.1.2.4.57':  'JPEG lossless',
    '1.2.840.10008.1.2.4.70':  'JPEG lossless SV1',
    '1.2.840.10008.1.2.4.80':  'JPEG-LS lossless',
    '1.2.840.10008.1.2.4.81':  'JPEG-LS lossy',
    '1.2.840.10008.1.2.4.90':  'JPEG 2000 lossless',
    '1.2.840.10008.1.2.4.91':  'JPEG 2000 lossy',
    '1.2.840.10008.1.2.4.92':  'JPEG 2000 pt2 lossless',
    '1.2.840.10008.1.2.4.93':  'JPEG 2000 pt2 lossy',
    '1.2.840.10008.1.2.4.201': 'HTJ2K lossless',
    '1.2.840.10008.1.2.4.202': 'HTJ2K lossless-only',
    '1.2.840.10008.1.2.4.203': 'HTJ2K lossy',
    '1.2.840.10008.1.2.5':     'RLE lossless',
}
_TS_UNCOMPRESSED = {'1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'}
_TS_LOSSLESS = {
    '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70',
    '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.90',
    '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.201',
    '1.2.840.10008.1.2.4.202', '1.2.840.10008.1.2.5',
}


def _classify_transfer_syntax(uid: str | None) -> dict:
    if not uid:
        return {'uid': None, 'name': 'unknown', 'compressed': False, 'lossy': False}
    name = _TS_NAMES.get(uid, uid)
    if uid in _TS_UNCOMPRESSED:
        return {'uid': uid, 'name': name, 'compressed': False, 'lossy': False}
    if uid in _TS_LOSSLESS:
        return {'uid': uid, 'name': name, 'compressed': True, 'lossy': False}
    return {'uid': uid, 'name': name, 'compressed': True, 'lossy': True}


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
def anonymize(req: AnonymizeRequest) -> StreamingResponse:
    """Stream NDJSON — one JSON object per line. Event types:
      start   {mode, total, output}
      file    {input, output, kept, dropped, dropped_tags}
      error   {input, error}
      done    {count, error_count, output}
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
                yield _line({'type': 'error', 'input': str(in_path), 'error': f'{type(e).__name__}: {e}'})
                yield _line({'type': 'done', 'count': 0, 'error_count': 1, 'output': str(out_path)})
        return StreamingResponse(gen_file(), media_type='application/x-ndjson')

    if in_path.is_dir():
        total = len(find_dicoms(in_path))

        def gen_folder():
            yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
            count = 0
            error_count = 0
            summary: dict = {}
            for result in iter_scrub_folder(in_path, out_path, summary_out=summary):
                if 'error' in result:
                    error_count += 1
                    yield _line({'type': 'error', **result})
                else:
                    count += 1
                    yield _line({'type': 'file', **result})
            if summary:
                yield _line({'type': 'summary', **summary})
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_folder(), media_type='application/x-ndjson')

    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


@app.post('/window')
def window(req: WindowRequest) -> StreamingResponse:
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
                yield _line({'type': 'error', 'input': str(in_path), 'error': f'{type(e).__name__}: {e}'})
                yield _line({'type': 'done', 'count': 0, 'error_count': 1, 'output': str(out_path)})
        return StreamingResponse(gen_file(), media_type='application/x-ndjson')

    if in_path.is_dir():
        total = len(find_dicoms(in_path))

        def gen_folder():
            yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
            count = 0
            error_count = 0
            for result in iter_apply_window_folder(in_path, out_path, req.center, req.width):
                if 'error' in result:
                    error_count += 1
                    yield _line({'type': 'error', **result})
                else:
                    count += 1
                    yield _line({'type': 'file', **result})
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_folder(), media_type='application/x-ndjson')

    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


@app.post('/transform')
def transform(req: TransformRequest) -> StreamingResponse:
    """Compose reformat + window in one call.

    - reformat set, window unset → MPR reformat (window tags copied from input)
    - reformat set, window set   → MPR reformat with new window tags baked in
    - reformat unset, window set → apply window only (fast tag rewrite)
    - both unset                 → 400
    """
    in_path = Path(req.input)
    out_path = Path(req.output)

    if req.reformat is None and req.window is None:
        raise HTTPException(status_code=400, detail='at least one of reformat/window required')
    if not in_path.exists():
        raise HTTPException(status_code=400, detail=f'input not found: {in_path}')

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
            ):
                if evt['type'] == 'error':
                    error_count += 1
                    yield _line(evt)
                elif evt['type'] == 'file':
                    count += 1
                    yield _line(evt)
                else:
                    yield _line(evt)
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_reformat(), media_type='application/x-ndjson')

    # window-only path
    spec = req.window

    if in_path.is_file():
        def gen_file():
            yield _line({'type': 'start', 'mode': 'file', 'total': 1, 'output': str(out_path)})
            try:
                apply_window_file(in_path, out_path, spec.center, spec.width)
                yield _line({'type': 'file', 'input': str(in_path), 'output': str(out_path)})
                yield _line({'type': 'done', 'count': 1, 'error_count': 0, 'output': str(out_path)})
            except Exception as e:
                yield _line({'type': 'error', 'input': str(in_path), 'error': f'{type(e).__name__}: {e}'})
                yield _line({'type': 'done', 'count': 0, 'error_count': 1, 'output': str(out_path)})
        return StreamingResponse(gen_file(), media_type='application/x-ndjson')

    total = len(find_dicoms(in_path))

    def gen_folder():
        yield _line({'type': 'start', 'mode': 'folder', 'total': total, 'output': str(out_path)})
        count = 0
        error_count = 0
        for result in iter_apply_window_folder(in_path, out_path, spec.center, spec.width):
            if 'error' in result:
                error_count += 1
                yield _line({'type': 'error', **result})
            else:
                count += 1
                yield _line({'type': 'file', **result})
        yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
    return StreamingResponse(gen_folder(), media_type='application/x-ndjson')


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
