// Synthetic radio input only: the C++ controller still owns actuator decisions.
// These BSSIDs are never sent to a real geolocation provider.
export class SimulatedWifi {
  constructor(connected) { this.connected = connected; this.request = 0; this.state = 0; this.points = true; }
  async writeValueWithResponse(bytes) {
    if (!this.connected()) throw new Error('Tag disconnected.');
    if (bytes.length !== 3 || bytes[0] !== 1) throw new Error('Invalid scan request.');
    this.request = bytes[1] | bytes[2] << 8;
    this.state = 1;
    this.started = performance.now();
  }
  async readValue() {
    if (!this.connected()) throw new Error('Tag disconnected.');
    if (this.state === 1 && performance.now() - this.started >= 400) this.state = 2;
    const count = this.state === 2 && this.points ? 2 : 0;
    const bytes = new Uint8Array(6 + count * 8);
    bytes.set([1, this.state, this.request & 255, this.request >> 8, count, 0]);
    if (count) {
      bytes.set([0, 17, 34, 51, 68, 80, 201, 1], 6);
      bytes.set([0, 17, 34, 51, 68, 96, 192, 6], 14);
    }
    return new DataView(bytes.buffer);
  }
}
export async function simulatedLocation() {
  return { location: { lat: 43.6777, lng: -79.6248 }, accuracy: 80 };
}
