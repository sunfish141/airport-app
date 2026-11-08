import { UUIDS } from './protocol.js';
import { FirmwareMachine } from './firmware-machine.js';
import { SimulatedSignal } from './simulated-signal.js';
import { SimulatedWifi } from './simulated-wifi.js';

const STORAGE_KEY = 'carry.firmware-workbench.timed.v1';

// GATT-shaped transport only. All state decisions are made by Controller.cpp.
export class FirmwareTag {
  constructor({ onChange = () => {} } = {}) {
    this.engine = 'firmware';
    this.onChange = onChange;
    this.speed = 1;
    this.paused = false;
    this.events = [];
    this.lastSequence = null;
    this.lastSavedAt = 0;
    this.lastSaves = -1;
    this.persistence = 'browser';
    this.signal = new SimulatedSignal();
    this.signalCharacteristic = { readValue: async () => this.signal.packet() };
    this.statusCharacteristic = new EventTarget();
    this.statusCharacteristic.startNotifications = async () => this.statusCharacteristic;
    this.statusCharacteristic.readValue = async () => this.machine.packet;
    this.commandCharacteristic = { writeValueWithResponse: async (bytes) => {
      if (!this.machine?.command(bytes)) throw new Error('Firmware is off, booting, or its command queue is full.');
    } };
    this.device = new EventTarget();
    this.device.id = 'carry-firmware-demo';
    this.wifi = new SimulatedWifi(() => this.device.gatt.connected);
    this.device.name = 'Carry-FIRMWARE';
    this.device.gatt = {
      connected: false,
      connect: async () => {
        await this.ready;
        if (!this.machine.snapshot().ready) throw new Error('Power on the virtual tag and wait for boot.');
        this.device.gatt.connected = true;
        this.flush();
        return { getPrimaryService: async (uuid) => {
          if (uuid !== UUIDS.service) throw new Error('Unknown firmware service.');
          return { getCharacteristic: async (id) => {
            if (id === UUIDS.status) return this.statusCharacteristic;
            if (id === UUIDS.command) return this.commandCharacteristic;
            if (id === UUIDS.signal) return this.signalCharacteristic;
            if (id === UUIDS.wifi) return this.wifi;
            throw new Error('Unknown firmware characteristic.');
          } };
        } };
      },
      disconnect: () => {
        if (!this.device.gatt.connected) return;
        this.device.gatt.connected = false;
        this.device.dispatchEvent(new Event('gattserverdisconnected'));
        this.flush();
      },
    };
    this.bluetooth = { requestDevice: async () => { await this.ready; return this.device; } };
    this.ready = this.initialize();
    this.ready.catch((error) => { this.loadError = error.message; this.onChange(this.snapshot()); });
  }
  async initialize() {
    const base = new URL('./firmware/', location.href);
    const manifestResponse = await fetch(new URL('manifest.json', base));
    if (!manifestResponse.ok) {
      const details = await manifestResponse.json().catch(() => ({}));
      throw new Error(details.error || 'Firmware manifest unavailable. Run npm run firmware:build.');
    }
    this.manifest = await manifestResponse.json();
    const response = await fetch(new URL(`controller.wasm?v=${this.manifest.wasmHash}`, base));
    if (!response.ok) throw new Error('Compiled firmware unavailable. Run npm run firmware:build.');
    this.machine = await FirmwareMachine.create(await response.arrayBuffer(), { timedDemo: true });
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.machine.restore(JSON.parse(saved));
    } catch (error) {
      if (error.name === 'SecurityError' || error.name === 'QuotaExceededError') this.persistence = 'session';
      else throw error;
    }
    this.previousTime = performance.now();
    this.fractionalMs = 0;
    const frame = (time) => {
      if (this.disposed) return;
      const delta = Math.min(250, Math.max(0, time - this.previousTime));
      this.previousTime = time;
      if (!this.paused) {
        this.fractionalMs += delta * this.speed;
        const milliseconds = Math.floor(this.fractionalMs);
        this.fractionalMs -= milliseconds;
        this.machine.advance(milliseconds);
      }
      this.flush();
      this.frameId = requestAnimationFrame(frame);
    };
    this.flush();
    this.frameId = requestAnimationFrame(frame);
  }
  snapshot() {
    return {
      ...(this.machine ? this.machine.snapshot() : { engine: 'firmware', state: 'BOOTING', ready: false, powered: false, error: 'NONE' }),
      connected: this.device.gatt.connected, paused: this.paused, speed: this.speed,
      rssi: this.signal.rssi, signalAvailable: this.signal.available,
      ...(this.loadError ? { ready: false, state: 'LOAD_ERROR' } : {}),
      persistence: this.persistence, loadError: this.loadError,
      sourceHash: this.manifest?.sourceHash, events: this.events.slice(-100),
    };
  }
  persist(force = false) {
    if (!this.machine) return;
    const snapshot = this.machine.snapshot();
    if (!force && snapshot.saves === this.lastSaves && performance.now() - this.lastSavedAt < 500) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.machine.savedState())); }
    catch { this.persistence = 'session'; }
    this.lastSavedAt = performance.now();
    this.lastSaves = snapshot.saves;
  }
  flush() {
    if (!this.machine) return;
    const fresh = this.machine.traces();
    this.events.push(...fresh);
    if (this.events.length > 160) this.events.splice(0, this.events.length - 160);
    for (const event of fresh) {
      if (event.packet) {
        const packet = new DataView(Uint8Array.from(event.packet).buffer);
        this.lastSequence = packet.getUint32(6, true);
        this.statusCharacteristic.value = packet;
        if (this.device.gatt.connected) this.statusCharacteristic.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }
    this.persist();
    this.onChange(this.snapshot());
  }
  setup() { this.machine?.exports.sim_hold(650); this.flush(); }
  service() { this.machine?.exports.sim_hold(3200); this.flush(); }
  button(value) { this.machine?.exports.sim_button(value ? 1 : 0); this.flush(); }
  setSignal(value) { this.signal.setRssi(value); this.flush(); }
  setSignalAvailable(value) { this.signal.available = Boolean(value); this.flush(); }
  setObstructed(value) { const s = this.machine.snapshot(); this.machine.exports.sim_faults(value ? 1 : 0, s.sensorMode, s.failWrites ? 1 : 0); this.flush(); }
  setSensors(value) { const s = this.machine.snapshot(); this.machine.exports.sim_faults(s.obstructed ? 1 : 0, Number(value), s.failWrites ? 1 : 0); this.flush(); }
  setStorageFailure(value) { const s = this.machine.snapshot(); this.machine.exports.sim_faults(s.obstructed ? 1 : 0, s.sensorMode, value ? 1 : 0); this.flush(); }
  setTravel(value) { this.machine?.exports.sim_travel(Number(value)); this.flush(); }
  setPosition(value) { this.machine?.exports.sim_manual_position(Number(value)); this.flush(); }
  setCable(value) { this.machine?.exports.sim_cable(value ? 1 : 0); this.flush(); }
  corruptStorage() { this.machine?.exports.sim_corrupt(); this.persist(true); this.flush(); }
  power(value) {
    this.device.gatt.disconnect();
    this.machine?.exports.sim_power(value ? 1 : 0);
    this.lastSequence = null;
    this.persist(true);
    this.flush();
  }
  reboot() { this.power(false); this.power(true); }
  setSpeed(value) { this.speed = Math.min(4, Math.max(0.25, Number(value) || 1)); this.flush(); }
  setPaused(value) { this.paused = Boolean(value); this.flush(); }
  step(value = 20) { this.machine?.advance(Number(value)); this.flush(); }
  reset() {
    this.device.gatt.disconnect();
    this.signal = new SimulatedSignal();
    if (!this.machine || this.loadError) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Session-only storage. */ }
      location.reload();
      return;
    }
    this.events = [];
    this.machine.reset();
    this.lastSequence = null;
    this.paused = false;
    this.persist(true);
    this.flush();
  }
  dispose() {
    this.persist(true);
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.device.gatt.disconnect();
  }
}
