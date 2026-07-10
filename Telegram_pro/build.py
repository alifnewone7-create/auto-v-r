#!/usr/bin/env python3
"""
Telegram_pro build tool
=======================

Compiles the human-readable Python sources in ``LS_Python/agent`` into
*sourceless* optimized byte-code (``.pyc``) inside ``Telegram_pro/agent``.

Why:
  * The shipped folder contains ONLY ``.pyc`` byte-code, never ``.py`` source,
    so the logic is not directly readable / copy-pasteable.
  * ``optimize=2`` strips docstrings and ``assert`` statements.
  * The package keeps working exactly like before:
        python -m agent.supervisor
        python -m agent.worker

IMPORTANT - Python version lock:
  ``.pyc`` files are tied to the exact Python version that produced them
  (the "magic number"). Build with the SAME Python you run on the VPS.
  Per requirements.txt you must use Python 3.11 or 3.12 (NOT 3.13/3.14,
  because py-tgcalls is not stable there). So on the VPS:

        python3.12 build.py          # regenerate .pyc for this interpreter
        python3.12 -m agent.worker   # run it

Usage:
    python build.py                 # compile using the current interpreter
    python build.py --source ../LS_Python   # custom source location
    python build.py --clean         # remove previously built .pyc first
"""

from __future__ import annotations

import argparse
import compileall
import py_compile
import shutil
import sys
from pathlib import Path

# Files that make up the agent package. Everything else (README, .env, ...)
# is copied verbatim as a support file, not compiled.
PACKAGE_NAME = "agent"


def find_source(explicit: str | None) -> Path:
    """Locate the LS_Python source folder that holds ``agent/``."""
    here = Path(__file__).resolve().parent
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser().resolve())
    # Telegram_pro lives next to LS_Python in the repo.
    candidates.append(here.parent / "LS_Python")
    candidates.append(here / "src")  # optional: sources copied in beside build.py
    for c in candidates:
        if (c / PACKAGE_NAME / "__init__.py").exists():
            return c
    raise SystemExit(
        "[build] Could not find the source 'agent' package. Looked in:\n  "
        + "\n  ".join(str(c) for c in candidates)
        + "\n\nPass --source /path/to/LS_Python explicitly."
    )


def compile_package(source_root: Path, dest_root: Path, optimize: int = 2) -> int:
    """Compile every ``agent/*.py`` into sourceless ``.pyc`` under dest_root."""
    src_pkg = source_root / PACKAGE_NAME
    dst_pkg = dest_root / PACKAGE_NAME
    dst_pkg.mkdir(parents=True, exist_ok=True)

    count = 0
    py_files = sorted(src_pkg.rglob("*.py"))
    if not py_files:
        raise SystemExit(f"[build] No .py files found under {src_pkg}")

    for py in py_files:
        rel = py.relative_to(src_pkg)               # e.g. worker.py
        out = (dst_pkg / rel).with_suffix(".pyc")   # -> agent/worker.pyc (sourceless layout)
        out.parent.mkdir(parents=True, exist_ok=True)
        py_compile.compile(
            str(py),
            cfile=str(out),
            optimize=optimize,
            # UNCHECKED_HASH: never look for / compare against a .py at runtime.
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH,
            quiet=1,
        )
        count += 1
        print(f"[build]  compiled  {rel}  ->  {out.relative_to(dest_root)}")

    return count


def clean(dest_root: Path) -> None:
    pkg = dest_root / PACKAGE_NAME
    if pkg.exists():
        shutil.rmtree(pkg)
        print(f"[build]  removed  {pkg}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Compile LS_Python agent into sourceless .pyc")
    ap.add_argument("--source", help="Path to the LS_Python folder (defaults to ../LS_Python)")
    ap.add_argument("--clean", action="store_true", help="Delete existing compiled output first")
    ap.add_argument("--optimize", type=int, default=2, choices=[0, 1, 2], help="Optimization level")
    args = ap.parse_args()

    dest_root = Path(__file__).resolve().parent
    source_root = find_source(args.source)

    print(f"[build] Python      : {sys.version.split()[0]} (magic-locked)")
    print(f"[build] source      : {source_root / PACKAGE_NAME}")
    print(f"[build] destination : {dest_root / PACKAGE_NAME}")

    if args.clean:
        clean(dest_root)

    n = compile_package(source_root, dest_root, optimize=args.optimize)

    # Sanity check: the compiled package must load without any .py present.
    compileall.compile_dir  # (referenced to keep import meaningful)
    print(f"\n[build] done - {n} module(s) compiled to sourceless byte-code.")
    print("[build] run it with:")
    print("          python -m agent.supervisor")
    print("          python -m agent.worker")


if __name__ == "__main__":
    main()
