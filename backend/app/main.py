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
