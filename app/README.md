# Phone app

Use Android Chrome for the physical Bluetooth tag. The app accepts the included demo QR passes only; NFC is not needed.

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

**Tag options** contains manual entry, disconnect, **Close for storage**, and **Find tag** (requires an external LED). A 3-second physical hold opens a stored tag or requests recovery. After losing a connection, reconnect to read the actual state.

## Preview and checks

From `app/`, use `npm run emulator` for the phone preview or `npm run simulate` for the [C++ firmware workbench](../firmware/simulation/README.md). In the emulator, scan a pass in the phone, then click **Setup button**.

Run `npm test` and `npm run build` for software checks. For browser checks, install Chromium with `npx playwright install chromium`, keep the dev server running, and run `npm run test:browser`, `npm run test:emulator` or `npm run test:simulation`. Set `APP_URL` if the server uses a different origin from `http://127.0.0.1:5173`.
