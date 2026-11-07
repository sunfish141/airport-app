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

function mock({ initial = {}, write = async () => {}, beforeRead } = {}) {
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
        return { getCharacteristic: async (uuid) => uuid === UUIDS.status ? characteristic : { writeValueWithResponse: write } };
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
