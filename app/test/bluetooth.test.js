import test from 'node:test';
import assert from 'node:assert/strict';
import { TagConnection } from '../src/bluetooth.js';
import { UUIDS } from '../src/protocol.js';

globalThis.isSecureContext = true;

function packet({ sequence = 1, state = 0, error = 0, flags = 2, command = '-' } = {}) {
  const bytes = new Uint8Array(12);
  bytes.set([1, state, error, flags]);
  new DataView(bytes.buffer).setUint32(6, sequence, true);
  bytes[10] = command.charCodeAt(0);
  return new DataView(bytes.buffer);
}

function mock({ initial = {}, write = async () => {}, beforeRead, signalRead, signalMissing = false } = {}) {
  const reads = [];
  const connections = [];
  const characteristic = new EventTarget();
  characteristic.value = packet(initial);
  characteristic.startNotifications = async () => {
    if (beforeRead) {
      characteristic.value = packet(beforeRead);
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  };
  characteristic.readValue = async () => packet(initial);
  const device = new EventTarget();
  device.name = 'Carry-123ABC';
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return { getPrimaryService: async (uuid) => {
        assert.equal(uuid, UUIDS.service);
        return { getCharacteristic: async (uuid) => {
          if (uuid === UUIDS.status) return characteristic;
          if (uuid === UUIDS.command) return { writeValueWithResponse: write };
          if (uuid === UUIDS.signal && !signalMissing) return { readValue: signalRead || (async () => new DataView(Uint8Array.of(1, 1, 201, 0).buffer)) };
          throw new DOMException('Characteristic not found.', 'NotFoundError');
        } };
      } };
    },
    disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  let requested = false;
  const connection = new TagConnection({
    bluetooth: { requestDevice(options) { requested = true; assert.deepEqual(options.filters, [{ services: [UUIDS.service] }]); return Promise.resolve(device); } },
    onStatus: (status) => reads.push(status), onConnection: (...args) => connections.push(args),
  });
  return { connection, reads, connections, device, characteristic, requested: () => requested };
}

test('connect uses a service filter immediately and reads/subscribes to confirmed status', async () => {
  const { connection, requested, connections } = mock();
  const connecting = connection.connect();
  assert.equal(requested(), true);
  await connecting;
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.equal(connection.connected, true);
  assert.deepEqual(connections.at(-1), [true, 'Carry-123ABC']);
  connection.disconnect();
});

test('an older initial read cannot overwrite a newer notification', async () => {
  const { connection } = mock({ initial: { sequence: 4 }, beforeRead: { sequence: 5, state: 2, flags: 5 } });
  await connection.connect();
  assert.equal(connection.status.sequence, 5);
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  connection.disconnect();
});

test('write acknowledgement and MOVING never count as a successful lock', async () => {
  let writes = 0;
  const { connection } = mock({ write: async (bytes) => { ++writes; assert.equal(bytes.length, 17); } });
  await connection.connect();
  let complete = false;
  const result = connection.send('L', 'A1B2C3D4E5F60718').then(() => { complete = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(complete, false);
  connection.accept(packet({ sequence: 2, state: 3, command: 'L', flags: 3 }));
  await Promise.resolve();
  assert.equal(complete, false);
  await assert.rejects(connection.send('C'), /Wait for/);
  connection.accept(packet({ sequence: 3, state: 2, command: 'L', flags: 5 }));
  await result;
  assert.equal(complete, true);
  connection.disconnect();
});

test('wrong token error fails the request while retaining the assigned state', async () => {
  const { connection } = mock({ initial: { state: 2, flags: 5 } });
  await connection.connect();
  const result = connection.send('U', '9A8B7C6D5E4F3021');
  const rejected = assert.rejects(result, /does not match/);
  connection.accept(packet({ sequence: 2, state: 2, flags: 5, error: 8, command: 'U' }));
  await rejected;
  assert.equal(connection.status.assigned, true);
  connection.disconnect();
});

test('fault notifications reject pending movement and never report open', async () => {
  const { connection } = mock({ initial: { state: 2, flags: 5 } });
  await connection.connect();
  const result = assert.rejects(connection.send('U', 'A1B2C3D4E5F60718'), /timed out/);
  connection.accept(packet({ sequence: 2, state: 4, flags: 1, error: 9, command: 'U' }));
  await result;
  assert.equal(connection.status.state, 'FAULT');
  connection.disconnect();
});

test('disconnect rejects pending command and clears stale status', async () => {
  const { connection, device } = mock();
  await connection.connect();
  const result = assert.rejects(connection.send('C'), /disconnected/);
  device.gatt.disconnect();
  await result;
  assert.equal(connection.status, null);
  assert.equal(connection.connected, false);
  await assert.rejects(connection.send('F'), /Connect/);
});

test('a failed GATT write cannot leave a pending request behind', async () => {
  const { connection } = mock({ write: async () => { throw new Error('GATT failed'); } });
  await connection.connect();
  await assert.rejects(connection.send('C'), /GATT failed/);
  assert.equal(connection.pending, null);
  connection.disconnect();
});

test('invalid notification invalidates connection instead of reusing a previous state', async () => {
  const { connection } = mock();
  await connection.connect();
  connection.accept(new DataView(new ArrayBuffer(2)));
  assert.equal(connection.connected, false);
  assert.equal(connection.status, null);
});

test('an unrelated or stale event cannot complete a request', async () => {
  const { connection } = mock();
  await connection.connect();
  const result = connection.send('C');
  connection.accept(packet({ sequence: 1, state: 1, flags: 4, command: 'C' }));
  connection.accept(packet({ sequence: 2, state: 1, flags: 4, command: 'F' }));
  assert.notEqual(connection.pending, null);
  connection.accept(packet({ sequence: 3, state: 1, flags: 4, command: 'C' }));
  await result;
  connection.disconnect();
});

test('service opening cancels a pending command without a false timeout or success', async () => {
  const { connection } = mock();
  await connection.connect();
  const result = assert.rejects(connection.send('L', 'A1B2C3D4E5F60718'), /Service opening interrupted/);
  connection.accept(packet({ sequence: 2, state: 3, flags: 3, command: 'S' }));
  await result;
  assert.equal(connection.pending, null);
  assert.equal(connection.connected, true);
  connection.accept(packet({ sequence: 3, state: 0, flags: 2, command: 'S' }));
  assert.equal(connection.status.state, 'OPEN_FREE');
  connection.disconnect();
});

test('a missing confirmation times out and forces a fresh connection', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection } = mock();
  await connection.connect();
  const result = assert.rejects(connection.send('C'), /No confirmed result/);
  context.mock.timers.tick(5000);
  await result;
  assert.equal(connection.connected, false);
  assert.equal(connection.status, null);
});

