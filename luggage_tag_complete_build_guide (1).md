# Luggage tag MVP — implementation guide

One battery-powered BLE tag with a servo-driven bolt, phone QR scanning, and reusable assignments. Proposed design; hardware and software require bench validation.

## 1. Operation

1. Insert the cable eyelet into the bolt guide.
2. Activate setup and scan a demo boarding-pass QR. The tag stores its token and closes the bolt.
3. A matching token opens the bolt; a different token is rejected.
4. The open-position switch confirms release before the tag clears its assignment.
5. **Close for storage** closes an unassigned tag without scanning. The service button reopens it.

Token comparison runs on the tag. Tokens are copyable/replayable; the service button bypasses ownership. Advertise only the tag ID, never the token or passenger information.

## 2. Parts

| Qty | Component | Specification |
|---:|---|---|
| 1 | XIAO ESP32C3 | Attach supplied antenna |
| 1 | SG90 positional servo | Include horn and screw; not continuous rotation |
| 1 | Protected 18650 cell | 3.6/3.7 V nominal, approximately 3,000–3,500 mAh, documented discharge rating ≥5 A |
| 1 | Battery holder | Fits actual protected-cell length, approximately 69–70 mm; contacts ≥5 A |
| 1 | 5 V boost converter | Pololu U3V40F5; validate servo startup plus controller load at low battery voltage |
| 1 | Main switch | ≥5 A DC |
| 1 | Fuse and holder | 5 A; install near battery positive |
| 1 | Schottky diode | 1N5819, controller supply branch |
| 2 | NO lever microswitches | Bolt-open and bolt-closed detection |
| 1 | NO momentary button | Setup and service override |
| 1 each | LED and resistor | 1 kΩ series resistor |
| 1 | Electrolytic capacitor | 1,000 µF, ≥10 V, servo supply |
| 1 | Electrolytic capacitor | 100 µF, ≥10 V, boost input |
| 1 | Ceramic capacitor | 100 nF, servo supply |
| 1 set | Perfboard, connectors, wire, heat-shrink | Short 20 AWG power leads; thinner signal wires |
| 1 | Steel cable with eyelets | Pre-terminated, or use matching ferrules and crimp tool |
| 1 set | Printed parts | Base, two bolt guides, servo bracket, lid |
| 1 set | Mechanical hardware | Approximately 3 mm steel bolt/rod, linkage, screws, washers, nuts |
| 1 shared | Li-ion charger | Compatible with protected cell; remove cell to charge |
| 1 | USB-C data cable | Programming |
| If needed | SN74AHCT125N, DIP socket, 100 nF capacitor | Servo signal conversion from 3.3 V to 5 V |

Tools: soldering iron, multimeter, calipers, screwdrivers, cutter, printer and filament; preferably a current-limited bench supply.

## 3. Wiring

| Connection | Destination |
|---|---|
| Battery positive | Fuse → main switch → boost VIN |
| Battery negative | Common GND: boost, XIAO, servo and switches |
| Boost 5 V | Servo positive and 1N5819 anode |
| 1N5819 cathode, banded end | XIAO **5 V** pin; leave BAT pads unused |
| Servo signal | D10 / GPIO10 |
| Open switch | COM → GND; NO → D3 / GPIO5 |
| Closed switch | COM → GND; NO → D4 / GPIO6 |
| Setup/service button | GND and D5 / GPIO7 |
| LED | D6 / GPIO21 → 1 kΩ → anode; cathode → GND |
| 1,000 µF and 100 nF | Servo 5 V to GND, close to connector |
| 100 µF | Boost VIN to GND, close to converter |

Configure switches/button as `INPUT_PULLUP`: pressed = LOW. Observe electrolytic polarity. Route servo power and return directly to the supply junction, not through the XIAO or solderless breadboard. Disconnect battery power before USB programming; unplug USB before battery operation. [1]

Test the purchased servo with 3.3 V PWM. If unreliable or incompatible, add the AHCT125 buffer: pin 14 → 5 V; 7 → GND; 1 → GND; D10 → 2; 3 → servo signal. Add 100 nF across 14/7. Tie unused inputs 5/9/12 to GND and enables 4/10/13 to 5 V; leave outputs 6/8/11 disconnected. Check DIP orientation. [4]

## 4. Mechanical assembly

Use a sliding steel bolt through the removable cable eyelet. Support it on both sides with printed guides; attach the cable's fixed eyelet to the base with a bolt, washers and nut. Cable load must transfer into the guides/base rather than the servo gears.

1. Print the base, guides and servo bracket.
2. Fit the bolt and remove friction by hand.
3. Centre the servo before attaching its horn.
4. Couple the horn to the bolt using a short linkage or horn pin in a slotted slider.
5. Calibrate open/closed travel without hitting the servo's internal stops.
6. Mount endpoint switches to trigger before binding. Add separate mechanical stops.
7. Provide a removable linkage pin for manual release.

The mechanism closes by servo command; it does not snap closed automatically.

