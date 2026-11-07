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

1. Start with the tag open and its open endpoint active. Tap **Connect tag** and select `Carry-XXXXXX`.
2. Insert the cable, tap **Scan to lock**, and scan demo pass A.
3. When prompted, hold the tag button for ½ second and release before 3 seconds. Wait for **Bag locked**.
4. Tap **Scan to release** and scan A again. Remove the cable after **Bag released**.

Print passes from `/demo-passes.html`, also linked under **Tag options** (···). Pass B checks rejection of a wrong pass. For manual entry, A is `A1B2C3D4E5F60718`; B is `9A8B7C6D5E4F3021`.

**Tag options** contains manual entry, disconnect, **Close for storage**, and **Find tag**. A 3-second physical hold opens a stored tag or requests recovery.

## Reconnecting

After the first connection, the app remembers the selected Bluetooth device and automatically retries that exact device after signal loss. Keep the page visible and the tag powered on. Reconnection reads the current state; it never repeats a scan or movement command.

Only the browser’s device ID, display name and reconnect preference are saved on this phone. Boarding-pass tokens remain private. **Disconnect** or **Stop reconnecting** stops retries; **Forget saved tag** removes the saved selection so you can choose another.

After a page reload, restoration uses `getDevices()` when the browser supports it and permission remains. Otherwise, tap **Reconnect tag** and select it again. [Browser API support](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md).

## Find the tag

After connecting, tap **Find tag**. Wait a few seconds, then walk slowly and follow **Getting stronger**. The app smooths the tag’s Bluetooth signal readings; bands indicate link strength, not meters or a direction. **Flash light** confirms the tag visually if an external LED is fitted. Signal search itself needs no extra hardware.

Upload the latest firmware to enable readings. Closing the finder stops polling; readings older than 5 seconds are cleared. The finder resumes with fresh readings after reconnection. There is no tracking beyond Bluetooth range or while the page is in the background. Signal behavior still needs testing on your phone and board.

## Preview and checks

From `app/`, use `npm run emulator` for the phone preview or `npm run simulate` for the [C++ firmware workbench](../firmware/simulation/README.md). In the emulator, scan a pass in the phone, then click **Setup button**.

Run `npm test` and `npm run build` for software checks. For browser checks, install Chromium with `npx playwright install chromium`, keep the dev server running, and run `npm run test:browser`, `npm run test:emulator` or `npm run test:simulation`. Set `APP_URL` if the server uses a different origin from `http://127.0.0.1:5173`.
