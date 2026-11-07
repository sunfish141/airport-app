# Carry luggage tag MVP

Implements the app and firmware portions of `luggage_tag_complete_build_guide (1).md`.
The projects are independent:

| Directory | Purpose |
| --- | --- |
| [`app/`](app/) | Plain JavaScript/Vite phone interface, Web Bluetooth, ZXing QR scanning, printable synthetic passes |
| [`firmware/`](firmware/) | Arduino firmware for XIAO ESP32C3, NimBLE GATT, servo control, endpoint switches and atomic NVS state |
| [`docs/protocol.md`](docs/protocol.md) | Shared command/status wire format |

## App

Requires Node.js 22+ and npm.

```sh
cd app
npm ci
npm test
npm run dev
```

Open the printed localhost URL for desktop layout development. For phone operation, build with `npm run build` and serve the contents of `app/dist/` from an HTTPS origin trusted by the phone. A plain HTTP LAN URL cannot access Web Bluetooth or the camera. Use **Android Chrome** and test the actual phone. Bluetooth selection opens when the user taps **Connect tag**. See [Chrome's Web Bluetooth requirements](https://developer.chrome.com/docs/capabilities/bluetooth).

For an interactive mobile preview without hardware, run `npm run emulator` inside `app/`. It opens a phone frame with selectable screen sizes, rotation and a virtual tag. See [`app/README.md`](app/README.md#mobile-emulator) for the demo workflow and recovery controls.

To run the actual production controller in a visual hardware simulation, use `npm run simulate` inside `app/`. The [firmware workbench](firmware/simulation/README.md) compiles `Controller.cpp` to WebAssembly and connects it to an animated bolt/servo model, production debounce, simulated NVS, fault injection and the same phone app. The compiled module is included; rebuilding after firmware edits requires Zig. Source/binary hashes prevent silently using a stale build.

The printable passes are available through **Demo passes** or `/demo-passes.html`. Two QR SVGs and the printable page are committed in `app/public/`; `npm run passes` regenerates them. Each QR contains only its synthetic 16-character token. The app does not parse real airline barcodes. Camera decoding uses [`@zxing/browser`](https://github.com/zxing-js/browser); manual token entry is available if camera access is unavailable.

## Firmware

Install PlatformIO Core 6.1.18 (for example, in a Python virtual environment) or use PlatformIO in VS Code:

```sh
python -m pip install platformio==6.1.18
pio run -d firmware
pio run -d firmware --target upload
```

The pinned environment selects `seeed_xiao_esp32c3`, Espressif32 6.10.0 / Arduino ESP32 2.0.17, and NimBLE-Arduino 2.3.6. [`firmware/README.md`](firmware/README.md) describes pin configuration, calibration, controls and recovery. Servo travel and timeout must be calibrated on the actual mechanism before normal use.

## Demonstration

1. Start with the bolt open and only its open switch active. Power the tag and connect the app to `Carry-XXXXXX`.
2. Hold the tag button for at least 500 ms, then release before 3 seconds. This opens a 10-second setup window.
3. Tap **Scan to lock** and scan pass A (`A1B2C3D4E5F60718`). The firmware stores its token and closing intent before driving the servo. The app reports locked only after the closed switch confirms.
4. Tap **Scan to unlock** and scan pass B (`9A8B7C6D5E4F3021`). It is rejected and the assignment remains.
5. Scan A to unlock. Ownership clears only after the open switch confirms. Start setup and assign B to check reuse; A must then fail to unlock.
6. From open/unassigned, use **Close for storage**. Hold the physical button for 3 seconds to reopen without scanning.

A 3-second physical hold requests service opening from any state, once per press. A fault or interrupted movement never retries automatically. Both endpoint switches active prevents recovery movement until corrected. Tokens are replayable demo identifiers, and the service button bypasses ownership, as specified in the guide.

## Verification

```sh
cd app
npm test
npm run build
cd ..
python3 tools/test-firmware.py
pio run -d firmware
```

The controller tests use the production C++ controller with a fake storage/servo adapter. They require a C++11 compiler; set `CXX` to another compiler command if needed (for example `CXX='zig c++'`). They cover 20 simulated cycles, incorrect tokens, reuse, button timing, timeout, sensor conflicts, interrupted movements, NVS failures/corruption, debounce and timer rollover. App tests cover command/status framing, subscriptions, stale status, transport acknowledgement, faults and disconnects. They do not replace physical acceptance testing.

For repeatable browser checks, run `npx playwright install chromium` inside `app/`, start `npm run dev`, then run `npm run test:browser` in another terminal. `APP_URL` can select a different preview origin. These checks exercise mobile/desktop layouts and real ZXing decoding from simulated camera frames, with a simulated BLE peripheral. Screenshots are saved to a printed temporary directory. No physical tag or camera is used by this browser test.

Hardware assembly, enclosure design and battery/power implementation are outside this repository's implementation scope. Actual BLE/camera operation, servo calibration, jams, reset behavior under motor load and battery runtime still require the guide's bench acceptance tests.
