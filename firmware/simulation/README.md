# Firmware simulation

Runs the same C++ controller as the physical tag, with simulated servo travel, contacts and storage. The diagram uses the ESP-WROOM-32 / SG90 / LM2596 configuration.

## Run

Requires Node.js 22.16+. From the repository root:

```sh
cd app
npm ci
npm run simulate
```

Open `/simulation.html` at the printed URL. The compiled firmware is included; no C++ compiler or physical hardware is needed to run it.

1. Click **Connect** above the phone.
2. In the phone, select **Scan to lock** and pass A.
3. Click **Setup hold · 650 ms** when prompted; wait for **Bag locked**.
4. Scan B to test rejection, then A to release.
5. Use **Service hold · 3.2 s** for recovery or opening after storage closing.

## Controls

- **Hardware assumptions & fault injection:** test a jam, switch faults, storage failure or corrupt saved state. Clear the injected fault before service opening.
- **Bluetooth signal test:** open **Find tag** in the phone and change the synthetic RSSI slider. Disable readings to test stale-data handling. The radio is simulated in JavaScript; the C++ controller still handles locking and recovery.
- **Cut main power / Reboot MCU:** retain saved assignment and bolt position. The phone reconnects automatically when the tag is ready again; interrupted movement still requires recovery.
- **Reset saved simulation:** clears the saved demo and faults. Normal reloads retain browser-saved state.
- **Firmware state / Event trace:** inspect position confirmation, stored ownership and command results.
- **Speed / Pause / Step:** control simulated time. The phone’s 5-second timeout still uses real time, so reconnect after a long pause.

The model assumes calibrated servo travel. It does not validate real wiring, Bluetooth reception, power/current or mechanical strength; PWM removal is not a guaranteed physical motor cutoff.

## After firmware changes

Install Zig 0.14.1 (the tested version) on `PATH`, then run from `app/`:

```sh
npm run firmware:build
npm run firmware:check
npm test
npm run build
```

Alternatively set `WASM_CXX='/path/to/zig c++'` for the build command. A stale-build error means the controller/configuration changed: rebuild and reload the page. `npm run dev` does not compile C++.

For a browser check, see the [app instructions](../../app/README.md#preview-and-checks) and run `npm run test:simulation`.
