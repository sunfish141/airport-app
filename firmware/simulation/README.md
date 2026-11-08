# Firmware simulation

Runs `Controller.cpp` and `ServoMotion.h` as WebAssembly. The open-case view shows the servo arm, connecting rod and sliding latch alongside the ESP32, LM2596 and D27 button. Motion follows the PWM command; linkage geometry is illustrative and position is unmeasured. Pin assignments are available below the view.

## Run

Requires Node.js 22.16+. From `app/`:

```sh
npm ci
npm run simulate
```

Open `/simulation.html`. Click **Connect**, then scan pass A in the app preview to lock. Scan B to test rejection; scan A again to release. Moves complete after 500 ms. Boot clears assignment and commands opening.

- **Hold GPIO27:** manual button input. **Hold 3.2 s:** service opening.
- **Reboot / Power off:** simulated power cycle. **Reset simulation:** clears saved state and injected faults.
- **Radio inputs:** synthetic RSSI; location estimates also use synthetic data.
- **Storage fault injection:** fail writes or corrupt the saved CRC.
- **Event log / Build:** controller events, PWM settings and source hash.
- **Pause / Step / Rate:** simulation time controls. App timeouts use wall time.

The browser saves simulated NVS. BLE, Wi-Fi, electrical behavior and mechanical loads are not emulated. Position is unverified, as on the current tag.

## Rebuild after firmware changes

Install Zig 0.14.1, then run from `app/`:

```sh
npm run firmware:build
npm test
npm run build
```

Set `WASM_CXX='/path/to/zig c++'` if Zig is not on `PATH`. The app rejects stale builds. For the browser integration check, keep the dev server running and run `npm run test:simulation`; set `APP_URL` if needed.
