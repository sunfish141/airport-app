# Firmware workbench

The workbench executes the **unchanged production** `firmware/src/Controller.cpp`, `firmware/include/Controller.h`, `firmware/include/Config.h` and `firmware/include/BoardConfig.h` as WebAssembly. `Simulator.cpp` implements their `Hardware` interface and a mechanical/input model. The existing JavaScript mobile demo remains available separately.

## Run

```sh
cd app
npm ci
npm run simulate
```

Open `/simulation.html` at the printed local URL. The included WebAssembly artifact requires no compiler to run. This page and `/?demo=firmware` are also included in `npm run build` output and work with static hosting. Workbench controls talk to the app's opt-in firmware transport; the normal `/` app uses real Web Bluetooth.

1. Click **Connect** above the phone.
2. In the phone, select **Scan to lock**, then pass A. The QR image is decoded with ZXing; the phone waits for the setup button.
3. Click **Setup hold · 650 ms**, or hold/release the physical-button control yourself. These drive the raw button input through the production debounce and hold logic. They do not call a setup bypass. Once the firmware reports its setup window, the phone queues the same raw `L` command to the controller.
4. Expand **Event trace**: atomic simulated NVS commit precedes PWM; switch confirmation precedes the final commit. Try pass B to observe token rejection in C++.
5. Release with A, close for storage from **Tag options**, then use **Service hold · 3.2 s**. Recovery really waits for the firmware's three-second hold before opening.

The SVG is an illustrative cutaway, not a dimensioned mechanical assembly. It shows sliding bolt position, cable eyelet retention, both contact inputs, servo horn/linkage, supply branches, external status LED and stored ownership/intent. Each displayed state comes from the WebAssembly adapter/controller; the drawing does not choose the state.

The workbench now depicts the purchased **ESP-WROOM-32 / SG90 / LM2596** hardware. GPIO labels and servo frequency come from the compiled `BoardConfig.h`, including the button trace. Its DC input represents a source suitable for a 5 V buck output, not a single-cell boost supply. The simulated endpoint switches and external LED remain additional hardware requirements; see [`../README.md`](../README.md).

## Fidelity and boundaries

| Part | Implementation |
| --- | --- |
| Validation, token comparison, assignment, movement states, timeout, service and boot recovery | Production `Controller.cpp` without a JavaScript rewrite |
| 30 ms input debounce and hold timing | Production `DebouncedInput` and controller button handling |
| NVS encoding, schema and CRC | Production `encodeRecord` / `decodeRecord` and the exact 28-byte blob |
| BLE command/status format | Production `encodeStatus`, same 12-byte packets, same app `TagConnection`; in-process transport replaces the BLE radio |
| Loop | Host adapter mirrors `main.cpp` ordering, processing one queued command per 2 ms step; same eight-entry queue and overflow rejection |
| PWM | Actual configured open/closed pulse values, 50 Hz command and detach events |
| Motion and switches | Assumed linear full stroke of 650 ms; adjustable 100–1500 ms in the UI. Endpoint thresholds at 2% / 98%, with assumed 12 ms contact bounce before production debounce |
| Cable | Geometric retention only. No invented cable-presence input or firmware interlock; the real design has none |
| Power | Main switch stops the modeled servo and resets volatile controller state on restart, preserving position and NVS bytes |
| Electrical/mechanical behavior | No ESP32 CPU, NimBLE radio, Preferences driver, torque, linkage force, current, LM2596 behavior, DC source behavior or brownout model |

The plant assumes the configured pulses correspond to calibrated endpoint positions and that motion stops when PWM is detached. Neither is a hardware guarantee. Actual SG90 travel, holding force, binding, current draw and power integrity need bench measurements. The drawing omits circuit detail and cannot validate wiring. Flash save failure and CRC corruption are explicit fault injections, not a flash wear or brownout model.

The workbench uses a simulation clock, with pause, 20 ms step and ¼×/1×/4× speed. Manual holds use simulation time. The phone retains its real five-second wall-clock command timeout. Long pauses can therefore disconnect the phone while the firmware remains paused; reconnect to read its state. Browser background suspension and long frame gaps are not modeled as real elapsed hardware time (frame delta is capped at 250 ms).

## Persistence and faults

The firmware blob, last sampled bolt position and cable presence are stored under `carry.firmware-workbench.v1` in browser local storage. This contains **synthetic demo tokens** in the record, unlike the normal app. Browser reload starts powered on and reconciles the saved blob/position as a reboot. If browser storage is unavailable, simulated power cycling still retains NVS within the current page session. Record updates are copied out after a simulation frame; browser crashes are not atomic NVS power-failure tests.

Use **Reset saved simulation** to clear the virtual flash, position and fault settings. Reset changes only this simulator's state. Simulated power cuts/reboots retain the blob and position. A pending opening/closing, contradictory sensors, bad CRC, or assigned/open boot must enter recovery rather than clear ownership.

Available fault controls: mid-travel jam, both/neither contacts, individual disconnected endpoint wires, failed NVS writes, corrupt CRC, travel exceeding the firmware timeout, and power interruption during motion. A manual-position slider works only with PWM detached, representing manual linkage release. It never clears ownership. The last 100 trace events are displayed, newest first; contact bounce can be included.

## Rebuild from firmware sources

Install [Zig](https://ziglang.org/download/) 0.14.1 (the version used here) and put it on `PATH`:

```sh
cd app
npm run firmware:build
npm run firmware:check
npm test
npm run build
```

Or select an existing Zig executable:

```sh
WASM_CXX='/path/to/zig c++' python3 tools/build-firmware-wasm.py
```

The latter runs from the repository root. The build script targets `wasm32-wasi` reactor mode and strips debug sections; the current module has no host imports. It writes `app/public/firmware/controller.wasm`, `manifest.json`, and a copy of the exact compiled controller source. The manifest records source/build-recipe and binary SHA-256 hashes plus the compiler version. The fingerprinted files use LF line endings through `.gitattributes` for consistent checkouts. `npm run simulate`, `npm test` and `npm run build` check these hashes and fail on stale source/artifacts. The Vite dev server also validates them when the workbench loads its manifest, refusing stale firmware with a rebuild message. After firmware edits, rebuild and reload the workbench. Ordinary `npm run dev` does not auto-compile C++.

`app/test/firmware-machine.test.js` executes the compiled controller with deterministic fixed steps, including 20 cycles, debounce/hold timing, persist-before-actuation ordering, interrupted opening restored into a fresh instance, NVS/sensor failures and recovery. `npm run test:simulation` exercises the real WASM + app + cutaway page in Chromium with a running dev server (`APP_URL` can override the origin). The native production-controller harness remains `python3 tools/test-firmware.py` from the root.
