import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeLocationClient } from '../src/location.js';

const points = [
  { macAddress: '00:11:22:33:44:50', signalStrength: -55, channel: 1, ssid: 'private' },
  { macAddress: '00:11:22:33:44:60', signalStrength: -64, channel: 6 },
];
const estimate = { location: { lat: 43.6, lng: -79.6 }, accuracy: 80 };

test('native location sends only the tag AP readings; no credential or endpoint crosses the bridge', async () => {
  let received;
  const locate = createNativeLocationClient({ locate: async (value) => { received = value; return estimate; } }, () => 'test-1');
  assert.deepEqual(await locate(points), estimate);
  assert.deepEqual(received, { id: 'test-1', wifiAccessPoints: points.map(({ macAddress, signalStrength, channel }) => ({ macAddress, signalStrength, channel })) });
});

test('closing a lookup cancels the matching native request and ignores its late response', async () => {
  let finish;
  const calls = [];
  const controller = new AbortController();
  const locate = createNativeLocationClient({
    locate: () => new Promise((resolve) => { finish = resolve; }),
    cancel: async (value) => calls.push(value),
  }, () => 'test-2');
  const pending = locate(points, { signal: controller.signal });
  controller.abort(); finish(estimate);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(calls, [{ id: 'test-2' }]);
});

test('invalid native estimates and pre-cancelled requests cannot return a map position', async () => {
  const locate = createNativeLocationClient({ locate: async () => ({ ...estimate, accuracy: 0 }) });
  await assert.rejects(locate(points), /invalid estimate/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(locate(points, { signal: controller.signal }), { name: 'AbortError' });
});
