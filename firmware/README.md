# ESP-WROOM-32 firmware

For the purchased Kidsrobot 30-pin board and SG90 servo. Use the [wiring and test guide](<../luggage_tag_complete_build_guide (1).md>) for power, GPIO connections and bench buttons.

## Build and upload

Install PlatformIO Core or the PlatformIO extension in VS Code. From the repository root:

```sh
pio run -d firmware
pio run -d firmware --target upload
```

The default `esp32_wroom32` environment uses `esp32dev` (classic ESP32, 4 MB flash). It starts open after every boot, clears its demo assignment, and ignores D32/D33. Use a USB-C data cable. Add `--upload-port <your-port>` if multiple boards are connected. If upload stalls at connecting, hold BOOT until connection, then release it. BOOT and EN are not the application setup button.

## Settings

| File | Edit for |
| --- | --- |
| [BoardConfig.h](include/BoardConfig.h) | GPIOs and SG90 pulse calibration; initial 500/2500 µs at 50 Hz |
| [Config.h](include/Config.h) | Sweep/settling time (450 + 50 ms), service-button timing and BLE UUIDs |
| [platformio.ini](platformio.ini) | Board and pinned toolchain/library versions |

Rebuild and upload after changes. Rebuild the [browser simulation](simulation/README.md#rebuild-after-firmware-changes) after controller/configuration changes.

## Controls

- **Timed demo:** scan A to sweep toward closed for half a second; scan A again to sweep back. Wrong passes are rejected. No half-second setup hold is required. The app labels position as unverified; there is no jam detection in this mode. Startup also commands opening, starting from an assumed neutral pulse because there is no position feedback.
- **Service open:** hold for 3 seconds. This bypasses pass matching; clear the latch first.
- **Proximity:** the phone’s **Find tag** view reads connection signal strength from the tag. Re-upload after this update; older firmware continues to lock/release but cannot report signal strength.
- **Wi-Fi estimate:** a connected phone may request a Wi-Fi scan. A separate worker returns nearby AP addresses/signals over BLE; the phone handles the internet lookup without a USB cable. No Wi-Fi credentials are needed on the tag. Scans are refused during movement/setup, limited to one per 10 seconds, and invalidated on disconnect. The worker waits for the scan-complete event with a six-second deadline, allowing for Bluetooth/Wi-Fi radio sharing.

Completion depends only on elapsed time and every boot resets to open/unassigned. The 500/2500 µs targets request nominal full travel ([Renesas AN-1057](https://www.renesas.cn/zh/document/apn/1057-servo-motor-control)); the firmware does not measure actual angle or detect a mechanical stop. Calibrate targets to the latch; PWM detaches after each move, so the latch must retain its position mechanically.

Bench check: the current servo was visually confirmed to sweep about 180° at 500/2500 µs, with 500 ms per move. The tag still has no position feedback; recheck travel if the servo or linkage changes.

## USB state monitor

Open the board's serial port at **115200 baud** (`pio device monitor -d firmware`). Read-only `tag` lines appear on changes and once per second; no tokens are logged. `pins` lists servo/setup/open/closed GPIOs, currently `14,27,32,33`. `open`, `closed` and `button` are debounced active-low inputs; `pwm=1` means a movement signal is being sent, not that a servo moved. `ble` counts connected phones.

State codes: `0` open/free, `1` closed/free, `2` locked/assigned, `3` moving, `4` fault. Error codes: `0` none, `8` wrong pass, `9` movement timeout, `10` conflicting endpoints, `11` recovery required, `12` storage, `13` actuator. Remaining codes are in [Controller.h](include/Controller.h). `demo=1` identifies timed operation; `pulse_us` shows the current commanded pulse while moving. D32/D33 readings are diagnostic only and do not control movement.

## Checks and editor setup

```sh
python3 tools/test-firmware.py
pio run -d firmware -t compiledb
```

Run from the repository root. Native tests require a C++11 compiler (`g++` by default; override with `CXX`). The second command refreshes VS Code’s include paths after board/dependency changes.
