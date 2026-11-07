# Firmware

Arduino + NimBLE firmware for the purchased Kidsrobot 30-pin **ESP-WROOM-32** development board in [`../list.md`](../list.md). PlatformIO uses the generic classic ESP32 `esp32dev` profile (4 MB flash), with environment `esp32_wroom32`. Token comparison runs on the tag. The device advertises the service UUID and `Carry-XXXXXX` tag identifier; token/passenger data is absent from advertising and status.

## Build and upload

```sh
pio run -d firmware
pio run -d firmware --target upload
```

Run these commands from the repository root. PlatformIO downloads the pinned toolchain and dependencies on the first build. If multiple serial devices exist, add `--upload-port /dev/ttyACM0` using the actual port. Use a data-capable USB-C cable. Disconnect the external 5 V supply when programming over USB; the clone’s USB/external-power isolation has not been verified. If automatic upload fails, hold BOOT while the uploader connects, then release it. The board’s BOOT and EN buttons are not the application setup button.

When opening the repository root in VS Code, generate the C++ IntelliSense configuration with `pio run -d firmware -t compiledb`. Repeat after changing the board, build flags, or dependencies in `platformio.ini`. The workspace uses the generated `firmware/compile_commands.json` to resolve Arduino, NimBLE, FreeRTOS, and toolchain headers; this machine-specific file is excluded from Git.

## Configuration

Hardware pin assignments and SG90 PWM settings live in [`include/BoardConfig.h`](include/BoardConfig.h). BLE identifiers and controller timing remain in [`include/Config.h`](include/Config.h). The Arduino adapter rejects builds for a different ESP32 family.

Use the GPIO labels printed on the purchased board, not physical header positions or the old XIAO D numbers:

| Function | ESP32 GPIO | Connection |
| --- | --- | --- |
| SG90 signal | 25 | Servo signal lead |
| Open endpoint contact | 32 | Normally open contact to GND; closed at fully open |
| Closed endpoint contact | 33 | Normally open contact to GND; closed at fully closed |
| DAOKI setup/service button | 27 | Momentary contact to GND |
| External status LED | 26 | Series resistor and LED to GND, active HIGH |

