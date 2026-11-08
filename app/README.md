# Browser app and shared UI

For an installed phone app, use [mobile/](../mobile/README.md). This folder provides its shared interface and the browser previews. In a browser, use Android Chrome for the physical tag. The app accepts the included demo QR passes only; NFC is not needed.

## Start

Requires Node.js 22.16+. From the repository root:

```sh
cd app
npm ci
npm run dev
```

The printed localhost URL is for the computer running the server. For a phone, run `npm run build` and serve `app/dist/` over **HTTPS trusted by that phone**. A plain HTTP LAN address does not enable Bluetooth/camera access. [Browser requirements](https://developer.chrome.com/docs/capabilities/bluetooth).

## Lock and release

The tag opens on startup. Position is assumed from timing; D32/D33 and the setup hold are not required.

1. Tap **Connect tag** and select `Carry-XXXXXX`. Wait for startup opening.
2. Insert the cable, tap **Scan to lock**, and scan demo pass A. Wait half a second for **Bag locked**.
3. Tap **Scan to release** and scan A again. Remove the cable after **Bag released**.

Print passes from `/demo-passes.html`, also linked under **Tag options** (···). Pass B checks rejection of a wrong pass. For manual entry, A is `A1B2C3D4E5F60718`; B is `9A8B7C6D5E4F3021`.

**Tag options** contains manual entry, disconnect, **Close for storage**, and **Find tag**. A 3-second physical hold opens a stored tag or requests recovery.

## Reconnecting

After the first connection, the app remembers the selected Bluetooth device and automatically retries that exact device after signal loss. Keep the page visible and the tag powered on. Reconnection reads the current state; it never repeats a scan or movement command.

Only the browser’s device ID, display name and reconnect preference are saved on this phone. Boarding-pass tokens remain private. **Disconnect** or **Stop reconnecting** stops retries; **Forget saved tag** removes the saved selection so you can choose another.

After a page reload, restoration uses `getDevices()` when the browser supports it and permission remains. Otherwise, tap **Reconnect tag** and select it again. [Browser API support](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md).

## Find the tag

After connecting, tap **Find tag**. Wait a few seconds, then walk slowly and follow **Getting stronger**. The app smooths the tag’s Bluetooth signal readings; bands indicate link strength, not meters or a direction. Signal search itself needs no extra hardware.

Upload the latest firmware to enable readings. Closing the finder stops polling; readings older than 5 seconds are cleared. The finder resumes with fresh readings after reconnection. There is no tracking beyond Bluetooth range or while the page is in the background. Signal behavior still needs testing on your phone and board.

## Wi-Fi location estimates

While connected, open **Find tag → Estimate location**. The tag scans nearby Wi-Fi networks, sends their BSSIDs/signal readings over BLE, and the phone uses its internet connection to look them up. The tag never joins a Wi-Fi network. Updates are manual, at least 10 seconds apart; disconnecting, closing the finder or backgrounding the app discards pending results. Estimates show the provider's accuracy radius and an external Maps link, not an exact bag position.

The installed [Android app](../mobile/README.md#remember-and-find) supports direct native lookup without a relay or USB cable. Browser/iOS estimates use a relay with a [Google Geolocation API project/key](https://developers.google.com/maps/documentation/geolocation/get-api-key). Copy `server/.env.example` to `server/.env.local` and set `GOOGLE_GEOLOCATION_API_KEY` there. This private file is excluded from Git. From `app/`, run:

```sh
npm run location:relay
```

For browser development, copy `.env.example` to `.env` and restart `npm run dev`. Vite forwards `/api/geolocate` to the relay at `127.0.0.1:8787`. For the installed app, see [mobile configuration](../mobile/README.md#remember-and-find).

The relay is a local prototype service: it binds only to loopback, limits updates and disables IP-based fallback, so it cannot accidentally locate the relay/phone instead of the tag. For remote use, integrate its handler into an authenticated HTTPS backend with the appropriate allowed app origins. No backend is deployed by these commands. Without service configuration, Bluetooth search and lock/release still work.

Wi-Fi access-point addresses and signal readings go to the configured service; SSIDs, pass tokens and Wi-Fi passwords do not. Estimates depend on mapped access points and need physical airport testing. Both browser simulators use synthetic readings and a labelled demo estimate; they never send those demo readings to Google.

## Preview and checks

From `app/`, use `npm run emulator` for the phone preview or `npm run simulate` for the [C++ firmware workbench](../firmware/simulation/README.md). In the emulator, scan a pass in the phone, then click **Setup button**.

Run `npm test` and `npm run build` for software checks. For browser checks, install Chromium with `npx playwright install chromium`, keep the dev server running, and run `npm run test:browser`, `npm run test:emulator` or `npm run test:simulation`. Set `APP_URL` if the server uses a different origin from `http://127.0.0.1:5173`.
