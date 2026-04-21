# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the pacs-anonymizer backend. Onedir build
# (faster startup than onefile; the backend stays alive for the
# whole app session so size trade-off favours startup).

from PyInstaller.utils.hooks import collect_all

# pydicom ships codec/charset submodules loaded dynamically; uvicorn
# pulls in h11, websockets, httptools, etc. Using collect_all is the
# pragmatic fix — it catches both submodules and data files.
pydicom_datas, pydicom_binaries, pydicom_hiddenimports = collect_all('pydicom')
uvicorn_datas, uvicorn_binaries, uvicorn_hiddenimports = collect_all('uvicorn')

a = Analysis(
    ['backend_entry.py'],
    pathex=['.'],
    binaries=pydicom_binaries + uvicorn_binaries,
    datas=pydicom_datas + uvicorn_datas,
    hiddenimports=(
        pydicom_hiddenimports
        + uvicorn_hiddenimports
        + ['app', 'app.main', 'app.anonymizer']
    ),
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='pacs-anonymizer-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='pacs-anonymizer-backend',
)
