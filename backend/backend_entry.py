"""PyInstaller entry point. Thin wrapper so the frozen binary runs the
same `main()` as `python -m app.main`."""

from __future__ import annotations

import sys

from app.main import main

if __name__ == '__main__':
    sys.exit(main() or 0)