These assignments avoid flash GPIO6–11, boot strapping pins, UART0 and input-only pins without pull-ups. GPIO21/22 remain available for a future I²C peripheral. This differs from the original guide’s XIAO wiring. [Espressif pin reference](https://documentation.espressif.com/esp32-wroom-32_datasheet_en.html), [PlatformIO board profile](https://docs.platformio.org/en/stable/boards/espressif32/esp32dev.html).

Switches and button use internal pull-ups and are active LOW. The four legs on a tactile switch are two internally connected pairs: use one leg from each pair, verifying with continuity testing that the circuit closes only while pressed. Do not connect a permanently joined pair between GPIO and GND. No switch input connects to 5 V.

Servo PWM uses 50 Hz and 14-bit LEDC on the pinned Arduino ESP32 2.x framework. `OPEN_PULSE_US=1400` and `CLOSED_PULSE_US=1600` are conservative starting values around 1500 µs, **not measured travel calibration**. Adjust unloaded around the center before attaching the linkage, then verify each endpoint triggers before binding. The default movement timeout is 1000 ms; adjust `Config.h` after measuring the mechanism. PWM is detached after endpoint confirmation or a fault. PWM removal cannot guarantee motor power cutoff; if pushing/buzzing continues, switch off the servo supply before freeing the mechanism.

## Purchased parts and remaining hardware

| Purchased part | Firmware use |
| --- | --- |
| Kidsrobot ESP-WROOM-32, 30 pins, USB-C | Classic ESP32 target, BLE and NVS |
| SG90 servo | One servo drives the bolt; the second is a spare |
| DAOKI 6×6×5 mm momentary switches | Setup/service input; spare switches can simulate endpoints on the bench |
| LM2596 adjustable module | External step-down supply; no firmware driver or voltage sensing |
| Jumper wires | Prototype interconnections; no software configuration |

The main purchase list does **not** include endpoint microswitches, an external LED/resistor, an NFC device or a power source. An onboard user LED is not assumed for this board variant. The LED output is available on GPIO26, but **Find tag** has no visible effect until an LED and resistor are fitted. A reliable linkage needs two mechanically actuated endpoint contacts; elapsed servo time is never treated as confirmation. No NFC pairing is implemented by this hardware change.

For a bench-only test with the purchased tactile switches, use three buttons: open on GPIO32, closed on GPIO33, and setup on GPIO27. Hold the open button at boot. After a lock command starts motion, release open and press/hold closed before the timeout. Reverse that sequence for opening. These manually asserted contacts test software only; they do not prove the bolt moved. With both endpoint inputs unconnected, the firmware correctly enters recovery instead of claiming the tag is open. Never press both endpoint buttons together during a normal cycle.

## LM2596 power arrangement

The purchased LM2596 is a **buck (step-down)** module. It cannot convert one 18650 cell’s voltage to the 5 V servo rail used here. Its regulator IC specifies a 4.5–40 V input operating range, but producing a regulated 5 V output requires an input above 5 V with headroom; the module’s own ratings may be lower. The earlier guide’s single-cell boost arrangement does not apply. [TI LM2596 reference](https://www.ti.com/product/LM2596).

For bench operation, set the LM2596 output to 5.0 V with a suitable DC source and measure it **before** connecting electronics. Power the servo from that regulated rail, with a common ground to the ESP32. Do not power the servo from the ESP32’s 3V3 pin. The board can use USB while the servo has a separate regulated supply, sharing only ground and the signal connection. For standalone operation, verify the board’s documented 5 V/VIN input before powering it from the rail and disconnect USB. Supply current, motor transients, decoupling and battery protection still require hardware validation; the simulator does not calculate them.

## Button and LED

- Inputs debounce for 30 ms, including initial boot readings.
- A hold of 500–2999 ms followed by release, while open/unassigned, starts a 10-second setup window. Shorter taps do nothing.
- Holding for 3000 ms triggers service opening once per press, including while moving or faulted. It bypasses token comparison. Ownership clears only once the debounced open switch confirms.
- Setup blinks the LED at 1 Hz; a fault at 2 Hz. `F` flashes for two seconds at 5 Hz. No automatic retry occurs after a fault.

## Durable state and recovery

The `luggage` NVS namespace stores one `state` blob with a version, flags, pending direction, 16 token bytes and CRC32. One `putBytes()` commits the record atomically before actuation. Closing with an assignment commits the token and closing intent together. Opening keeps that token through the movement and clears it only after open confirmation and a successful final storage commit.

Boot never drives the servo. A clean assigned/closed record becomes `LOCKED_ASSIGNED`; a clean unassigned record reconciles to its active endpoint. Pending movement, a latched fault, neither endpoint, both endpoints, corrupt/unavailable storage, or assigned/open combinations require service recovery. Open-at-boot never clears ownership. Failed storage writes block actuation or prevent final success. A fault retains pending movement and ownership. The physical service hold is the only recovery path; it persists a new opening intent, then clears the fault/assignment on confirmed release. Conflicting sensors prevent service actuation.

BLE callbacks enqueue bounded messages. Only the Arduino loop touches the controller, NVS and servo. Messages over 17 bytes and invalid hex/lengths are rejected; queue overflow reports `BUSY`. The command characteristic supports writes with response only. The status characteristic holds the latest readable packet and sends notifications on state, command/error and setup-countdown changes. See [`../docs/protocol.md`](../docs/protocol.md).

## Controller tests

```sh
python3 tools/test-firmware.py
```

Run from the repository root with a C++11 compiler installed. The test harness builds `src/Controller.cpp` directly against an in-memory hardware implementation. It asserts that persistence precedes every servo actuation and that ownership remains through incomplete/failed opening. Physical switch placement, power stability, flash durability during real brownouts and motor behavior require device testing.
