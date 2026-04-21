"""FastAPI app exposing the DICOM anonymiser over localhost HTTP.

Runs as a child process spawned by Electron. Binds to 127.0.0.1 on a port
chosen by the parent (passed via --port). Paths are absolute local paths
— no multipart uploads, since Electron and Python share the filesystem.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.anonymizer import scrub_file

app = FastAPI(title='pacs-anonymizer-backend', version='0.1.0')


class AnonymizeRequest(BaseModel):
    input: str
    output: str


class AnonymizeResponse(BaseModel):
    output: str
    kept: int
    dropped: int
    dropped_tags: list[str]


@app.get('/health')
def health() -> dict:
    return {'status': 'ok'}


@app.post('/anonymize', response_model=AnonymizeResponse)
def anonymize(req: AnonymizeRequest) -> AnonymizeResponse:
    in_path = Path(req.input)
    out_path = Path(req.output)
    if not in_path.is_file():
        raise HTTPException(status_code=400, detail=f'input not found: {in_path}')
    try:
        result = scrub_file(in_path, out_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'{type(e).__name__}: {e}')
    return AnonymizeResponse(output=str(out_path), **result)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
