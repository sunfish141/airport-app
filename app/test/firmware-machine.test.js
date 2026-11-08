import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FirmwareMachine } from '../src/firmware-machine.js';
import { encodeCommand, decodeStatus, DEMO_TOKENS } from '../src/protocol.js';

const binary = await readFile(new URL('../public/firmware/controller.wasm', import.meta.url));
const create = () => FirmwareMachine.create(binary);

test('timed demo WASM uses the real servo ramp and completes without endpoint contacts or setup', async () => {
  const machine = await FirmwareMachine.create(binary, { timedDemo: true });
  machine.exports.sim_faults(0, 2, 0); // Neither endpoint is connected.
  machine.advance(1100);
  assert.equal(machine.snapshot().state, 'OPEN_FREE');
  assert.equal(machine.snapshot().commandPulseUs, 500);
  assert.equal(machine.snapshot().open, false);
  assert.equal(decodeStatus(machine.packet).timedDemo, true);
  machine.command(encodeCommand('L', DEMO_TOKENS[0])); machine.advance(2);
  assert.equal(machine.snapshot().state, 'MOVING');
  const pulse = machine.snapshot().pulseUs;
  machine.advance(450);
  assert.ok(machine.snapshot().pulseUs > pulse);
  assert.equal(machine.snapshot().assigned, true);
  machine.advance(600);
  assert.equal(machine.snapshot().state, 'LOCKED_ASSIGNED');
  assert.equal(machine.snapshot().closed, false);
  assert.equal(machine.snapshot().commandPulseUs, 2500);
  assert.equal(machine.snapshot().pwm, false);
  machine.command(encodeCommand('U', DEMO_TOKENS[1])); machine.advance(2);
  assert.equal(machine.snapshot().error, 'TOKEN_MISMATCH');
  machine.command(encodeCommand('U', DEMO_TOKENS[0])); machine.advance(1100);
  assert.equal(machine.snapshot().state, 'OPEN_FREE');
  assert.equal(machine.snapshot().assigned, false);
  assert.equal(machine.snapshot().commandPulseUs, 500);
  machine.command(encodeCommand('L', DEMO_TOKENS[0])); machine.advance(1100);
  machine.exports.sim_power(0); machine.exports.sim_power(1); machine.advance(1100);
  assert.equal(machine.snapshot().state, 'OPEN_FREE');
  assert.equal(machine.snapshot().assigned, false);
});
function setup(machine) { machine.exports.sim_hold(650); machine.advance(700); }
function send(machine, opcode, token, time = 700) {
  assert.equal(machine.command(encodeCommand(opcode, token)), true);
  machine.advance(time);
}
function assigned(machine) { setup(machine); send(machine, 'L', DEMO_TOKENS[0]); }

test('WASM runs the production controller for 20 complete assignment/reuse cycles', async () => {
  const machine = await create();
  for (let i = 0; i < 20; i++) {
    const token = DEMO_TOKENS[i % 2];
    const wrong = DEMO_TOKENS[(i + 1) % 2];
    setup(machine);
    send(machine, 'L', token);
    assert.equal(machine.snapshot().state, 'LOCKED_ASSIGNED');
    send(machine, 'U', wrong, 2);
    assert.equal(machine.snapshot().error, 'TOKEN_MISMATCH');
    assert.equal(machine.snapshot().storedAssigned, 1);
    send(machine, 'U', token);
    assert.equal(machine.snapshot().state, 'OPEN_FREE');
    assert.equal(machine.snapshot().storedAssigned, 0);
  }
});

test('real debouncer rejects a short button tap and real setup expires', async () => {
  const machine = await create();
  machine.exports.sim_hold(250); machine.advance(350);
  send(machine, 'L', DEMO_TOKENS[0], 2);
  assert.equal(machine.snapshot().error, 'SETUP_REQUIRED');
  setup(machine);
  assert.ok(machine.snapshot().setupMs > 0);
  machine.advance(10050);
  send(machine, 'L', DEMO_TOKENS[0], 2);
  assert.equal(machine.snapshot().error, 'SETUP_REQUIRED');
});

test('trace proves NVS intent is committed before PWM and ownership clears only on open confirmation', async () => {
  const machine = await create();
  setup(machine); machine.traces();
  send(machine, 'L', DEMO_TOKENS[0], 2);
  const events = machine.traces();
  const save = events.findIndex((event) => event.code === 1 && event.a === 1 && event.b === 2);
  const drive = events.findIndex((event) => event.code === 3);
  assert.ok(save >= 0 && drive > save);
  assert.equal(machine.snapshot().state, 'MOVING');
  assert.equal(machine.snapshot().storedPending, 'Close');
  machine.advance(700);
  send(machine, 'U', DEMO_TOKENS[0], 400);
  assert.equal(machine.snapshot().open, false);
  assert.equal(machine.snapshot().storedAssigned, 1);
  assert.equal(machine.snapshot().pending, 'Open');
  machine.advance(300);
  assert.equal(machine.snapshot().storedAssigned, 0);
  for (const event of machine.traces().filter((event) => event.packet)) assert.doesNotThrow(() => decodeStatus(Uint8Array.from(event.packet)));
});

