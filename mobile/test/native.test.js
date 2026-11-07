import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeBluetooth } from '../src/bluetooth.js';
import { createTagStorage, TAG_KEY } from '../src/preferences.js';
import { TagConnection } from '../../app/src/bluetooth.js';
import { TagReconnect } from '../../app/src/tag-reconnect.js';
import { SimulatedTag } from '../../app/src/simulated-tag.js';
import { UUIDS, DEMO_TOKENS } from '../../app/src/protocol.js';

const flush = () => new Promise(setImmediate);
function fixture(t) {
  const tag = new SimulatedTag({ movementMs: 1 });
  const calls = [];
  let dropped;
  let notify;
  tag.statusCharacteristic.addEventListener('characteristicvaluechanged', () => notify?.(tag.packet()));
  const client = {
    initialize: async () => {},
    isEnabled: async () => true,
    requestDevice: async (options) => { calls.push(['choose', options]); return { deviceId: 'tag-A', name: 'Carry-123456' }; },
    getDevices: async (ids) => { calls.push(['restore', ids]); return [{ deviceId: 'tag-B', name: 'Carry-123456' }, { deviceId: ids[0] }]; },
    connect: async (id, onDisconnect) => { calls.push(['connect', id]); dropped = onDisconnect; tag.device.gatt.connected = true; },
    disconnect: async () => { tag.device.gatt.connected = false; },
    getServices: async () => [{ uuid: UUIDS.service.toUpperCase(), characteristics: Object.values(UUIDS).slice(1).map((uuid) => ({ uuid })) }],
    read: async (id, service, characteristic) => characteristic === UUIDS.wifi ? tag.wifi.readValue() : characteristic === UUIDS.signal ? tag.signal.packet() : tag.packet(),
    write: async (id, service, characteristic, value) => {
      assert.equal(id, 'tag-A'); assert.equal(service, UUIDS.service);
      assert.ok(value instanceof DataView);
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      if (characteristic === UUIDS.wifi) {
        calls.push(['wifi-scan']);
        await tag.wifi.writeValueWithResponse(bytes); tag.wifi.started = -Infinity;
        return;
      }
      assert.equal(characteristic, UUIDS.command);
      calls.push(['write', new TextDecoder().decode(bytes)]);
      tag.receive(bytes);
    },
    startNotifications: async (id, service, characteristic, callback) => { assert.equal(characteristic, UUIDS.status); notify = callback; },
  };
  const bluetooth = new NativeBluetooth(client);
  const connection = new TagConnection({ bluetooth, requireSecureContext: false });
  t.after(() => { connection.disconnect(); tag.dispose(); });
  return { tag, client, calls, bluetooth, connection, drop: () => { tag.device.gatt.connected = false; dropped(); }, oldNotify: () => notify };
}

test('native BLE uses shared command confirmation, wrong-pass rejection and signal decoding', async (t) => {
  const { connection, tag, calls } = fixture(t);
  await connection.connect();
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.deepEqual(calls[0], ['choose', { services: [UUIDS.service] }]);
  tag.setup();
  await connection.send('L', DEMO_TOKENS[0]);
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  await assert.rejects(connection.send('U', DEMO_TOKENS[1]), { code: 'TOKEN_MISMATCH' });
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  assert.deepEqual(await connection.readSignal(), { supported: true, rssi: -55 });
  await connection.send('U', DEMO_TOKENS[0]);
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.deepEqual(calls.filter(([type]) => type === 'write').map(([, value]) => value), [
    'L' + DEMO_TOKENS[0], 'U' + DEMO_TOKENS[1], 'U' + DEMO_TOKENS[0],
  ]);
});

test('native location scans are requested separately and return the tag’s Wi-Fi readings', async (t) => {
  const { connection, calls } = fixture(t);
  await connection.connect();
  assert.equal(calls.some(([type]) => type === 'wifi-scan'), false);
  assert.equal((await connection.scanWifi()).length, 2);
  assert.equal(calls.filter(([type]) => type === 'wifi-scan').length, 1);
  assert.equal(calls.some(([type]) => type === 'write'), false);
  connection.disconnect();
  await assert.rejects(connection.scanWifi(), /Connect/);
});

test('native app restores the exact saved ID without a chooser or name matching', async (t) => {
  const { connection, bluetooth, calls } = fixture(t);
  const saved = { id: 'tag-A', name: 'Carry-123456', auto: true };
  bluetooth.getSaved = () => saved;
  const storage = { getItem: () => JSON.stringify(saved), setItem() {}, removeItem() {} };
  const reconnect = new TagReconnect(connection, { bluetooth, storage });
  connection.onConnection = (connected) => reconnect.handleConnection(connected);
  t.after(() => reconnect.stop());
  await reconnect.restore();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connection.device.id, 'tag-A');
  assert.equal(connection.device.name, saved.name);
  assert.deepEqual(calls, [['restore', ['tag-A']], ['connect', 'tag-A']]);
});

