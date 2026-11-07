#!/usr/bin/env python3
"""Compile the real firmware controller against an in-memory hardware adapter."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
compiler = shlex.split(os.environ.get("CXX", "g++"))
with tempfile.TemporaryDirectory(prefix="luggage-tests-") as directory:
    executable = str(Path(directory) / "controller-tests")
    subprocess.run(compiler + [
        "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic",
        "-I", str(root / "firmware/include"),
        str(root / "firmware/src/Controller.cpp"),
        str(root / "firmware/test/controller_test.cpp"), "-o", executable,
    ], check=True)
    subprocess.run([executable], check=True)
