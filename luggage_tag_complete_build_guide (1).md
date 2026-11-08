# Single-tag prototype: wiring and testing

Use the purchased ESP-WROOM-32 board, one SG90 servo and tactile buttons. The phone selects the tag over Bluetooth; no NFC tapping is needed. [Parts list](list.md).

## Power

For bench testing, power the ESP32 through USB-C and the servo from a separate regulated 5 V supply. Join their grounds. Do not connect that external 5 V rail to the USB-powered board, its 3V3 pin, or any GPIO.

If using the LM2596, feed it a suitable DC source above its 5 V output with sufficient headroom. Measure and set its output before connecting the servo. It is a step-down regulator and cannot boost one 18650 cell to 5 V. The supply and wiring must handle motor startup/load without voltage drops. [TI reference](https://www.ti.com/product/LM2596).

## Wiring

Use the board’s GPIO labels, not physical header positions. These match [BoardConfig.h](firmware/include/BoardConfig.h).

| Connection | Destination |
| --- | --- |
| Servo signal | GPIO14 (D14) |
| Servo positive | Regulated 5 V servo supply |
| Servo ground | Common GND with ESP32 and supply |
| GPIO32 / GPIO33 | Leave unconnected; not used for position confirmation |
| Setup/service button | GPIO27 (D27) to GND while pressed |

Inputs use internal pull-ups: closing a switch pulls its GPIO LOW. Never apply 5 V to a GPIO. On each four-leg tactile button, choose one leg from each internally connected pair; verify that continuity occurs only when pressed. [ESP32 pin reference](https://documentation.espressif.com/esp32-wroom-32_datasheet_en.html).

## Timed servo demo

The firmware starts by commanding the open position for half a second, then shows **Scan to lock**. D32/D33 can be left unconnected.

1. Connect to `Carry-XXXXXX` and scan demo pass A. The servo sweeps toward closed for half a second, then the app shows **Bag locked**.
2. Scan B to check rejection; the servo should stay still.
3. Scan A again. The servo sweeps back for half a second, then the app shows **Bag released**.

No half-second setup hold is needed. Holding D27 for three seconds requests opening. Every restart clears the demo assignment and commands opening again. The app marks position as unverified: timing cannot detect a jam, disconnected servo or failed linkage.

The standard positional SG90 moves between pulse targets; it does not spin continuously. The initial targets are 500/2500 µs, ramped over 450 ms plus 50 ms settling. Actual rotation depends on the servo; these pulse targets do not guarantee 180° or detect a mechanical stop. Calibrate these to the actual latch and keep its travel clear during startup. PWM is detached after movement; the latch must stay in place mechanically.

## Fit the mechanism

Test the servo unloaded first, including its response to the ESP32’s 3.3 V signal. Fit a freely moving bolt through the cable eyelet; the base and guides must carry the cable load. Include travel stops and a manual way to release the linkage.

Calibrate `OPEN_PULSE_US` and `CLOSED_PULSE_US` in [BoardConfig.h](firmware/include/BoardConfig.h). The initial 500/2500 µs pulses are starting values, not calibrated positions. Adjust `DEMO_MOVEMENT_MS` and `DEMO_SETTLE_MS` in [Config.h](firmware/include/Config.h) if needed. Rebuild and upload after changes.

## Recovery and checks

For a jam, switch off servo power before clearing it. Once clear and powered, hold the setup/service button for 3 seconds to request opening. This bypasses the pass check. Opening is assumed after half a second.

Before a demonstration, check repeated lock/release cycles, wrong-pass rejection, storage closing, service opening, and reconnecting after a reboot. Rebooting deliberately clears the demo assignment and commands opening again. This is a functional prototype, not a tamper-resistant lock.
