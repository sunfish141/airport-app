import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCommand, decodeStatus, normalizeToken, isNewer } from '../src/protocol.js';

test('tokens are exact hex, uppercased without accepting whitespace or airline text', () => {
  assert.equal(normalizeToken('a1b2c3d4e5f60718'), 'A1B2C3D4E5F60718');
  for (const token of ['', ' A1B2C3D4E5F60718', 'A1B2C3D4E5F60718\n', 'A1B2C3D4E5F6071G', 'M1FLIGHT', undefined]) {
    assert.throws(() => normalizeToken(token));
  }
});

test('command frames have no terminator and never exceed 17 bytes', () => {
  assert.equal(new TextDecoder().decode(encodeCommand('L', 'a1b2c3d4e5f60718')), 'LA1B2C3D4E5F60718');
  assert.equal(encodeCommand('U', '9A8B7C6D5E4F3021').length, 17);
  assert.deepEqual(encodeCommand('C'), Uint8Array.of(67));
  assert.deepEqual(encodeCommand('F'), Uint8Array.of(70));
  assert.throws(() => encodeCommand('S'));
  assert.throws(() => encodeCommand('C', 'payload'));
});

test('golden packet matches firmware bytes including little endian sequence', () => {
  const packet = Uint8Array.from([1, 2, 0, 5, 0, 0, 0x78, 0x56, 0x34, 0x12, 76, 0]);
  assert.deepEqual(decodeStatus(packet), {
    state: 'LOCKED_ASSIGNED', error: 'NONE', assigned: true, open: false, closed: true,
    setupMs: 0, sequence: 0x12345678, command: 'L',
  });
  const padded = new Uint8Array(18);
  padded.set(packet, 3);
  assert.equal(decodeStatus(new DataView(padded.buffer, 3, 12)).sequence, 0x12345678);
});

test('invalid status packets are rejected instead of displaying invented state', () => {
  const packet = Uint8Array.from([1, 0, 0, 2, 0, 0, 1, 0, 0, 0, 45, 0]);
  for (const [index, value] of [[0, 2], [1, 5], [2, 99], [3, 8], [3, 0], [3, 3], [5, 255], [10, 88], [11, 2]]) {
    const invalid = packet.slice(); invalid[index] = value;
    assert.throws(() => decodeStatus(invalid));
  }
  assert.throws(() => decodeStatus(packet.slice(1)));
});

test('timed demo status explicitly allows unconfirmed position, but still checks ownership', () => {
  const packet = Uint8Array.from([1, 2, 0, 1, 0, 0, 1, 0, 0, 0, 76, 1]);
  assert.deepEqual(decodeStatus(packet), {
    state: 'LOCKED_ASSIGNED', error: 'NONE', assigned: true, open: false, closed: false,
    setupMs: 0, sequence: 1, command: 'L', timedDemo: true,
  });
  packet[11] = 0; assert.throws(() => decodeStatus(packet));
  packet[11] = 1; packet[3] = 0; assert.throws(() => decodeStatus(packet));
  packet[1] = 0; packet[3] = 1; assert.throws(() => decodeStatus(packet));
});

test('revision ordering handles duplicates, stale reads, and uint32 wrap', () => {
  assert.equal(isNewer(2, 1), true);
  assert.equal(isNewer(1, 1), false);
  assert.equal(isNewer(1, 2), false);
  assert.equal(isNewer(0, 0xffffffff), true);
  assert.equal(isNewer(0xffffffff, 0), false);
});
