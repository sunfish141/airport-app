import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = process.env.APP_URL || 'http://127.0.0.1:5173';
const artifacts = await mkdtemp(join(tmpdir(), 'carry-browser-'));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.addInitScript(() => {
    const characteristic = new EventTarget();
    const values = { sequence: 1, state: 0, error: 0, flags: 2, setupMs: 0, command: '-' };
    let assignedToken = '';
    const writes = [];
    function packet() {
      const data = new Uint8Array(12);
      data.set([1, values.state, values.error, values.flags]);
      const view = new DataView(data.buffer);
      view.setUint16(4, values.setupMs, true);
      view.setUint32(6, values.sequence, true);
      data[10] = values.command.charCodeAt(0);
      return view;
    }
    function emit(patch) {
      Object.assign(values, patch); ++values.sequence;
      characteristic.value = packet();
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    }
    characteristic.startNotifications = async () => characteristic;
    characteristic.readValue = async () => packet();
    const device = new EventTarget(); device.name = 'Carry-A1B2C3';
    const command = {
      async writeValueWithResponse(bytes) {
        const text = new TextDecoder().decode(bytes); writes.push(text);
        const opcode = text[0];
        if (opcode === 'F') { emit({ command: opcode, error: 0 }); return; }
        if (opcode === 'U' && text.slice(1) !== assignedToken) { emit({ error: 8, command: opcode }); return; }
        if (opcode === 'L') assignedToken = text.slice(1);
        const flags = opcode === 'C' ? 2 : opcode === 'L' ? 3 : 5;
        emit({ state: 3, error: 0, flags, command: opcode, setupMs: 0 });
        setTimeout(() => {
          if (opcode === 'U') assignedToken = '';
          emit({ state: opcode === 'L' ? 2 : opcode === 'C' ? 1 : 0, flags: opcode === 'L' ? 5 : opcode === 'C' ? 4 : 2, error: 0, command: opcode });
        }, 120);
      },
    };
    device.gatt = {
      connected: false,
      async connect() { this.connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async (uuid) => uuid.startsWith('7db10003') ? characteristic : command }) }; },
      disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
    };
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device } });
    window.tagTest = {
      writes, pass: 1, cameraStops: 0,
      setup: () => emit({ setupMs: 10000, command: '-', error: 0 }),
      expireSetup: () => emit({ setupMs: 0, command: '-', error: 0 }),
      service: () => { assignedToken = ''; emit({ state: 0, flags: 2, error: 0, command: 'S' }); },
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 640;
      const image = new Image(); image.src = `/demo-pass-${window.tagTest.pass}.svg`;
      await image.decode();
      const draw = () => { const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 640, 640); context.drawImage(image, 64, 64, 512, 512); };
      draw();
      const stream = canvas.captureStream(15);
      const timer = setInterval(draw, 80);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); ++window.tagTest.cameraStops; stop(); };
      return stream;
    };
  });
  await page.goto(`${baseURL}/`, { waitUntil: 'networkidle' });
  const state = (text) => page.locator('#state-label').getByText(text, { exact: true }).waitFor();
  const options = () => page.locator('#options').click();
  const manual = async (token, opcode) => {
    await options();
    await page.locator('#manual-entry').evaluate((element) => { element.open = true; });
    await page.locator('#token').fill(token);
    await page.locator(opcode === 'L' ? '#manual-lock' : '#manual-unlock').click();
  };
  await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
  assert.ok((await page.locator('body').innerText()).split(/\s+/).length < 40);
  assert.equal(await page.locator('.primary-actions button:visible').count(), 1);
  const connectBox = await page.locator('#connect').boundingBox();
  assert.ok(connectBox.y + connectBox.height <= 844);
  const started = Date.now();
  await page.locator('#connect').click();
  await state('Lock your bag');
  await page.locator('#lock').click();
  await state('Press the tag button');
  assert.equal(await page.evaluate(() => window.tagTest.writes.length), 0);
  await page.locator('#cancel-lock').click();
  await page.evaluate(async () => { window.tagTest.setup(); await Promise.resolve(); });
  assert.equal(await page.evaluate(() => window.tagTest.writes.length), 0);
  await page.evaluate(() => window.tagTest.expireSetup());
  await page.locator('#lock').click();
  await state('Press the tag button');
  await page.screenshot({ path: join(artifacts, 'button-step.png'), fullPage: true });
  assert.equal(await page.evaluate(() => window.tagTest.writes.length), 0);
  await page.evaluate(() => window.tagTest.setup());
  await state('Bag locked');
  assert.equal(await page.evaluate(() => window.tagTest.writes[0]), 'LA1B2C3D4E5F60718');
  assert.equal(await page.locator('.primary-actions button:visible').count(), 1);
  assert.equal(await page.locator('#scanner').evaluate(element => element.open), false);
  await page.screenshot({ path: join(artifacts, 'locked.png'), fullPage: true });
  await page.evaluate(() => { window.tagTest.pass = 2; });
  await page.locator('#unlock').click();
  await page.locator('#notice').getByText(/Wrong pass/).waitFor();
  assert.equal(await page.locator('#state-label').textContent(), 'Bag locked');
  await page.evaluate(() => { window.tagTest.pass = 1; });
  await page.locator('#unlock').click();
  await state('Bag released');
  const cycleMs = Date.now() - started;
  assert.ok(cycleMs < 60000, `Connect/lock/release took ${cycleMs} ms`);
  await page.screenshot({ path: join(artifacts, 'released.png'), fullPage: true });
  await options();
  await page.locator('#storage').click();
  await state('Tag stored');
  await page.evaluate(() => { window.tagTest.service(); window.tagTest.setup(); });
  await manual('9a8b7c6d5e4f3021', 'L');
  await state('Bag locked');
  await manual('A1B2C3D4E5F60718', 'U');
  await page.locator('#notice').getByText(/Wrong pass/).waitFor();
  await options();
  await page.locator('#flash').click();
  await page.locator('#notice').getByText('Tag is flashing.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await options();
  await page.locator('#disconnect').click();
  await state('Connect your tag');
  assert.equal(await page.locator('#unlock').isDisabled(), true);
  assert.ok(await page.evaluate(() => window.tagTest.cameraStops >= 4));
  await page.goto(`${baseURL}/demo-passes.html`);
  assert.equal(await page.locator('.pass').count(), 2);
  assert.deepEqual(errors, []);
  console.log(`Browser checks passed: scan-first setup, cancellation, real QR camera decoding, wrong-pass recovery, storage, manual entry and reconnect. Connect/lock/release: ${(cycleMs / 1000).toFixed(1)}s with simulated hardware.`);
  console.log(`Screenshots: ${artifacts}`);
} finally { await browser.close(); }
