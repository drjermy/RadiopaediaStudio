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

from app.anonymizer import find_dicoms, iter_scrub_folder, scrub_file

app = FastAPI(title='pacs-anonymizer-backend', version='0.1.0')


class InspectRequest(BaseModel):
    input: str


class AnonymizeRequest(BaseModel):
    input: str
    output: str


@app.post('/inspect')
def inspect(req: InspectRequest) -> dict:
    in_path = Path(req.input)
    if in_path.is_file():
        return {
            'kind': 'file',
            'name': in_path.name,
            'input': str(in_path),
            'dicom_count': 1 if in_path.suffix.lower() == '.dcm' else 0,
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
            for result in iter_scrub_folder(in_path, out_path):
                if 'error' in result:
                    error_count += 1
                    yield _line({'type': 'error', **result})
                else:
                    count += 1
                    yield _line({'type': 'file', **result})
            yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})
        return StreamingResponse(gen_folder(), media_type='application/x-ndjson')

    raise HTTPException(status_code=400, detail=f'input not found: {in_path}')


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
