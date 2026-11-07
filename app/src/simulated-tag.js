import { UUIDS, STATES, ERRORS, normalizeToken } from './protocol.js';
import { SimulatedSignal } from './simulated-signal.js';
import { SimulatedWifi } from './simulated-wifi.js';

// An opt-in, in-memory peripheral for the mobile preview. No real radio or NVS.
export class SimulatedTag {
  constructor({ onChange = () => {}, movementMs = 650, timeoutMs = 1000 } = {}) {
    Object.assign(this, { onChange, movementMs, timeoutMs });
    this.sequence = 0;
    this.state = 'OPEN_FREE';
    this.error = 'NONE';
    this.open = true;
    this.closed = false;
    this.token = null;
    this.pending = null;
    this.command = '-';
    this.setupUntil = 0;
    this.obstructed = false;
    this.flashing = false;
    this.signal = new SimulatedSignal();
    this.signalCharacteristic = { readValue: async () => this.signal.packet() };
    this.statusCharacteristic = new EventTarget();
    this.statusCharacteristic.startNotifications = async () => this.statusCharacteristic;
    this.statusCharacteristic.readValue = async () => this.packet();
    this.commandCharacteristic = { writeValueWithResponse: async (bytes) => this.receive(bytes) };
    this.device = new EventTarget();
    this.device.id = 'carry-javascript-demo';
    this.wifi = new SimulatedWifi(() => this.device.gatt.connected);
    this.device.name = 'Carry-DEMO';
    this.device.gatt = {
      connected: false,
      connect: async () => {
        this.device.gatt.connected = true;
        this.changed();
        return { getPrimaryService: async (uuid) => {
          if (uuid !== UUIDS.service) throw new Error('Unknown simulated service.');
          return { getCharacteristic: async (id) => {
            if (id === UUIDS.command) return this.commandCharacteristic;
            if (id === UUIDS.status) return this.statusCharacteristic;
            if (id === UUIDS.signal) return this.signalCharacteristic;
            if (id === UUIDS.wifi) return this.wifi;
            throw new Error('Unknown simulated characteristic.');
          } };
        } };
      },
      disconnect: () => {
        if (!this.device.gatt.connected) return;
        this.device.gatt.connected = false;
        this.device.dispatchEvent(new Event('gattserverdisconnected'));
        this.changed();
      },
    };
    this.bluetooth = { requestDevice: async () => this.device };
    this.countdown = setInterval(() => {
      if (this.setupUntil && this.setupUntil <= Date.now()) {
        this.setupUntil = 0;
        this.emit('NONE', '-');
      } else if (this.setupUntil) this.emit(this.error, '-');
    }, 1000);
  }

  get setupMs() { return Math.max(0, Math.min(10000, this.setupUntil - Date.now())); }
  snapshot() {
    return {
      state: this.state, error: this.error, assigned: this.token !== null,
      connected: this.device.gatt.connected, setupMs: this.setupMs,
      obstructed: this.obstructed, flashing: this.flashing,
      rssi: this.signal.rssi, signalAvailable: this.signal.available,
    };
  }
  changed() { this.onChange(this.snapshot()); }
  packet() {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    bytes.set([1, STATES.indexOf(this.state), ERRORS.indexOf(this.error),
      Number(this.token !== null) | (Number(this.open) << 1) | (Number(this.closed) << 2)]);
    view.setUint16(4, this.setupMs, true);
    view.setUint32(6, this.sequence, true);
    bytes[10] = this.command.charCodeAt(0);
    return view;
  }
  emit(error = 'NONE', command = '-') {
    this.error = error;
    this.command = command;
    this.sequence = (this.sequence + 1) >>> 0;
    this.statusCharacteristic.value = this.packet();
    if (this.device.gatt.connected) this.statusCharacteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    this.changed();
  }
  setup() {
    if (this.state !== 'OPEN_FREE') return;
    this.setupUntil = Date.now() + 10000;
    this.emit();
  }
  setObstructed(value) { this.obstructed = Boolean(value); this.changed(); }
  setSignal(value) { this.signal.setRssi(value); this.changed(); }
  setSignalAvailable(value) { this.signal.available = Boolean(value); this.changed(); }

