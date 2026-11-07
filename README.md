# Carry luggage tag prototype

One ESP-WROOM-32 tag, an SG90 servo, and a phone. Select `Carry-XXXXXX` over Bluetooth; NFC is not needed for this single-tag test. Use the included demo QR passes, not real airline boarding passes.

Use the [native Android/iOS app](mobile/README.md) on a phone. It remembers the selected tag across launches and reconnects after signal loss while the app is open. The browser app remains available for previews and the firmware workbench.

## Try without hardware

Install Node.js 22.16+ and run from the repository root:

```sh
cd app
npm ci
npm run emulator
```

In the preview: connect, scan pass A, then press **Setup button**. Scan A again to release. To run the actual C++ controller with simulated hardware, use `npm run simulate` instead.

## Use the physical tag

1. Follow the [wiring and test guide](<luggage_tag_complete_build_guide (1).md>).
2. [Build and upload the firmware](firmware/README.md).
3. [Install the mobile app](mobile/README.md) and run a lock/release cycle.

`mobile/` contains the native projects, `app/` contains the shared UI and browser previews, and `firmware/` contains the board code.

| Reference | Contents |
| --- | --- |
| [Parts](list.md) | Purchased components and remaining test hardware |
| [Firmware simulation](firmware/simulation/README.md) | Workbench controls and rebuilding |
| [BLE protocol](docs/protocol.md) | Reference for custom clients |

## Software checks

From the repository root, with app dependencies, PlatformIO and a C++11 compiler installed:

```sh
python3 tools/test-firmware.py
pio run -d firmware
cd app
npm test
npm run build
```

If the simulation reports stale firmware, [rebuild it](firmware/simulation/README.md#after-firmware-changes).
