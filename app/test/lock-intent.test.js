import test from 'node:test';
import assert from 'node:assert/strict';
import { LockIntent } from '../src/lock-intent.js';
import { DEMO_TOKENS } from '../src/protocol.js';
const open = { state: 'OPEN_FREE', assigned: false };

test('a scan waits for physical setup, then can be consumed only once', () => {
  const intent = new LockIntent();
  intent.queue(DEMO_TOKENS[0].toLowerCase(), 1000);
  assert.equal(intent.take(open, 0, 1100), null);
  assert.equal(intent.pending, true);
  assert.equal(intent.take(open, 10000, 2000), DEMO_TOKENS[0]);
  assert.equal(intent.take(open, 10000, 2001), null);
});
test('expired or cancelled scans cannot actuate when a later setup window opens', () => {
  const intent = new LockIntent();
  intent.queue(DEMO_TOKENS[0], 1000);
  assert.equal(intent.take(open, 10000, 31000), null);
  assert.equal(intent.pending, false);
  intent.queue(DEMO_TOKENS[1], 32000);
  intent.clear();
  assert.equal(intent.take(open, 10000, 32100), null);
});
test('a fault, moving bolt, disconnect or new assignment invalidates the scan', () => {
  for (const status of [null, { state: 'FAULT' }, { state: 'MOVING' }, { state: 'CLOSED_FREE' }, { state: 'LOCKED_ASSIGNED', assigned: true }, { ...open, assigned: true }]) {
    const intent = new LockIntent();
    intent.queue(DEMO_TOKENS[0], 0);
    assert.equal(intent.take(status, 10000, 100), null);
    assert.equal(intent.pending, false);
    assert.equal(intent.take(open, 10000, 101), null);
  }
});
