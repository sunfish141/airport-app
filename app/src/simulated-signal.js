// Radio readings are explicitly synthetic; the controller WASM has no radio.
// Both previews expose the same four-byte characteristic as the physical tag.
export class SimulatedSignal {
  constructor() { this.rssi = -55; this.available = true; }
  setRssi(value) {
    if (Number.isInteger(Number(value)) && Number(value) >= -127 && Number(value) <= 20) this.rssi = Number(value);
  }
  packet() { return new DataView(Uint8Array.from([1, Number(this.available), this.available ? this.rssi & 255 : 0, 0]).buffer); }
}
