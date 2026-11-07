# Single-tag prototype: wiring and testing

Use the purchased ESP-WROOM-32 board, one SG90 servo and tactile buttons. The phone selects the tag over Bluetooth; no NFC tapping is needed. [Parts list](list.md).

## Power

For bench testing, power the ESP32 through USB-C and the servo from a separate regulated 5 V supply. Join their grounds. Do not connect that external 5 V rail to the USB-powered board, its 3V3 pin, or any GPIO.

If using the LM2596, feed it a suitable DC source above its 5 V output with sufficient headroom. Measure and set its output before connecting the servo. It is a step-down regulator and cannot boost one 18650 cell to 5 V. The supply and wiring must handle motor startup/load without voltage drops. [TI reference](https://www.ti.com/product/LM2596).

## Wiring

Use the board’s GPIO labels, not physical header positions. These match [BoardConfig.h](firmware/include/BoardConfig.h).

| Connection | Destination |
| --- | --- |
| Servo signal | GPIO25 |
| Servo positive | Regulated 5 V servo supply |
| Servo ground | Common GND with ESP32 and supply |
| Open endpoint switch | GPIO32 to GND when fully open |
| Closed endpoint switch | GPIO33 to GND when fully closed |
| Setup/service button | GPIO27 to GND while pressed |
| Optional LED | GPIO26 → 1 kΩ resistor → LED anode; cathode → GND |

Inputs use internal pull-ups: closing a switch pulls its GPIO LOW. Never apply 5 V to a GPIO. On each four-leg tactile button, choose one leg from each internally connected pair; verify that continuity occurs only when pressed. [ESP32 pin reference](https://documentation.espressif.com/esp32-wroom-32_datasheet_en.html).

## Bench test with the purchased buttons

Without endpoint switches, use two spare tactile buttons on GPIO32 and GPIO33 to simulate them. These indicate positions manually; they do not prove that the servo moved.

1. [Upload the firmware](firmware/README.md) and [install the mobile app](mobile/README.md).
2. Hold only the open-position button while powering the tag. Keep it held until closing starts.
3. Connect to `Carry-XXXXXX`, scan demo pass A, then hold the setup button for ½ second and release before 3 seconds.
4. When closing starts, release the open button and press/hold the closed button before the movement timeout (initially 1 second). Wait for **Bag locked**.
5. Scan pass B: it must be rejected. Scan A: when opening starts, release closed and press/hold open before the timeout. Wait for **Bag released**.

Do not assert both endpoints together. With neither endpoint connected at boot, the tag correctly enters recovery.

## Fit the mechanism

Test the servo unloaded first, including its response to the ESP32’s 3.3 V signal. Fit a freely moving bolt through the cable eyelet; the base and guides must carry the cable load. Add endpoint contacts, travel stops and a manual way to release the linkage.

Calibrate `OPEN_PULSE_US` and `CLOSED_PULSE_US` in [BoardConfig.h](firmware/include/BoardConfig.h). The initial 1400/1600 µs pulses are starting values, not calibrated positions. Adjust `MOVEMENT_TIMEOUT_MS` in [Config.h](firmware/include/Config.h) to measured travel. Rebuild and upload after changes.

## Recovery and checks

For a jam, switch off servo power before clearing it. Once clear and powered, hold the setup/service button for 3 seconds to request opening. This bypasses the pass check. The app confirms release only when the open contact is active; with bench buttons, supply that input yourself. Correct conflicting endpoint inputs first.

Before a demonstration, check repeated lock/release cycles, wrong-pass rejection, storage closing, service opening, and reconnecting after a reboot. Rebooting must not clear a locked assignment. Interrupted movement requires recovery. This is a functional prototype, not a tamper-resistant lock.
