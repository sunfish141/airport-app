import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TagConnection } from '../src/bluetooth.js';
import { SimulatedTag } from '../src/simulated-tag.js';
import { TagLocation, createLocationClient } from '../src/tag-location.js';
import { decodeWifiScan, usableAccessPoints, validateLocation } from '../src/location-protocol.js';
import { locationHandler } from '../server/location-relay.js';

const points = [
  { macAddress: '10:11:22:33:44:50', signalStrength: -55, channel: 1 },
  { macAddress: '10:11:22:33:44:60', signalStrength: -64, channel: 6 },
];
const estimate = { location: { lat: 43.6777, lng: -79.6248 }, accuracy: 80 };
const flush = () => new Promise(setImmediate);
async function fixture(t) {
  const tag = new SimulatedTag();
  const connection = new TagConnection({ bluetooth: tag.bluetooth, requireSecureContext: false });
  const write = tag.wifi.writeValueWithResponse.bind(tag.wifi);
  tag.wifi.writeValueWithResponse = async (value) => { await write(value); tag.wifi.started = -Infinity; };
  t.after(() => { connection.disconnect(); tag.dispose(); });
  await connection.connect();
  return { tag, connection };
}

test('Wi-Fi packets round-trip signed RSSI, request ID and only usable access points', async (t) => {
  const { tag, connection } = await fixture(t);
  const result = await connection.scanWifi();
  assert.equal(result.length, 2);
  assert.equal(result[0].signalStrength, -55);
  assert.equal(connection.status.state, 'OPEN_FREE');
  const packet = await tag.wifi.readValue();
  assert.equal(decodeWifiScan(packet).request, tag.wifi.request);
  const malformed = new Uint8Array(packet.buffer.slice(0)); malformed[4] = 13;
  assert.throws(() => decodeWifiScan(malformed), /Invalid/);
  malformed[4] = 2; malformed[5] = 1;
  assert.throws(() => decodeWifiScan(malformed), /Unsupported/);
});

test('AP filtering removes local, multicast, IANA and zero MACs and deduplicates strongest', () => {
  const filtered = usableAccessPoints([
    ...points, { ...points[0], signalStrength: -30 },
    ...['12:11:22:33:44:50', '11:11:22:33:44:50', '00:00:5e:33:44:50', '00:00:00:00:00:00']
      .map((macAddress) => ({ ...points[0], macAddress })),
  ]);
  assert.equal(filtered.length, 2); assert.equal(filtered[0].signalStrength, -30);
  assert.throws(() => usableAccessPoints([{ ...points[0], signalStrength: NaN }]), /Invalid/);
  assert.throws(() => validateLocation({ ...estimate, accuracy: 0 }), /invalid/);
  assert.throws(() => validateLocation({ location: { lat: '43', lng: -79 }, accuracy: 80 }), /invalid/);
});

test('Wi-Fi scans require connection, reject overlaps and cannot be completed by stale request IDs', async (t) => {
  const { tag, connection } = await fixture(t);
  const read = tag.wifi.readValue.bind(tag.wifi);
  let reads = 0;
  tag.wifi.readValue = async () => {
    const packet = await read();
    if (++reads === 1) packet.setUint16(2, (tag.wifi.request - 1) & 65535, true);
    return packet;
  };
  const pending = connection.scanWifi();
  await assert.rejects(connection.scanWifi(), /already running/);
  assert.equal((await pending).length, 2); assert.equal(reads, 2);
  connection.disconnect();
  await assert.rejects(connection.scanWifi(), /Connect/);
});