## 5. Firmware

Use Arduino, the ESP32 board package, NimBLE-Arduino, and Preferences/NVS. Start from a basic BLE GATT server. [5]

Expose one writable command characteristic and one readable/notifiable status characteristic. Commands are one ASCII opcode followed by the payload, without a terminator; maximum length is 17 bytes.

| Opcode | Payload | Validation/action |
|---|---|---|
| `L` | 16 ASCII hexadecimal characters | Require unassigned, bolt open, setup window active. Persist token, then close |
| `U` | 16 ASCII hexadecimal characters | Require matching stored token; open |
| `C` | None | Require unassigned and bolt open; close for storage |
| `F` | None | Optional bounded LED flash |

Reject malformed lengths/tokens, unknown commands and movement requests while busy. Return state/error notifications; never report success from receipt of a command alone.

| State | Meaning |
|---|---|
| `OPEN_FREE` | Open switch active; no assignment |
| `CLOSED_FREE` | Closed switch active; no assignment |
| `LOCKED_ASSIGNED` | Closed switch active; token stored |
| `MOVING` | Endpoint transition in progress |
| `FAULT` | Timeout, conflicting sensors or unresolved persisted state |

Implementation rules:

- Debounce inputs for approximately 30 ms. Both endpoint switches active is a fault; neither active does not prove opening.
- Persist assignment and pending movement before actuation. Confirm closed with the closed switch; clear assignment only after confirmed opening.
- Use calibrated servo pulses at 50 Hz. Begin near 1.5 ms centre and expand travel cautiously within the servo's limits. [2]
- Set an initial movement timeout around one second, adjusted to measured travel. On timeout, stop PWM, retain assignment, report `FAULT`, and do not retry automatically.
- PWM removal may not stop motor current. If the servo continues pushing/buzzing, turn off the main switch and free the mechanism; this circuit has no automatic motor-power cutoff.
- A short button hold while unassigned starts a 10-second setup window. A three-second hold requests service opening, once per press, from any state. Clear assignment only after confirmed opening.
- On boot, reconcile NVS and switches. Preserve ownership; interrupted or contradictory states require service recovery.

## 6. Phone interface

Use React or plain JavaScript on **Android Chrome over HTTPS**. Web Bluetooth device selection requires a user gesture. Test the actual phone first; a plain HTTP LAN address does not satisfy the secure-origin requirement. [6]

1. Implement **Connect** using the tag's BLE service UUID.
2. Subscribe to status and handle disconnects.
3. Use `@zxing/browser` for camera QR decoding. [7]
4. Print two demo QR passes containing distinct 16-character hexadecimal tokens.
5. **Scan to lock:** validate token format, then write `L` + token.
6. **Scan to unlock:** write `U` + token; authorization remains in firmware.
7. **Close for storage:** write `C`.
8. Display confirmed state and errors. Add `F` only if time permits.

Use one consistent token case, such as uppercase, on both devices. Use synthetic QR passes; real airline barcode parsing is outside this implementation.

## 7. Build sequence

| Stage | Work | Exit check |
|---|---|---|
| Day 1: setup | Upload firmware; connect phone to BLE service | Read and write a test value |
| Day 1: power | Assemble power wiring; measure rails before connecting loads | Stable 5 V; correct polarity; no shorts |
| Day 1: actuator | Test unloaded servo, then printed bolt and switches | Cable retained/released without resets or binding |
| Day 1: control | Implement commands, token comparison and NVS | Matching token opens; wrong token fails |
| Day 2: interface | Add QR camera, state display, setup and reuse | Complete scan → lock → unlock → clear loop |
| Day 2: integration | Secure wiring, install battery and lid | Untethered operation with enclosure closed |
| Day 2: validation | Run acceptance tests | Repeatable demonstration |

Before first battery operation, verify the converter supports motor startup plus controller load at the intended minimum battery voltage. A converter's switch/input-current rating is not its output-current rating. [3]

## 8. Acceptance tests

- Twenty lock/unlock cycles without jams or resets.
- Wrong token rejected without changing assignment.
- Correct token clears assignment only after open-switch confirmation.
- Close for storage and service reopening work without rescanning.
- Reassignment accepts the new token and rejects the old one.
- Reboot preserves ownership and does not unlock automatically.
- Obstruction produces a timeout/fault without automatic retries; manual recovery works.
- Battery-powered operation lasts through the planned demo; verify battery voltage and supply stability under motor load.

## References

1. [XIAO ESP32C3 pinout and power](https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/)
2. [SG90 specifications](https://towerpro.com.tw/product/sg90-7/)
3. [U3V40F5 converter](https://www.pololu.com/product/4012)
4. [SN74AHCT125 datasheet](https://www.ti.com/lit/ds/symlink/sn74ahct125.pdf)
5. [NimBLE-Arduino server guide](https://github.com/h2zero/NimBLE-Arduino/blob/master/docs/New_user_guide.md)
6. [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)
7. [ZXing browser](https://github.com/zxing-js/browser)
