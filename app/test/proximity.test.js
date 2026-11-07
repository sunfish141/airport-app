import test from 'node:test';
import assert from 'node:assert/strict';
import { Proximity } from '../src/proximity.js';
import { decodeSignal } from '../src/protocol.js';

test('signal packets decode signed RSSI and reject sentinels or malformed frames', () => {
  assert.equal(decodeSignal(Uint8Array.of(1, 1, 201, 0)), -55);
  assert.equal(decodeSignal(Uint8Array.of(1, 0, 0, 0)), null);
  const padded = Uint8Array.of(0, 1, 1, 166, 0, 0);
  assert.equal(decodeSignal(new DataView(padded.buffer, 1, 4)), -90);
  for (const bytes of [[1, 1, 127, 0], [1, 1, 128, 0], [2, 1, 201, 0], [1, 2, 201, 0], [1, 1, 201, 1], [1, 1, 201]]) {
    assert.throws(() => decodeSignal(Uint8Array.from(bytes)));
  }
});

test('a nearby indication needs multiple readings; an isolated spike cannot move it', () => {
  const tracker = new Proximity();
  tracker.add(-60, 1000);
  assert.equal(tracker.snapshot(1000).state, 'collecting');
  tracker.add(-61, 2000); tracker.add(-59, 3000);
  assert.equal(tracker.snapshot(3000).label, 'Strong signal');
  tracker.add(-20, 4000);
  assert.ok(Math.abs(tracker.snapshot(4000).rssi + 60) <= 2);
  assert.equal(tracker.snapshot(4000).label, 'Strong signal');
});

test('hysteresis prevents signal bands flickering at a boundary', () => {
  const tracker = new Proximity();
  for (let n = 1; n <= 15; ++n) tracker.add(n % 2 ? -61 : -59, n * 1000);
  assert.equal(tracker.snapshot(15000).label, 'Medium signal');
});

test('sustained signal change produces stronger/weaker guidance; interference is labelled', () => {
  const tracker = new Proximity();
  let now = 0;
  const feed = (value, count) => { for (let i = 0; i < count; ++i) tracker.add(value, now += 1000); };
  feed(-90, 8); feed(-45, 5);
  assert.equal(tracker.snapshot(now).trend, 'Getting stronger');
  feed(-45, 8); feed(-95, 5);
  assert.equal(tracker.snapshot(now).trend, 'Getting weaker');
  const noisy = new Proximity();
  [-100, -50, -80, -40, -95].forEach((n, i) => noisy.add(n, (i + 1) * 1000));
  assert.equal(noisy.snapshot(5000).trend, 'Signal fluctuating');
});

test('stale or invalid data cannot preserve a nearby indication or contaminate a new search', () => {
  const tracker = new Proximity();
  [-40, -40, -40].forEach((n, i) => tracker.add(n, (i + 1) * 1000));
  tracker.add(127, 6000); tracker.add(null, 7000);
  assert.equal(tracker.snapshot(7999).state, 'live');
  assert.deepEqual(tracker.snapshot(8000), { state: 'stale', bars: 0, rssi: null, trend: '', age: 5000 });
  tracker.add(-100, 8001);
  assert.equal(tracker.snapshot(8001).state, 'collecting');
  tracker.add(-100, 9001); tracker.add(-100, 10001);
  assert.equal(tracker.snapshot(10001).label, 'Very weak signal');
  tracker.reset();
  assert.equal(tracker.snapshot(11000).state, 'waiting');
});