test('native disconnect rejects an in-flight command and ignores late notifications', async (t) => {
  const { connection, tag, drop, oldNotify } = fixture(t);
  await connection.connect();
  tag.movementMs = 500;
  tag.setup();
  const pending = connection.send('L', DEMO_TOKENS[0]);
  const rejected = assert.rejects(pending, /disconnected/i);
  await flush();
  const stale = oldNotify();
  drop();
  await rejected;
  stale(tag.packet());
  assert.equal(connection.connected, false);
  assert.equal(connection.status, null);
});

test('a cancelled native handshake cleans up a late success before reconnecting', async (t) => {
  const { connection, client, bluetooth, calls } = fixture(t);
  const connect = client.connect;
  let finish;
  client.connect = () => new Promise((resolve) => { finish = resolve; });
  const pending = connection.connect();
  const rejected = assert.rejects(pending, /interrupted/);
  await flush();
  const device = connection.device;
  connection.disconnect();
  await rejected;
  finish(); await flush();
  assert.equal(device.gatt.connected, false);
  client.connect = connect;
  await connection.connect(device);
  assert.equal(connection.connected, true);
  assert.equal(calls.filter(([type]) => type === 'choose').length, 1);
  assert.equal(bluetooth.devices.size, 1);
});

test('native permission denial is recognized by the shared reconnection policy', async (t) => {
  const { connection, client } = fixture(t);
  client.initialize = async () => { throw new Error('Permission denied.'); };
  await assert.rejects(connection.connect(), { name: 'NotAllowedError' });
  assert.equal(connection.connected, false);
});

test('native permission UI can deactivate the app without cancelling the first connection', async (t) => {
  const { connection, bluetooth, client } = fixture(t);
  const reconnect = new TagReconnect(connection, { bluetooth, cancelOnHide: false });
  connection.onConnection = (connected) => reconnect.handleConnection(connected);
  t.after(() => reconnect.stop());
  client.initialize = async () => { reconnect.setVisible(false); await flush(); };
  await reconnect.connect();
  assert.equal(connection.connected, true);
  assert.equal(reconnect.visible, false);
  reconnect.setVisible(true);
  assert.equal(connection.status.state, 'OPEN_FREE');
});

test('missing native signal characteristic keeps the old firmware usable', async (t) => {
  const { connection, client } = fixture(t);
  client.getServices = async () => [{ uuid: UUIDS.service, characteristics: [{ uuid: UUIDS.command }, { uuid: UUIDS.status }] }];
  await connection.connect();
  assert.deepEqual(await connection.readSignal(), { supported: false });
  assert.equal(connection.connected, true);
});

test('a different BLE service cannot be treated as a Carry tag', async (t) => {
  const { connection, client } = fixture(t);
  client.getServices = async () => [];
  await assert.rejects(connection.connect(), { name: 'NotFoundError' });
  assert.equal(connection.connected, false);
});

test('native preferences hydrate before restoration and serialize save, disconnect, forget', async () => {
  let persisted = JSON.stringify({ id: 'tag-A', name: 'Carry', auto: true });
  let finish;
  const writes = [];
  const preferences = {
    get: async () => ({ value: persisted }),
    set: async ({ value }) => { writes.push(value); if (writes.length === 1) await new Promise((resolve) => { finish = resolve; }); persisted = value; },
    remove: async () => { writes.push(null); persisted = null; },
  };
  const storage = await createTagStorage(preferences);
  assert.equal(storage.getItem(TAG_KEY), persisted);
  storage.setItem(TAG_KEY, 'connected');
  await flush();
  storage.setItem(TAG_KEY, 'disconnected');
  storage.removeItem(TAG_KEY);
  assert.equal(storage.getItem(TAG_KEY), null);
  finish(); await storage.flush();
  assert.deepEqual(writes, ['connected', 'disconnected', null]);
  assert.equal(persisted, null);
});

test('a failed preference write is reported and does not prevent forgetting', async () => {
  const errors = [];
  let removed = false;
  const storage = await createTagStorage({
    get: async () => ({ value: null }),
    set: async () => { throw new Error('Disk full'); },
    remove: async () => { removed = true; },
  }, (error) => errors.push(error.message));
  storage.setItem(TAG_KEY, 'tag-A');
  storage.removeItem(TAG_KEY);
  await storage.flush();
  assert.deepEqual(errors, ['Disk full']);
  assert.equal(removed, true);
});
