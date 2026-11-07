# Phone app

Plain JavaScript/Vite app. Requires Node.js 22.16+. Its firmware workbench uses an included WebAssembly build of the separate firmware project.

```sh
npm ci
npm run dev
```

Development and preview servers bind to `127.0.0.1` by default. Use the built static files on an HTTPS host for phone operation.

## Mobile emulator

```sh
npm run emulator
```

This starts a local server and opens `/emulator.html` on its printed URL, normally **http://127.0.0.1:5173/emulator.html**. If the server is already running with `npm run dev`, open `/emulator.html` on that server’s URL. When using VS Code through WSL or SSH, use the forwarded port URL if localhost does not reach the server.

The preview embeds the actual app at selectable Android screen sizes, with rotation and a virtual tag. Click **Connect virtual tag**. In the phone, tap **Scan to lock** and choose pass A, then click **Setup button** when prompted. Try unlocking with B for a mismatch, then with A for a successful release. The scanner decodes the included QR image without requesting a camera.

The test bench also provides service opening, obstruction/timeouts, reboot and reset. A reboot retains the simulated assignment; a reset clears the virtual tag. Everything stays in memory. `/emulator.html` and the opt-in demo URL `/?demo=1` are included in the static build. The normal `/` app continues to use real Web Bluetooth. This is a browser viewport and tag simulator, not an Android OS emulator; physical Bluetooth, camera permissions and the firmware still require device testing.

With a dev server running, use `npm run test:emulator` to verify the interactive preview in Chromium.

## Production firmware simulation

```sh
npm run simulate
```

This opens `/simulation.html`: an animated bolt/servo/cable cutaway, live GPIO and debounce readings, NVS ownership and pending intent, an event trace, and the phone app connected to the **production C++ controller running as WebAssembly**. The mobile emulator above remains a lightweight JavaScript demo.

Setup and service presets physically hold the simulated button through the real firmware timing. Try jams, switch wiring faults, failed storage writes, corrupt records and power cuts. State is retained in browser storage across reloads; **Reset saved simulation** clears it. The normal real-device app does not store tokens; this explicitly selected workbench stores its synthetic assignment record.

The compiled module is included, so Zig is needed only to rebuild after firmware changes. `npm run firmware:check` verifies source and artifact hashes; `npm run firmware:build` rebuilds using Zig on your PATH. See [`../firmware/simulation/README.md`](../firmware/simulation/README.md) for exact coverage, assumptions, instructions and limitations. With the server running, `npm run test:simulation` verifies the workbench in Chromium.

Use Android Chrome over **HTTPS trusted by the phone** for BLE and camera operation. The localhost development exception applies only on the computer running the server; HTTP on a LAN IP is insufficient. Build static hosting files with `npm run build`, then serve `dist/` over HTTPS. See [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth).

- **Connect tag** opens the browser's device selector from a click gesture, filters by the firmware service UUID, subscribes to status and reads the current state.
- **Scan to lock/release** uses `@zxing/browser` and a rear-facing camera preference. Valid QR content is exactly 16 hexadecimal characters. Tokens normalize to uppercase.
- **Tag options** (···) contains storage, finding the tag, disconnect and manual token entry. **Close for storage** closes a confirmed open/unassigned tag. The physical 3-second service button hold reopens it.
- **Find tag** requests a two-second LED flash.
- Setup is **connect → scan → hold the tag button for ½ second and release**. Scanning first keeps camera permission outside the firmware’s 10-second setup window. The app keeps that scan only in memory for up to 30 seconds, clears it on cancel, disconnect or backgrounding, and sends one lock command only after the firmware reports an active setup window.
- Release requires one scan of the same pass. There is no account, onboarding form or extra confirmation screen.
- Manual token entry supports camera troubleshooting. Real-device mode never saves tokens to local storage or sends them to a server.
- The interface waits for a newer sensor-confirmed status before reporting success. Disconnects and a missing confirmation invalidate the connection; commands never retry automatically.

Printable synthetic passes are included in `public/` and linked from the app. `npm run passes` regenerates both QR SVGs and their printable page.

```sh
npm test
npm run build
```

Optional browser verification:

```sh
npx playwright install chromium
# With npm run dev already running in another terminal:
npm run test:browser
```

The browser test uses a fake BLE peripheral and real QR decoding against generated video frames. Set `APP_URL` for a preview server other than `http://127.0.0.1:5173`. Actual phone permissions, radio connectivity and physical movements require device testing.

The wire contract is in [`../docs/protocol.md`](../docs/protocol.md); firmware is a separate project in [`../firmware/`](../firmware/).
