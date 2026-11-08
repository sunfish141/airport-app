import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { NativeBluetooth } from './bluetooth.js';
import { createTagStorage, TAG_KEY } from './preferences.js';
import { createLocationClient } from '../../app/src/tag-location.js';
import { createNativeLocationClient } from './location.js';
import './style.css';

async function start() {
  if (!Capacitor.isNativePlatform()) throw new Error('Install Carry on Android or iOS. For a browser preview, run npm run emulator in app/.');
  const storage = await createTagStorage(Preferences, () => {
    const notice = document.getElementById('notice');
    notice.hidden = false;
    notice.classList.add('error');
    notice.textContent = 'Could not save your tag on this phone. Check app storage before closing Carry.';
  });
  const platform = {
    storage,
    locate: Capacitor.getPlatform() === 'android'
      ? createNativeLocationClient(registerPlugin('CarryLocation'))
      : createLocationClient(import.meta.env.VITE_CARRY_LOCATION_ENDPOINT, {
      fetchImpl: async (url, options) => {
        // Native HTTP permits the optional USB loopback relay without WebView
        // mixed-content/CORS workarounds. HTTPS uses cancellable normal fetch.
        if (!url.startsWith('http://')) return fetch(url, options);
        options.signal?.throwIfAborted();
        const result = await CapacitorHttp.post({ url, headers: options.headers, data: JSON.parse(options.body), connectTimeout: 8000, readTimeout: 8000 });
        return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.data };
      },
    }),
    bluetooth: new NativeBluetooth(BleClient, () => {
      try { return JSON.parse(storage.getItem(TAG_KEY)); } catch { return null; }
    }),
    active: (await App.getState()).isActive,
    scanning: false,
    visibilityListeners: new Set(),
    onVisibility(callback) { this.visibilityListeners.add(callback); },
    onBack(callback) { this.back = callback; },
    async scan() {
      this.scanning = true;
      try {
        const result = await CapacitorBarcodeScanner.scanBarcode({
          hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
          scanInstructions: 'Scan your demo pass',
          cameraDirection: 1,
          android: { scanningLibrary: 'zxing' },
        });
        this.active = (await App.getState()).isActive;
        return result.ScanResult;
      } catch (error) {
        if (/cancel/i.test(error.message)) return null;
        throw error;
      } finally { this.scanning = false; }
    },
  };
  await App.addListener('appStateChange', ({ isActive }) => {
    platform.active = isActive;
    platform.visibilityListeners.forEach((callback) => callback());
    if (!isActive) void storage.flush();
  });
  if (Capacitor.getPlatform() === 'android') {
    await App.addListener('backButton', () => {
      if (!platform.back?.()) void App.minimizeApp();
    });
  }
  globalThis.carryPlatform = platform;
  document.body.dataset.native = 'true';
  // The emulator build runs the same compiled Controller.cpp as the browser
  // workbench. A production build always starts with the physical BLE tag.
  if (import.meta.env.VITE_CARRY_DEMO === 'firmware') {
    history.replaceState(null, '', `${location.pathname}?demo=firmware`);
  }
  await import('../../app/src/main.js');
}
start().catch((error) => {
  document.getElementById('state-label').textContent = 'Could not start Carry';
  document.getElementById('state-detail').textContent = error.message;
  document.getElementById('connect').hidden = true;
});
