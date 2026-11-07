# ESP-WROOM-32 firmware

For the purchased Kidsrobot 30-pin board and SG90 servo. Use the [wiring and test guide](<../luggage_tag_complete_build_guide (1).md>) for power, GPIO connections and bench buttons.

## Build and upload

Install PlatformIO Core or the PlatformIO extension in VS Code. From the repository root:

```sh
pio run -d firmware
pio run -d firmware --target upload
```

The default `esp32_wroom32` environment uses `esp32dev` (classic ESP32, 4 MB flash). Use a USB-C data cable. Add `--upload-port <your-port>` if multiple boards are connected. If upload stalls at connecting, hold BOOT until connection, then release it. BOOT and EN are not the application setup button.

## Settings

| File | Edit for |
| --- | --- |
| [BoardConfig.h](include/BoardConfig.h) | GPIOs and SG90 pulse calibration; initial 1400/1600 µs at 50 Hz |
| [Config.h](include/Config.h) | Movement timeout (initially 1 second), button timing and BLE UUIDs |
| [platformio.ini](platformio.ini) | Board and pinned toolchain/library versions |

Rebuild and upload after changes. Rebuild the [browser simulation](simulation/README.md#after-firmware-changes) after controller/configuration changes.

## Controls

- **Setup:** while open/unassigned, hold GPIO27’s button for at least ½ second and release before 3 seconds. Setup lasts 10 seconds; normally scan the pass first and press when prompted.
- **Service open:** hold for 3 seconds. This bypasses pass matching; correct any obstruction or conflicting switches first.
- **Optional LED:** slow blink during setup, faster blink on fault. **Flash light** flashes it for 2 seconds.
- **Proximity:** the phone’s **Find tag** view reads connection signal strength from the tag. Re-upload after this update; older firmware continues to lock/release but cannot report signal strength.

Both endpoint contacts are required. Reboot preserves assignment; interrupted movement or invalid endpoint readings require recovery. Completion always depends on an endpoint contact, not elapsed servo time.

## Checks and editor setup

```sh
python3 tools/test-firmware.py
pio run -d firmware -t compiledb
```

Run from the repository root. Native tests require a C++11 compiler (`g++` by default; override with `CXX`). The second command refreshes VS Code’s include paths after board/dependency changes.
