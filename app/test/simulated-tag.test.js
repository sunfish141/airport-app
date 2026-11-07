import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedTag } from '../src/simulated-tag.js';
import { TagConnection } from '../src/bluetooth.js';
import { DEMO_TOKENS } from '../src/protocol.js';

globalThis.isSecureContext = true;

async function fixture(context) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const tag = new SimulatedTag();
  const connection = new TagConnection({ bluetooth: tag.bluetooth });
  context.after(() => { connection.disconnect(); tag.dispose(); });
  await connection.connect();
  async function move(opcode, token) {
    const result = connection.send(opcode, token);
    await Promise.resolve();
    context.mock.timers.tick(650);
    return result;
  }
  return { tag, connection, move };
}

test('virtual tag drives the real BLE client through assignment, mismatch and reuse', async (context) => {
  const { tag, connection, move } = await fixture(context);
  assert.equal(connection.status.state, 'OPEN_FREE');
  await assert.rejects(connection.send('L', DEMO_TOKENS[0]), /start setup/);
  tag.setup();
  await move('L', DEMO_TOKENS[0]);
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  await assert.rejects(connection.send('U', DEMO_TOKENS[1]), /does not match/);
  assert.equal(connection.status.assigned, true);
  await move('U', DEMO_TOKENS[0]);
  assert.equal(connection.status.assigned, false);
  tag.setup();
  await move('L', DEMO_TOKENS[1]);
  await assert.rejects(connection.send('U', DEMO_TOKENS[0]), /does not match/);
});

test('setup expires and storage closing reopens using virtual service button', async (context) => {
  const { tag, connection, move } = await fixture(context);
  tag.setup();
  context.mock.timers.tick(10000);
  await assert.rejects(connection.send('L', DEMO_TOKENS[0]), /start setup/);
  await move('C');
  assert.equal(connection.status.state, 'CLOSED_FREE');
  tag.service();
  context.mock.timers.tick(650);
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.equal(connection.status.assigned, false);
});

test('obstruction retains assignment through timeout and requires service recovery', async (context) => {
  const { tag, connection, move } = await fixture(context);
  tag.setup();
  await move('L', DEMO_TOKENS[0]);
  tag.setObstructed(true);
  const unlocking = assert.rejects(connection.send('U', DEMO_TOKENS[0]), /timed out/);
  await Promise.resolve();
  context.mock.timers.tick(650);
  assert.equal(connection.status.assigned, true);
  assert.equal(connection.status.state, 'MOVING');
  context.mock.timers.tick(350);
  await unlocking;
  assert.equal(connection.status.state, 'FAULT');
  assert.equal(connection.status.assigned, true);
  tag.setObstructed(false);
  context.mock.timers.tick(1000);
  assert.equal(connection.status.state, 'FAULT');
  tag.service();
  context.mock.timers.tick(650);
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.equal(connection.status.assigned, false);
});

test('reboot preserves ownership and interrupted motion needs recovery; reset clears demo', async (context) => {
  const { tag, connection, move } = await fixture(context);
  tag.setup();
  await move('L', DEMO_TOKENS[0]);
  tag.reboot();
  await connection.connect();
  assert.equal(connection.status.state, 'LOCKED_ASSIGNED');
  assert.equal(connection.status.assigned, true);
  const unlocking = assert.rejects(connection.send('U', DEMO_TOKENS[0]), /disconnected/);
  await Promise.resolve();
  tag.reboot();
  await unlocking;
  await connection.connect();
  assert.equal(connection.status.state, 'FAULT');
  assert.equal(connection.status.assigned, true);
  tag.reset();
  await connection.connect();
  assert.equal(connection.status.state, 'OPEN_FREE');
  assert.equal(connection.status.assigned, false);
});
