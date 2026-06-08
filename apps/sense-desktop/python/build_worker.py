#!/usr/bin/env python3
"""Freeze analysis_worker.py into a standalone PyInstaller binary.

Run this from any OS with Python + the runtime requirements installed.
Output lands at:

  apps/sense-desktop/python/dist/analysis_worker       (macOS / Linux)
  apps/sense-desktop/python/dist/analysis_worker.exe   (Windows)

electron-builder's `extraResources` entry (see apps/sense-desktop/package.json)
copies that binary into the packaged app's resources/python/ directory, which
is where main.js::resolveAnalysisWorkerCommand looks for it at runtime.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parent
    worker = here / "analysis_worker.py"
    dist_dir = here / "dist"
    work_dir = here / "build"

    if not worker.exists():
        print(f"Worker script not found: {worker}", file=sys.stderr)
        return 1

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--name", "analysis_worker",
        "--distpath", str(dist_dir),
        "--workpath", str(work_dir),
        "--specpath", str(work_dir),
        "--collect-all", "neurokit2",
        "--collect-all", "biosppy",
        "--collect-all", "mne",
        "--collect-submodules", "scipy",
        "--collect-submodules", "sklearn",
        str(worker),
    ]

    print("Running:", " ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    raise SystemExit(main())