  receive(bytes) {
    if (!this.device.gatt.connected) throw new Error('Simulated tag disconnected.');
    const text = new TextDecoder().decode(bytes);
    const opcode = text[0];
    if (!text.length || bytes.length > 17) return this.emit('MALFORMED');
    if (!['L', 'U', 'C', 'F'].includes(opcode)) return this.emit('UNKNOWN_COMMAND');
    let token;
    try {
      if (opcode === 'L' || opcode === 'U') token = normalizeToken(text.slice(1));
      else if (text.length !== 1) throw new Error('Unexpected payload.');
    } catch { return this.emit('MALFORMED', opcode); }
    if (this.state === 'MOVING') return this.emit('BUSY', opcode);
    if (opcode === 'F') {
      clearTimeout(this.flashTimer);
      this.flashing = true;
      this.flashTimer = setTimeout(() => { this.flashing = false; this.changed(); }, 2000);
      return this.emit('NONE', opcode);
    }
    if (this.state === 'FAULT') return this.emit('RECOVERY_REQUIRED', opcode);
    if (opcode === 'L' || opcode === 'C') {
      if (this.token !== null) return this.emit('ASSIGNED', opcode);
      if (this.state !== 'OPEN_FREE') return this.emit('NOT_OPEN', opcode);
      if (opcode === 'L') {
        if (!this.setupMs) return this.emit('SETUP_REQUIRED', opcode);
        this.token = token;
      }
      return this.move('close', opcode);
    }
    if (this.token === null) return this.emit('UNASSIGNED', opcode);
    if (token !== this.token) return this.emit('TOKEN_MISMATCH', opcode);
    this.move('open', opcode);
  }

  move(direction, opcode) {
    clearTimeout(this.movementTimer);
    this.setupUntil = 0;
    this.pending = direction;
    this.state = 'MOVING';
    this.emit('NONE', opcode);
    this.movementTimer = setTimeout(() => {
      if (this.obstructed) {
        this.open = this.closed = false;
        this.movementTimer = setTimeout(() => {
          this.state = 'FAULT';
          this.emit('TIMEOUT', opcode);
        }, Math.max(0, this.timeoutMs - this.movementMs));
      } else this.finish(direction, opcode);
    }, this.movementMs);
  }
  finish(direction, opcode) {
    this.pending = null;
    this.open = direction === 'open';
    this.closed = !this.open;
    if (this.open) this.token = null;
    this.state = this.open ? 'OPEN_FREE' : this.token !== null ? 'LOCKED_ASSIGNED' : 'CLOSED_FREE';
    this.emit('NONE', opcode);
  }
  service() {
    clearTimeout(this.movementTimer);
    this.setupUntil = 0;
    if (this.open) this.finish('open', 'S');
    else this.move('open', 'S');
  }
  reboot() {
    this.device.gatt.disconnect();
    clearTimeout(this.movementTimer);
    clearTimeout(this.flashTimer);
    this.setupUntil = 0;
    this.flashing = false;
    if (this.pending || this.state === 'FAULT') {
      this.state = 'FAULT';
      this.emit('RECOVERY_REQUIRED');
    } else this.emit();
  }
  reset() {
    this.device.gatt.disconnect();
    this.signal = new SimulatedSignal();
    clearTimeout(this.movementTimer);
    clearTimeout(this.flashTimer);
    this.token = this.pending = null;
    this.setupUntil = 0;
    this.flashing = this.obstructed = false;
    this.open = true;
    this.closed = false;
    this.state = 'OPEN_FREE';
    this.emit();
  }
  dispose() {
    this.device.gatt.disconnect();
    clearInterval(this.countdown);
    clearTimeout(this.movementTimer);
    clearTimeout(this.flashTimer);
  }
}
