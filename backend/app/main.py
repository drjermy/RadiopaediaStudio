"""FastAPI app exposing the DICOM anonymiser over localhost HTTP.

Runs as a child process spawned by Electron. Binds to 127.0.0.1 on a port
chosen by the parent (passed via --port). Paths are absolute local paths
— no multipart uploads, since Electron and Python share the filesystem.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.anonymizer import find_dicoms, is_dicom_file, iter_scrub_folder, scrub_file, scan_folder
from app.compress import iter_compress_folder, iter_recompress_in_place
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
            if iop and ipp_a and ipp_b and len(iop) == 6:
                r = [float(x) for x in iop[:3]]
                c = [float(x) for x in iop[3:]]
                n = (
                    r[1]*c[2] - r[2]*c[1],
                    r[2]*c[0] - r[0]*c[2],
                    r[0]*c[1] - r[1]*c[0],
                )
                mag = (n[0]**2 + n[1]**2 + n[2]**2) ** 0.5
                if mag > 0:
                    n = (n[0]/mag, n[1]/mag, n[2]/mag)
                    pa = [float(x) for x in ipp_a]
                    pb = [float(x) for x in ipp_b]
                    da = pa[0]*n[0] + pa[1]*n[1] + pa[2]*n[2]
                    db = pb[0]*n[0] + pb[1]*n[1] + pb[2]*n[2]
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


@app.post('/trim')
def trim(req: TrimRequest) -> StreamingResponse:
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
        f'[trim] in={in_path} found={len(files)} start={start} end={end} '
        f'subset={len(subset)} → out={out_path}',
        flush=True,
    )

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
                yield _line({'type': 'error', 'input': str(src), 'error': f'{type(e).__name__}: {e}'})
        yield _line({'type': 'done', 'count': count, 'error_count': error_count, 'output': str(out_path)})

    return StreamingResponse(gen(), media_type='application/x-ndjson')


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
            if req.compress is not None and count > 0:
                yield _line({'type': 'phase', 'label': 'Compressing'})
                for evt in iter_recompress_in_place(out_path, ratio=compress_ratio):
                    if 'error' in evt:
                        error_count += 1
                        yield _line({'type': 'error', **evt})
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
                    yield _line({'type': 'error', 'input': str(in_path), 'error': f'{type(e).__name__}: {e}'})
            else:
                for result in iter_apply_window_folder(in_path, out_path, w.center, w.width):
                    if 'error' in result:
                        error_count += 1
                        yield _line({'type': 'error', **result})
                    else:
                        count += 1
                        yield _line({'type': 'file', **result})
            # Apply compression to window output if requested
            if req.compress is not None and count > 0:
                yield _line({'type': 'phase', 'label': 'Compressing'})
                for evt in iter_recompress_in_place(
                    out_path if out_path.is_dir() else out_path.parent, ratio=compress_ratio,
                ):
                    if 'error' in evt:
                        error_count += 1
                        yield _line({'type': 'error', **evt})
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
                    yield _line({'type': 'error', 'input': str(in_path), 'error': f'{type(e).__name__}: {e}'})
            else:
                for result in iter_compress_folder(in_path, out_path, ratio=compress_ratio):
                    if 'error' in result:
                        error_count += 1
                        yield _line({'type': 'error', **result})
                    else:
                        count += 1
                        yield _line({'type': 'file', **result})

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
    thumbnail to drop anonymised or derived series. Only directories
    containing DICOM files are accepted — refuses to recurse into
    arbitrary paths so a malformed request can't wipe the user's home."""
    folder = Path(req.folder).resolve()
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f'not a directory: {folder}')
    if not find_dicoms(folder):
        raise HTTPException(status_code=400, detail=f'no DICOMs under {folder}; refusing to delete')
    shutil.rmtree(folder)
    return {'deleted': str(folder)}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--host', default='127.0.0.1')
    args = p.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
