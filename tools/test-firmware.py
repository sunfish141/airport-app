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
    wifi_executable = str(Path(directory) / "wifi-tests")
    subprocess.run(compiler + [
        "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic",
        "-I", str(root / "firmware/include"),
        str(root / "firmware/test/wifi_test.cpp"), "-o", wifi_executable,
    ], check=True)
    subprocess.run([wifi_executable], check=True)
    demo_executable = str(Path(directory) / "timed-demo-tests")
    subprocess.run(compiler + [
        "-std=c++11", "-Wall", "-Wextra", "-Werror", "-pedantic",
        "-I", str(root / "firmware/include"),
        str(root / "firmware/src/Controller.cpp"),
        str(root / "firmware/test/timed_demo_test.cpp"), "-o", demo_executable,
    ], check=True)
    subprocess.run([demo_executable], check=True)
