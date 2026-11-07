import test from 'node:test';
import assert from 'node:assert/strict';
import { TagReconnect } from '../src/tag-reconnect.js';
import { TagConnection } from '../src/bluetooth.js';
import { SimulatedTag } from '../src/simulated-tag.js';
import { DEMO_TOKENS } from '../src/protocol.js';

globalThis.isSecureContext = true;
const KEY = 'carry.remembered-tag.v1';
const flush = () => new Promise(setImmediate);
const timedContexts = new WeakSet();
function storage(initial = null) {
  const values = new Map(initial ? [[KEY, JSON.stringify(initial)]] : []);
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
async function fixture(context, { saved = null, permitted, unavailableStorage = false } = {}) {
  if (!timedContexts.has(context)) {
    context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
    timedContexts.add(context);
  }
  const tag = new SimulatedTag();
  tag.device.id = 'specific-tag';
  let requests = 0;
  const writes = [];
  const write = tag.commandCharacteristic.writeValueWithResponse;
  tag.commandCharacteristic.writeValueWithResponse = (bytes) => { writes.push(new TextDecoder().decode(bytes)); return write(bytes); };
  const bluetooth = { requestDevice: async () => { ++requests; return tag.device; } };
  if (permitted) bluetooth.getDevices = async () => permitted(tag.device);
  const savedStorage = unavailableStorage ? { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } } : storage(saved);
  let reconnect;
  const connection = new TagConnection({ bluetooth, onConnection: (connected) => reconnect?.handleConnection(connected) });
  reconnect = new TagReconnect(connection, { bluetooth, storage: savedStorage });
  context.after(() => { reconnect.stop(); connection.disconnect(); tag.dispose(); });
  return { tag, connection, reconnect, savedStorage, writes, requests: () => requests };
}

test('link loss reconnects to the exact selected tag without the chooser or replaying a pass', async (context) => {
  const { tag, connection, reconnect, writes, requests, savedStorage } = await fixture(context);
  await reconnect.connect();
  tag.setup();
  const locked = connection.send('L', DEMO_TOKENS[0]);
  await flush(); context.mock.timers.tick(650); await locked;
  tag.device.gatt.disconnect();
  assert.equal(reconnect.searching, true);
  context.mock.timers.tick(1000); await flush();
  assert.equal(connection.device, tag.device);
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  assert.equal(requests(), 1);
  assert.deepEqual(writes, ['L' + DEMO_TOKENS[0]]);
  assert.deepEqual(JSON.parse(savedStorage.getItem(KEY)), { id: 'specific-tag', name: 'Carry-DEMO', auto: true });
});

test('retries back off, pause in the background, and resume for the retained device', async (context) => {
  const { tag, connection, reconnect } = await fixture(context);
  await reconnect.connect();
  const connect = tag.device.gatt.connect;
  let attempts = 0;
  tag.device.gatt.connect = async () => { ++attempts; throw new Error('Out of range'); };
  tag.device.gatt.disconnect();
  context.mock.timers.tick(1000); await flush();
  assert.equal(attempts, 1);
  context.mock.timers.tick(1000); await flush();
  assert.equal(attempts, 1);
  context.mock.timers.tick(1000); await flush();
  assert.equal(attempts, 2);
  reconnect.setVisible(false);
  context.mock.timers.tick(60000); await flush();
  assert.equal(attempts, 2);
  tag.device.gatt.connect = connect;
  reconnect.setVisible(true);
  context.mock.timers.tick(0); await flush();
  assert.equal(connection.connected, true);
});

test('manual disconnect and forgetting suppress retries and persistence-based restoration', async (context) => {
  const { tag, connection, reconnect, savedStorage, requests } = await fixture(context);
  await reconnect.connect();
  reconnect.stop(); connection.disconnect();
  context.mock.timers.tick(60000); await flush();
  assert.equal(connection.connected, false);
  assert.equal(requests(), 1);
  assert.equal(JSON.parse(savedStorage.getItem(KEY)).auto, false);
  await reconnect.connect();
  assert.equal(connection.device, tag.device);
  assert.equal(requests(), 1);
  reconnect.stop({ forget: true }); connection.disconnect();
  assert.equal(reconnect.remembered, false);
  assert.equal(savedStorage.getItem(KEY), null);
});

test('reload restoration matches the saved browser ID even when another tag has the same name', async (context) => {
  const wrong = { id: 'another-tag', name: 'Carry-DEMO' };
  const { tag, connection, reconnect, requests } = await fixture(context, {
    saved: { id: 'specific-tag', name: 'Carry-DEMO', auto: true }, permitted: (device) => [wrong, device],
  });
  await reconnect.restore();
  context.mock.timers.tick(0); await flush();
  assert.equal(connection.device, tag.device);
  assert.equal(requests(), 0);
});

