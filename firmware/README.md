# Firmware

Arduino + NimBLE firmware for the XIAO ESP32C3. No phone-side authorization or cloud service is needed. The device advertises the service UUID and `Carry-XXXXXX` tag identifier; token/passenger data is absent from advertising and status.

## Build and upload

```sh
pio run -d firmware
pio run -d firmware --target upload
```

Run these commands from the repository root. PlatformIO downloads the pinned toolchain and dependencies on the first build. If multiple serial devices exist, add `--upload-port /dev/ttyACM0` using the actual port. Disconnect battery power before programming over USB, per the original guide.

## Configuration

Edit [`include/Config.h`](include/Config.h) before uploading:

| Function | Board pin | GPIO |
| --- | --- | --- |
| Servo signal | D10 | 10 |
| Open microswitch | D3 | 5 |
| Closed microswitch | D4 | 6 |
| Setup/service button | D5 | 7 |
| External LED | D6 | 21 |

Switches and button use internal pull-ups, active LOW. GPIO21 is also a UART TX pin; firmware deliberately does not call `Serial.begin()` or print tokens/logs on UART.

Servo PWM uses 50 Hz and 14-bit LEDC on Arduino ESP32 2.x. `OPEN_PULSE_US=1400` and `CLOSED_PULSE_US=1600` are conservative starting values around 1500 µs, **not measured travel calibration**. Adjust unloaded around the center before attaching the linkage, then verify each endpoint triggers before binding. The default movement timeout is 1000 ms; adjust from measured travel. PWM is detached after endpoint confirmation or a fault. PWM removal cannot guarantee motor power cutoff; if pushing/buzzing continues, switch off the main supply and free the mechanism as described in the guide.

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
