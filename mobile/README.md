# Carry mobile app

Installable Android/iOS app using Capacitor, native Bluetooth LE, native QR scanning and phone preferences. It shares the interface and tag protocol in `app/src/`; firmware stays in `firmware/`. No hosted website or HTTPS server is needed on the phone.

## Install on a phone

Requires Node.js 22.16+. Install both projects' dependencies from the repository root:

```sh
npm ci --prefix app
npm ci --prefix mobile
cd mobile
```

**Android:** install Android Studio with SDK 36, build tools and JDK 21. Connect an Android 8+ phone with USB debugging enabled, then run:

```sh
npm run android
```

The release installed over USB keeps its signing key in `android/.signing/`, excluded from Git. Keep a private backup of this folder and reuse that key when signing updates. The development build above uses a different signing key.

**iPhone:** use a Mac with Xcode 26+ and an iOS 15+ phone. Run `npm run sync`, then `npm run open:ios`. Select your signing team and phone in Xcode and run the app. After signing is configured, `npm run ios` also builds and launches it. [Native environment setup](https://capacitorjs.com/docs/getting-started/environment-setup).

Allow Bluetooth and camera access when asked. Android also requests location access because the finder uses Bluetooth proximity. Tap **Connect tag**, select `Carry-XXXXXX`, wait for startup opening and scan demo pass A. Timed-demo firmware sweeps closed for half a second; scan A again to open. It needs no setup hold or D32/D33 contacts and clears its assignment on every restart. The app labels position as unverified. [Demo passes and usage](../app/README.md#lock-and-release).

## Remember and find

The app saves the last connected tag's platform ID, name and reconnect preference in native phone storage. It restores that exact device on launch and retries after signal loss while the app is in the foreground. Pass tokens are never saved or advertised. **Disconnect** stops retries; **Forget saved tag** clears the saved device.

**Find tag** uses the firmware's signal readings for stronger/weaker guidance. **Estimate location** optionally uses Wi-Fi networks scanned by the tag, with the phone handling the internet lookup. It shows the reported accuracy radius and a link to the estimated area in Maps. There is no compass direction or tracking outside Bluetooth range. Searching and reconnection pause in the background.

**Android prototype:** location lookup runs natively over the phone's Wi-Fi or mobile data. It needs no USB cable, computer or relay after setup. The tag still supplies the Wi-Fi readings over Bluetooth; the phone's own position and IP are never substituted.

To configure one phone, save its Google Geolocation API key in `app/server/.env.local` (excluded from Git), install/open the Android app, then run from the repository root with the phone connected:

```sh
python3 tools/provision-android-location.py --serial YOUR_ADB_SERIAL
```

Requires ADB and OpenSSL. The script encrypts the key with this phone's public key before transferring it. Android Keystore protects the private key; only encrypted credentials are saved, and neither the APK nor JavaScript contains the Google key. Reinstalling after uninstalling or clearing app data requires setup again; ordinary signed updates retain it. Restrict the Google key to Geolocation API and this Android app (`com.carry.tag` and its signing certificate SHA-1), and set a small daily quota. This per-phone setup is for the private prototype; a distributed product should use an authenticated HTTPS backend. [Google's mobile key guidance](https://developers.google.com/maps/api-security-best-practices#secure-client-side-web-service-calls).

**iPhone:** configure an authenticated HTTPS [location relay](../app/README.md#wi-fi-location-estimates), set `VITE_CARRY_LOCATION_ENDPOINT` in `mobile/.env.local` and rebuild. The endpoint must permit the app's `capacitor://localhost` origin. Never put a Google key in a `VITE_` variable.

## Emulator without a tag

Create and start an Android Virtual Device in Android Studio, then:

```sh
npm run emulator:android
```

On a Mac, `npm run emulator:ios` launches the equivalent build in an iOS simulator. Select the emulator when the CLI lists targets. This build uses the compiled **real C++ controller** with simulated hardware. Connect, scan demo pass A, then open **Tag options → Press for setup**. Scan A again to release. Use the [browser workbench](../firmware/simulation/README.md) for wiring and fault controls.

Emulators exercise the UI and controller; use a physical phone and tag to test native BLE, permissions, camera and reconnection. The regular `npm run android` / `npm run ios` commands rebuild for the physical tag, replacing the demo build.

In **Find tag → Estimate location**, emulator builds return a clearly labelled synthetic location and 80 m radius without calling an external service. Wi-Fi radio scanning is simulated in JavaScript; the C++ controller still handles locking and release.

## Checks and code

```sh
npm test
npm run build
npm run build:demo
npm run sync
```

`src/main.js` starts native plugins before loading the shared UI. `src/bluetooth.js` adapts native GATT calls to the tested `TagConnection` interface. `src/preferences.js` restores the saved device and orders storage writes. `android/` and `ios/` contain the native projects; `npm run sync` rebuilds their bundled assets after shared UI changes.

For the bundled JavaScript integration check, run `npm run build`, keep `npm run preview` running, then run `npm run test:browser` in another terminal. It uses Playwright from `app/` with mocked Capacitor plugins; it does not validate OS drivers. Install its Chromium first with `npx --prefix ../app playwright install chromium` if needed.