test('unsupported restoration, lost permission or an absent ID never select a different permitted tag', async (context) => {
  const data = { id: 'specific-tag', name: 'Carry-DEMO', auto: true };
  const unsupported = await fixture(context, { saved: data });
  await unsupported.reconnect.restore();
  assert.equal(unsupported.reconnect.state, 'idle');
  assert.equal(unsupported.requests(), 0);
  const absent = await fixture(context, { saved: data, permitted: () => [{ id: 'wrong', name: 'Carry-DEMO' }] });
  await absent.reconnect.restore();
  context.mock.timers.tick(60000); await flush();
  assert.equal(absent.connection.connected, false);
  assert.equal(absent.requests(), 0);
  const manual = await fixture(context, { saved: { ...data, auto: false }, permitted: () => { throw new Error('Must not enumerate'); } });
  await manual.reconnect.restore();
  assert.equal(manual.reconnect.state, 'idle');
});

test('blocked storage still allows same-page reconnection', async (context) => {
  const { tag, connection, reconnect, requests } = await fixture(context, { unavailableStorage: true });
  await reconnect.connect(); tag.device.gatt.disconnect();
  context.mock.timers.tick(1000); await flush();
  assert.equal(connection.connected, true);
  assert.equal(requests(), 1);
});

test('cancelling an in-flight handshake prevents late connection and retries', async (context) => {
  const { tag, connection, reconnect } = await fixture(context);
  await reconnect.connect();
  let release;
  tag.device.gatt.connect = () => new Promise((resolve) => { release = resolve; });
  tag.device.gatt.disconnect();
  context.mock.timers.tick(1000); await flush();
  assert.equal(connection.connecting, true);
  reconnect.stop(); await flush();
  release({ getPrimaryService: () => { throw new Error('Cancelled flow must not discover services'); } });
  await flush(); context.mock.timers.tick(60000); await flush();
  assert.equal(connection.connected, false);
  assert.equal(connection.connecting, false);
  assert.equal(reconnect.state, 'idle');
});

test('a hung connection times out so retrying and cancellation remain available', async (context) => {
  const { tag, connection, reconnect } = await fixture(context);
  await reconnect.connect();
  let attempts = 0;
  tag.device.gatt.connect = () => { ++attempts; return new Promise(() => {}); };
  tag.device.gatt.disconnect();
  context.mock.timers.tick(1000); await flush();
  context.mock.timers.tick(10000); await flush();
  assert.equal(connection.connecting, false);
  assert.equal(reconnect.state, 'waiting');
  context.mock.timers.tick(2000); await flush();
  assert.equal(attempts, 2);
  reconnect.stop(); await flush();
});

test('revoked Bluetooth permission stops retries and permits a fresh user selection', async (context) => {
  const { tag, connection, reconnect, requests } = await fixture(context);
  await reconnect.connect();
  const connect = tag.device.gatt.connect;
  tag.device.gatt.connect = async () => { throw new DOMException('Permission revoked', 'NotAllowedError'); };
  tag.device.gatt.disconnect();
  context.mock.timers.tick(1000); await flush();
  assert.equal(reconnect.state, 'idle');
  assert.equal(reconnect.enabled, false);
  tag.device.gatt.connect = connect;
  await reconnect.connect();
  assert.equal(requests(), 2);
  assert.equal(connection.connected, true);
});

test('forgetting during device enumeration ignores late results and stays forgotten after foregrounding', async (context) => {
  let finish;
  const { tag, connection, reconnect, savedStorage } = await fixture(context, {
    saved: { id: 'specific-tag', name: 'Carry-DEMO', auto: true },
    permitted: () => new Promise((resolve) => { finish = resolve; }),
  });
  const restoring = reconnect.restore();
  reconnect.stop({ forget: true });
  finish([tag.device]); await restoring;
  reconnect.setVisible(false); reconnect.setVisible(true);
  context.mock.timers.tick(60000); await flush();
  assert.equal(connection.connected, false);
  assert.equal(reconnect.remembered, false);
  assert.equal(savedStorage.getItem(KEY), null);
});

test('pausing during restoration discards its result and can resume with fresh permission enumeration', async (context) => {
  const pending = [];
  const { tag, connection, reconnect } = await fixture(context, {
    saved: { id: 'specific-tag', name: 'Carry-DEMO', auto: true },
    permitted: () => new Promise((resolve) => pending.push(resolve)),
  });
  const restoring = reconnect.restore();
  reconnect.setVisible(false);
  pending[0]([tag.device]); await restoring;
  assert.equal(reconnect.state, 'idle');
  assert.equal(connection.connected, false);
  reconnect.setVisible(true);
  pending[1]([tag.device]); await flush();
  context.mock.timers.tick(0); await flush();
  assert.equal(connection.connected, true);
});
