# Phone app

Independent plain JavaScript/Vite project. Requires Node.js 22.16+.

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

The preview embeds the actual app at selectable Android screen sizes, with rotation and a virtual tag. Click **Connect virtual tag**, then **Start setup**. In the phone, tap **Scan to lock** and choose pass A. Try unlocking with B for a mismatch, then with A for a successful release. The scanner decodes the included QR image without requesting a camera.

The test bench also provides service opening, obstruction/timeouts, reboot and reset. A reboot retains the simulated assignment; a reset clears the virtual tag. Everything stays in memory. `/emulator.html` and the opt-in demo URL `/?demo=1` are included in the static build. The normal `/` app continues to use real Web Bluetooth. This is a browser viewport and tag simulator, not an Android OS emulator; physical Bluetooth, camera permissions and the firmware still require device testing.

With a dev server running, use `npm run test:emulator` to verify the interactive preview in Chromium.

Use Android Chrome over **HTTPS trusted by the phone** for BLE and camera operation. The localhost development exception applies only on the computer running the server; HTTP on a LAN IP is insufficient. Build static hosting files with `npm run build`, then serve `dist/` over HTTPS. See [Chrome Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth).

- **Connect tag** opens the browser's device selector from a click gesture, filters by the firmware service UUID, subscribes to status and reads the current state.
- **Scan to lock/unlock** uses `@zxing/browser` and a rear-facing camera preference. Valid QR content is exactly 16 hexadecimal characters. Tokens normalize to uppercase.
- **Close for storage** closes a confirmed open/unassigned tag. The physical 3-second service button hold reopens it.
- **Find my tag** requests a two-second LED flash.
- Manual token entry supports camera troubleshooting. Tokens are never saved to local storage or sent to a server.
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