test('proximity readings never acknowledge an actuator command and skip pending commands', async () => {
  const { connection } = mock();
  await connection.connect();
  assert.deepEqual(await connection.readSignal(), { supported: true, rssi: -55 });
  const locked = connection.send('L', 'A1B2C3D4E5F60718');
  assert.equal(await connection.readSignal(), null);
  assert.notEqual(connection.pending, null);
  connection.accept(packet({ sequence: 2, state: 2, flags: 5, command: 'L' }));
  await locked;
  connection.disconnect();
});

test('GATT signal reads and command writes serialize without competing on the connection', async () => {
  let releaseRead;
  let reading = false;
  let wrote = false;
  const { connection } = mock({
    signalRead: () => { reading = true; return new Promise((resolve) => { releaseRead = () => { reading = false; resolve(new DataView(Uint8Array.of(1, 1, 180, 0).buffer)); }; }); },
    write: async () => { assert.equal(reading, false); wrote = true; },
  });
  await connection.connect();
  const signal = connection.readSignal();
  await new Promise(setImmediate);
  const flashing = connection.send('F');
  assert.equal(wrote, false);
  releaseRead();
  assert.equal((await signal).rssi, -76);
  await new Promise(setImmediate);
  assert.equal(wrote, true);
  connection.accept(packet({ sequence: 2, command: 'F' }));
  await flashing;
  connection.disconnect();
});

test('old firmware and unavailable/corrupt telemetry leave lock control usable', async () => {
  const old = mock({ signalMissing: true }).connection;
  await old.connect();
  assert.deepEqual(await old.readSignal(), { supported: false });
  assert.equal(old.connected, true);
  old.disconnect();
  const unavailable = mock({ signalRead: async () => new DataView(Uint8Array.of(1, 0, 0, 0).buffer) }).connection;
  await unavailable.connect();
  assert.deepEqual(await unavailable.readSignal(), { supported: true, rssi: null });
  assert.equal(unavailable.pending, null);
  unavailable.disconnect();
  const invalid = mock({ signalRead: async () => new DataView(Uint8Array.of(1, 1, 127, 0).buffer) }).connection;
  await invalid.connect();
  await assert.rejects(invalid.readSignal(), /Invalid signal/);
  assert.equal(invalid.connected, true);
  invalid.disconnect();
});

test('physical service recovery cancels a command queued behind a signal read before it can actuate', async () => {
  let releaseRead;
  let writes = 0;
  const { connection } = mock({
    signalRead: () => new Promise((resolve) => { releaseRead = resolve; }),
    write: async () => { ++writes; },
  });
  await connection.connect();
  const signal = connection.readSignal();
  await new Promise(setImmediate);
  const lock = assert.rejects(connection.send('L', 'A1B2C3D4E5F60718'), /Service opening/);
  connection.accept(packet({ sequence: 2, command: 'S', state: 3, flags: 2 }));
  await lock;
  releaseRead(new DataView(Uint8Array.of(1, 1, 201, 0).buffer));
  await signal;
  await new Promise(setImmediate);
  assert.equal(writes, 0);
  connection.disconnect();
});

test('a hung proximity read is bounded and disconnects so it cannot block later commands', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection } = mock({ signalRead: () => new Promise(() => {}) });
  await connection.connect();
  const result = assert.rejects(connection.readSignal(), /timed out/);
  await new Promise(setImmediate);
  context.mock.timers.tick(2500);
  await result;
  assert.equal(connection.connected, false);
  await assert.rejects(connection.send('F'), /Connect/);
});

test('a read completing after disconnect/reconnect cannot supply a stale reading', async () => {
  let release;
  const { connection } = mock({ signalRead: () => new Promise((resolve) => { release = resolve; }) });
  await connection.connect();
  const signal = assert.rejects(connection.readSignal(), /disconnected/);
  await new Promise(setImmediate);
  connection.disconnect();
  await connection.connect();
  release(new DataView(Uint8Array.of(1, 1, 210, 0).buffer));
  await signal;
  assert.equal(connection.connected, true);
  connection.disconnect();
});