test('power cut mid-opening survives saved-state reload and requires actual 3-second service hold', async () => {
  const machine = await create(); assigned(machine);
  const cleanBoot = await create(); cleanBoot.restore(machine.savedState());
  assert.equal(cleanBoot.snapshot().state, 'LOCKED_ASSIGNED');
  assert.equal(cleanBoot.snapshot().pwm, false);
  assert.equal(cleanBoot.snapshot().saves, 0); // Reconciliation does not invent a flash write.
  send(machine, 'U', DEMO_TOKENS[0], 300);
  machine.exports.sim_power(0);
  const persisted = machine.savedState();
  const reboot = await create(); reboot.restore(persisted);
  assert.equal(reboot.snapshot().state, 'FAULT');
  assert.equal(reboot.snapshot().storedAssigned, 1);
  assert.equal(reboot.snapshot().pwm, false);
  reboot.exports.sim_hold(3200);
  reboot.advance(3000);
  assert.equal(reboot.snapshot().state, 'FAULT');
  reboot.advance(100);
  assert.equal(reboot.snapshot().state, 'MOVING');
  assert.equal(reboot.snapshot().storedAssigned, 1);
  reboot.advance(700);
  assert.equal(reboot.snapshot().state, 'OPEN_FREE');
  assert.equal(reboot.snapshot().storedAssigned, 0);
});

test('jam and missing endpoint both produce firmware timeout, retaining ownership without retries', async () => {
  for (const faults of [[1, 0, 0], [0, 3, 0]]) {
    const machine = await create(); assigned(machine);
    machine.exports.sim_faults(...faults);
    send(machine, 'U', DEMO_TOKENS[0], 1100);
    assert.equal(machine.snapshot().error, 'TIMEOUT');
    assert.equal(machine.snapshot().storedAssigned, 1);
    assert.equal(machine.snapshot().pwm, false);
    const commits = machine.snapshot().saves;
    machine.advance(5000);
    assert.equal(machine.snapshot().saves, commits);
    assert.equal(machine.snapshot().state, 'FAULT');
  }
});

test('contradictory sensors and failed storage prevent actuation; corrupt CRC preserves unknown ownership', async () => {
  const sensors = await create();
  sensors.exports.sim_faults(0, 1, 0); sensors.advance(100);
  assert.equal(sensors.snapshot().error, 'SENSOR_CONFLICT');
  assert.equal(sensors.snapshot().pwm, false);
  const storage = await create(); setup(storage);
  storage.exports.sim_faults(0, 0, 1);
  send(storage, 'L', DEMO_TOKENS[0], 2);
  assert.equal(storage.snapshot().error, 'STORAGE');
  assert.equal(storage.snapshot().pwm, false);
  const corrupt = await create(); assigned(corrupt);
  corrupt.exports.sim_corrupt();
  corrupt.exports.sim_power(0); corrupt.exports.sim_power(1); corrupt.advance(50);
  assert.equal(corrupt.snapshot().state, 'FAULT');
  assert.equal(corrupt.snapshot().assigned, true);
  assert.equal(corrupt.snapshot().nvsState, 'Corrupt');
});

test('storage closing, cable geometry, manual release and queue limits remain separate from ownership', async () => {
  const machine = await create();
  assert.equal(machine.exports.sim_cable(0), 1);
  send(machine, 'C');
  assert.equal(machine.snapshot().state, 'CLOSED_FREE');
  assert.equal(machine.snapshot().storedAssigned, 0);
  assert.equal(machine.exports.sim_cable(1), 0); // No invented cable-presence interlock on closing.
  machine.exports.sim_hold(3200); machine.advance(4000);
  assert.equal(machine.snapshot().state, 'OPEN_FREE');
  machine.exports.sim_cable(1);
  assigned(machine);
  machine.exports.sim_power(0);
  machine.exports.sim_manual_position(0);
  machine.exports.sim_power(1); machine.advance(50);
  assert.equal(machine.snapshot().state, 'FAULT');
  assert.equal(machine.snapshot().storedAssigned, 1); // Open-at-boot does not clear ownership.
  const queue = await create();
  for (let i = 0; i < 8; i++) assert.equal(queue.command(encodeCommand('F')), true);
  assert.equal(queue.command(encodeCommand('F')), false);
  queue.advance(2);
  assert.equal(queue.snapshot().error, 'BUSY');
});
