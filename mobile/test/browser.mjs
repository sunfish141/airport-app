// Runs the production bundle with a mocked Capacitor bridge. This verifies JS
// integration, not the OS Bluetooth stack, camera hardware or native build.
import { chromium } from '../../app/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.MOBILE_URL || 'http://127.0.0.1:5179';
const artifacts = await mkdtemp(join(tmpdir(), 'carry-native-'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/geolocate', async (route) => {
    const payload = route.request().postDataJSON();
    assert.equal(payload.wifiAccessPoints.length, 2);
    assert.equal(payload.wifiAccessPoints[0].signalStrength, -55);
    await route.fulfill({ json: { location: { lat: 43.6777, lng: -79.6248 }, accuracy: 80 } });
  });
  await page.addInitScript(() => {
    const service = '7db10001-3a7e-4f5c-9b21-51c61a7e0001';
    const command = service.replace('0001-', '0002-');
    const status = service.replace('0001-', '0003-');
    const signal = service.replace('0001-', '0004-');
    const wifi = service.replace('0001-', '0005-');
    let wifiRequest = 0;
    const listeners = new Map();
    const events = [];
    const values = JSON.parse(localStorage.getItem('mock.tag') || 'null') || { state: 0, flags: 2, sequence: 1, command: '-', token: null, setupMs: 0, error: 0 };
    function hex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
    function packet() {
      const bytes = new Uint8Array(12);
      const view = new DataView(bytes.buffer);
      bytes.set([1, values.state, values.error, values.flags]);
      view.setUint16(4, values.setupMs, true); view.setUint32(6, values.sequence, true);
      bytes[10] = values.command.charCodeAt(0);
      return hex(bytes);
    }
    function emit(patch) {
      Object.assign(values, patch); ++values.sequence;
      localStorage.setItem('mock.tag', JSON.stringify(values));
      listeners.get(`BluetoothLe:notification|tag-A|${service}|${status}`)?.({ value: packet() });
    }
    const mock = window.nativeTest = {
      events, pass: 'A1B2C3D4E5F60718', reads: 0, scans: 0, wifiScans: 0, active: true, rssi: -55,
      setup: () => emit({ setupMs: 10000, command: '-' }),
      drop: () => listeners.get('BluetoothLe:disconnected|tag-A')?.({ deviceId: 'tag-A' }),
      activeState: (active) => { mock.active = active; listeners.get('App:appStateChange')?.({ isActive: active }); },
      back: () => listeners.get('App:backButton')?.({}),
    };
    const methods = {
      App: ['getState', 'minimizeApp'], Preferences: ['get', 'set', 'remove'],
      BluetoothLe: ['initialize', 'isEnabled', 'requestDevice', 'getDevices', 'connect', 'disconnect', 'getServices', 'read', 'write', 'startNotifications'],
      CapacitorBarcodeScanner: ['scanBarcode'],
    };
    window.androidBridge = {};
    window.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, names]) => ({ name, methods: [
        ...names.map((name) => ({ name, rtype: 'promise' })),
        { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' },
      ] })),
      nativeCallback(plugin, method, options, callback) {
        listeners.set(`${plugin}:${options.eventName}`, callback);
        return options.eventName;
      },
      async nativePromise(plugin, method, options = {}) {
        if (method === 'removeListener') { listeners.delete(`${plugin}:${options.eventName}`); return {}; }
        if (plugin === 'Preferences') {
          const key = 'mock.preferences.' + options.key;
          if (method === 'get') return { value: localStorage.getItem(key) };
          if (method === 'set') localStorage.setItem(key, options.value);
          if (method === 'remove') localStorage.removeItem(key);
          return {};
        }
        if (plugin === 'App') return method === 'getState' ? { isActive: mock.active } : {};
        if (plugin === 'CapacitorBarcodeScanner') {
          ++mock.scans;
          assertQr(options.hint === 0);
          // Native Android camera Activity pauses and resumes the app.
          mock.activeState(false);
          await new Promise((resolve) => setTimeout(resolve, 50));
          mock.activeState(true);
          return { ScanResult: mock.pass, format: 0 };
        }
        if (plugin !== 'BluetoothLe') throw new Error('Unexpected native plugin ' + plugin);
        if (method === 'initialize') {
          if (!localStorage.getItem('mock.bluetooth.permission')) {
            mock.activeState(false);
            await new Promise((resolve) => setTimeout(resolve, 50));
            localStorage.setItem('mock.bluetooth.permission', 'granted');
            mock.activeState(true);
          }
          return {};
        }
        if (method === 'disconnect' || method === 'startNotifications') return {};
        if (method === 'isEnabled') return { value: true };
        if (method === 'requestDevice') { events.push(['choose', options]); return { deviceId: 'tag-A', name: 'Carry-NATIVE' }; }
        if (method === 'getDevices') { events.push(['restore', options.deviceIds]); return { devices: [{ deviceId: 'other-tag', name: 'Carry-NATIVE' }, { deviceId: 'tag-A' }] }; }
        if (method === 'connect') { events.push(['connect', options.deviceId]); if (options.deviceId !== 'tag-A') throw new Error('Wrong tag'); return {}; }
        if (method === 'getServices') return { services: [{ uuid: service, characteristics: [command, status, signal, wifi].map((uuid) => ({ uuid })) }] };
        if (method === 'read') {
          if (options.characteristic === wifi) return { value: hex(Uint8Array.of(1, 2, wifiRequest & 255, wifiRequest >> 8, 2, 0,
            0, 17, 34, 51, 68, 80, 201, 1, 0, 17, 34, 51, 68, 96, 192, 6)) };
          if (options.characteristic === signal) { ++mock.reads; return { value: hex(Uint8Array.of(1, 1, mock.rssi & 255, 0)) }; }
          return { value: packet() };
        }
        if (method === 'write') {
          if (options.characteristic === wifi) {
            const bytes = options.value.match(/../g).map((byte) => parseInt(byte, 16));
            assertQr(bytes.length === 3 && bytes[0] === 1);
            wifiRequest = bytes[1] | bytes[2] << 8;
            ++mock.wifiScans;
            return {};
          }
          const text = String.fromCharCode(...options.value.match(/../g).map((byte) => parseInt(byte, 16)));
          events.push(['write', text]);
          const opcode = text[0];
          if (opcode === 'F') { emit({ command: opcode, error: 0 }); return {}; }
          if (opcode === 'U' && text.slice(1) !== values.token) { emit({ command: opcode, error: 8 }); return {}; }
          if (opcode === 'L') values.token = text.slice(1);
          emit({ state: 3, flags: opcode === 'L' ? 3 : 5, command: opcode, setupMs: 0, error: 0 });
          setTimeout(() => {
            if (opcode === 'U') values.token = null;
            emit({ state: opcode === 'L' ? 2 : 0, flags: opcode === 'L' ? 5 : 2 });
          }, 80);
          return {};
        }
        throw new Error('Unexpected native method ' + method);
      },
    };
    function assertQr(value) { if (!value) throw new Error('Scanner must request a QR pass'); }
    Object.defineProperty(navigator, 'bluetooth', { value: undefined });
  });
  const state = (text) => page.getByRole('heading', { name: text, exact: true }).waitFor();
  await page.goto(url);
  await state('Connect your tag');
  await page.locator('#connect').click();
  await state('Lock your bag');
  await page.locator('#lock').click();
  await state('Press the tag button');
  await page.evaluate(() => nativeTest.setup());
  await state('Bag locked');
  assert.equal(await page.evaluate(() => nativeTest.scans), 1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mock.preferences.carry.remembered-tag.v1')));
  assert.deepEqual(saved, { id: 'tag-A', name: 'Carry-NATIVE', auto: true });
  await page.reload();
  await state('Bag locked');
  assert.deepEqual(await page.evaluate(() => nativeTest.events), [['restore', ['tag-A']], ['connect', 'tag-A']]);
  await page.evaluate(() => nativeTest.drop());
  await state('Reconnecting to your tag');
  await state('Bag locked');
  await page.locator('#find').click();
  await page.locator('#signal-label').getByText('Strong signal', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => nativeTest.wifiScans), 0);
  await page.locator('#location-update').click();
  const configured = await page.evaluate(() => Boolean(carryPlatform.locate));
  await page.locator('#location-status').getByText(configured ? /Accuracy radius: 80 m/ : /Location lookup is unavailable/).waitFor();
  assert.equal(await page.evaluate(() => nativeTest.wifiScans), configured ? 1 : 0);
  const before = await page.evaluate(() => nativeTest.reads);
  await page.evaluate(() => nativeTest.activeState(false));
  assert.equal(await page.locator('#location-map').isVisible(), false);
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => nativeTest.reads), before);
  await page.evaluate(() => nativeTest.activeState(true));
  await page.locator('#signal-label').getByText('Strong signal', { exact: true }).waitFor();
  await page.evaluate(() => nativeTest.back());
  assert.equal(await page.locator('#finder').evaluate((dialog) => dialog.open), false);
  await page.evaluate(() => { nativeTest.pass = '9A8B7C6D5E4F3021'; });
  await page.locator('#unlock').click();
  await page.locator('#notice').getByText('Wrong pass. Scan the pass used to lock this tag.', { exact: true }).waitFor();
  await state('Bag locked');
  await page.evaluate(() => { nativeTest.pass = 'A1B2C3D4E5F60718'; });
  await page.locator('#unlock').click();
  await state('Bag released');
  await page.screenshot({ path: join(artifacts, 'released.png') });
  await page.locator('#options').click();
  await page.locator('#forget-tag').click();
  await state('Connect your tag');
  await page.reload(); await state('Connect your tag');
  assert.deepEqual(await page.evaluate(() => nativeTest.events), []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(`Native bundle bridge checks passed. Screenshot: ${artifacts}`);
} finally { await browser.close(); }