test('cancelling a scan before the queued write sends no radio request', async (t) => {
  const { tag, connection } = await fixture(t);
  const abort = new AbortController();
  const pending = connection.scanWifi({ signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(tag.wifi.state, 0);
  assert.equal(connection.connected, true);
});

test('location lookup uses tag readings and clears a late network result after disconnect', async (t) => {
  const { connection } = await fixture(t);
  let finish;
  let located;
  const location = new TagLocation(connection, { locate: async (aps) => { located = aps; return new Promise((resolve) => { finish = resolve; }); } });
  const pending = location.refresh();
  await flush();
  assert.equal(location.state, 'locating');
  assert.equal(located.length, 2);
  connection.disconnect(); location.clear();
  finish(estimate); await pending;
  assert.equal(location.result, null); assert.equal(location.state, 'idle');
});

test('location lookup needs a configured service and at least two APs', async (t) => {
  const { tag, connection } = await fixture(t);
  let scans = 0;
  const scan = connection.scanWifi.bind(connection);
  connection.scanWifi = (...args) => { ++scans; return scan(...args); };
  const missing = new TagLocation(connection);
  await missing.refresh(); assert.equal(scans, 0); assert.match(missing.message, /unavailable/);
  tag.wifi.points = false;
  let requests = 0;
  const location = new TagLocation(connection, { locate: async () => { ++requests; return estimate; } });
  await location.refresh();
  assert.equal(location.state, 'error'); assert.match(location.message, /Not enough/); assert.equal(requests, 0);
});

test('a successful estimate records time and closing/backgrounding discards it', async (t) => {
  const { connection } = await fixture(t);
  const location = new TagLocation(connection, { locate: async () => estimate, now: () => 1234 });
  await location.refresh();
  assert.deepEqual(location.result, { ...estimate, at: 1234 });
  location.clear(); assert.equal(location.result, null);
});

test('an older tag can still flash after its unsupported Wi-Fi scan is rejected', async (t) => {
  const { connection, tag } = await fixture(t);
  const get = connection.service.getCharacteristic;
  connection.service.getCharacteristic = async (uuid) => {
    if (uuid.includes('7db10005')) throw new DOMException('Missing Wi-Fi characteristic', 'NotFoundError');
    return get(uuid);
  };
  await assert.rejects(connection.scanWifi(), /Update tag firmware/);
  await connection.send('F');
  assert.equal(tag.flashing, true);
  assert.equal(connection.connected, true);
});

test('a stalled location provider times out without dropping the Bluetooth connection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const connection = { connected: true, session: 1, scanWifi: async () => points };
  const location = new TagLocation(connection, { locate: () => new Promise(() => {}) });
  const pending = location.refresh();
  await flush(); t.mock.timers.tick(10000); await pending;
  assert.equal(location.state, 'error');
  assert.match(location.message, /timed out/);
  assert.equal(connection.connected, true);
});

test('a Wi-Fi read from an old BLE session cannot return data after reconnection', async (t) => {
  const { connection, tag } = await fixture(t);
  const read = tag.wifi.readValue.bind(tag.wifi);
  let finish;
  tag.wifi.readValue = async () => {
    const packet = await read();
    return new Promise((resolve) => { finish = () => resolve(packet); });
  };
  const pending = connection.scanWifi();
  const rejected = assert.rejects(pending, /disconnected/i);
  await flush();
  connection.disconnect(); await connection.connect();
  finish(); await rejected;
  assert.equal(connection.connected, true);
  assert.equal(connection.status.state, 'OPEN_FREE');
});

test('location client sends only tag APs, honors cancellation and rejects insecure remote endpoints', async () => {
  let request;
  const locate = createLocationClient('https://example.test/geolocate', { fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => estimate };
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await locate(points, { signal }), estimate);
  assert.deepEqual(JSON.parse(request.options.body), { wifiAccessPoints: points });
  assert.equal(request.options.signal, signal);
  assert.throws(() => createLocationClient('http://example.test/geolocate'), /HTTPS/);
});

async function relay(handler, payload, { method = 'POST' } = {}) {
  const request = {
    url: '/geolocate', method, headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)); },
  };
  const response = new EventEmitter();
  response.headers = {};
  response.setHeader = (key, value) => { response.headers[key] = value; };
  response.writeHead = (status) => { response.status = status; };
  response.end = (body) => { response.body = JSON.parse(body); response.writableEnded = true; };
  await handler(request, response);
  return response;
}

test('relay keeps the key server-side, disables IP fallback and limits repeat provider calls', async () => {
  let request;
  const handler = locationHandler({ apiKey: 'test-key', now: () => 0, fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => ({ ...estimate, ignored: 'private provider data' }) };
  } });
  const response = await relay(handler, { wifiAccessPoints: points });
  assert.equal(response.status, 200); assert.deepEqual(response.body, estimate);
  assert.deepEqual(JSON.parse(request.options.body), { considerIp: false, wifiAccessPoints: points });
  assert.match(request.url, /key=test-key$/);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal((await relay(handler, { wifiAccessPoints: points })).status, 429);
});

test('relay fails closed for missing configuration, malformed input, insufficient APs and provider failure', async () => {
  let calls = 0;
  const handler = locationHandler({ apiKey: 'test', fetchImpl: async () => { ++calls; return { ok: false, status: 404 }; } });
  assert.equal((await relay(locationHandler(), { wifiAccessPoints: points })).status, 503);
  assert.equal((await relay(handler, { wifiAccessPoints: [points[0]] })).status, 400);
  assert.equal((await relay(handler, { wifiAccessPoints: points, token: 'must not be forwarded' })).status, 400);
  assert.equal((await relay(handler, 'x'.repeat(4097))).status, 413);
  assert.equal(calls, 0);
  assert.equal((await relay(handler, { wifiAccessPoints: points })).status, 404);
});
