#!/usr/bin/env python3
"""Build the unchanged production controller with a browser hardware adapter."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
sources = ["firmware/src/Controller.cpp", "firmware/include/Controller.h",
           "firmware/include/Config.h", "firmware/simulation/Simulator.cpp",
           "tools/build-firmware-wasm.py", "firmware/include/BoardConfig.h"]
compiler = shlex.split(os.environ.get("WASM_CXX", "zig c++"))
if not shutil.which(compiler[0]):
    raise SystemExit("Install Zig 0.14.1+ and put zig on PATH, or set WASM_CXX='/path/to/zig c++'. See firmware/simulation/README.md.")
destination = root / "app/public/firmware"
destination.mkdir(parents=True, exist_ok=True)
exports = ["sim_reset", "sim_advance", "sim_button", "sim_hold", "sim_power", "sim_faults",
           "sim_travel", "sim_cable", "sim_corrupt", "sim_record_ptr", "sim_restore",
           "sim_command_ptr", "sim_command", "sim_status_ptr", "sim_position",
           "sim_trace_count", "sim_trace_ptr", "sim_trace_status_ptr", "sim_value", "sim_config", "sim_manual_position"]
output = destination / "controller.wasm"
subprocess.run(compiler + [
    "-target", "wasm32-wasi", "-mexec-model=reactor", "-std=c++11", "-O2",
    "-fno-exceptions", "-fno-rtti", "-DNDEBUG", "-Wall", "-Wextra", "-Werror",
    "-I", str(root / "firmware/include"),
    str(root / sources[0]), str(root / sources[3]),
    *[f"-Wl,--export={name}" for name in exports], "-Wl,--strip-all", "-o", str(output),
], check=True)
digest = hashlib.sha256()
for name in sources:
    digest.update(name.encode() + b"\0" + (root / name).read_bytes() + b"\0")
manifest = {
    "schema": 1, "sources": sources, "sourceHash": digest.hexdigest(),
    "wasmHash": hashlib.sha256(output.read_bytes()).hexdigest(),
    "compiler": "Zig " + subprocess.check_output([compiler[0], "version"], text=True).strip() + " C++", "target": "wasm32-wasi",
    "controllerSource": "Controller.cpp.txt",
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
(destination / "Controller.cpp.txt").write_bytes((root / sources[0]).read_bytes())
print(f"Built {output.relative_to(root)} ({output.stat().st_size} bytes); source {manifest['sourceHash'][:12]}")
