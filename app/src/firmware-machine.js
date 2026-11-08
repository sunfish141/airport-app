import { STATES, ERRORS } from './protocol.js';

// The decisions live in WebAssembly. This class only reads the C ABI and trace.
export class FirmwareMachine {
  static async create(bytes, { timedDemo = false } = {}) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new FirmwareMachine(instance.exports, { timedDemo });
  }
  constructor(exports, { timedDemo = false } = {}) {
    this.exports = exports;
    exports._initialize();
    this.traceCursor = 0;
    this.reset();
    if (timedDemo) { exports.sim_mode(1); this.advance(50); }
  }
  reset() { this.exports.sim_reset(); this.traceCursor = 0; this.advance(50); }
  advance(ms) { this.exports.sim_advance(Math.max(0, Math.min(60000, Math.floor(ms)))); }
  get packet() {
    return new DataView(new Uint8Array(this.exports.memory.buffer, this.exports.sim_status_ptr(), 12).slice().buffer);
  }
  command(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Command must be raw bytes.');
    new Uint8Array(this.exports.memory.buffer, this.exports.sim_command_ptr(), Math.min(bytes.length, 64)).set(bytes.subarray(0, 64));
    return Boolean(this.exports.sim_command(bytes.length));
  }
  get record() { return Array.from(new Uint8Array(this.exports.memory.buffer, this.exports.sim_record_ptr(), 28)); }
  restore(saved) {
    if (!saved || saved.schema !== 1 || !Array.isArray(saved.record) || saved.record.length !== 28 || !saved.record.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) || !Number.isFinite(saved.position) || saved.position < 0 || saved.position > 1) {
      throw new Error('Saved firmware simulation is invalid. Clear its saved state before retrying.');
    }
    new Uint8Array(this.exports.memory.buffer, this.exports.sim_record_ptr(), 28).set(saved.record);
    this.traceCursor = this.exports.sim_trace_count();
    this.exports.sim_restore(saved.present ? 1 : 0, saved.position, saved.cable ? 1 : 0);
    this.advance(50);
  }
  savedState() {
    const snapshot = this.snapshot();
    return { schema: 1, present: snapshot.nvsState !== 'Missing', record: this.record, position: snapshot.position, cable: snapshot.cable };
  }
  snapshot() {
    const value = (key) => this.exports.sim_value(key);
    return {
      engine: 'firmware', state: !value(17) ? 'POWER_OFF' : !value(16) ? 'BOOTING' : STATES[value(0)], error: ERRORS[value(1)],
      timedDemo: Boolean(this.exports.sim_config(13)),
      assigned: Boolean(value(2)), rawOpen: Boolean(value(3)), rawClosed: Boolean(value(4)),
      open: Boolean(value(5)), closed: Boolean(value(6)), button: Boolean(value(7)), buttonDebounced: Boolean(value(8)),
      pwm: Boolean(value(9)), pulseUs: value(10), commandPulseUs: value(30), pending: ['None', 'Open', 'Close'][value(11)],
      storedAssigned: value(12), storedPending: ['None', 'Open', 'Close'][value(13)] || 'Unknown',
      faultLatched: Boolean(value(14)), nvsState: ['Missing', 'Valid', 'Corrupt'][value(15)],
      ready: Boolean(value(16)), powered: Boolean(value(17)), led: Boolean(value(18)),
      uptimeMs: value(19) >>> 0, worldMs: value(20) >>> 0, saves: value(21), cable: Boolean(value(22)),
      sensorMode: value(23), failWrites: Boolean(value(24)), obstructed: Boolean(value(25)),
      buttonHeldMs: value(26), flashing: Boolean(value(27)), travelMs: value(28), storedFault: value(29),
      position: this.exports.sim_position(), setupMs: this.packet.getUint16(4, true),
      constants: {
        debounceMs: this.exports.sim_config(0), setupHoldMs: this.exports.sim_config(1), serviceHoldMs: this.exports.sim_config(2),
        setupWindowMs: this.exports.sim_config(3), timeoutMs: this.exports.sim_config(4),
        openPulseUs: this.exports.sim_config(5), closedPulseUs: this.exports.sim_config(6),
        servoPin: this.exports.sim_config(7), openPin: this.exports.sim_config(8), closedPin: this.exports.sim_config(9),
        buttonPin: this.exports.sim_config(10), ledPin: this.exports.sim_config(11), servoHz: this.exports.sim_config(12),
        timedDemo: Boolean(this.exports.sim_config(13)), demoMovementMs: this.exports.sim_config(14), demoSweepMs: this.exports.sim_config(15),
      },
    };
  }
  traces() {
    const end = this.exports.sim_trace_count() >>> 0;
    const items = [];
    for (let id = Math.max(this.traceCursor + 1, end - 255); id <= end; id++) {
      const view = new DataView(this.exports.memory.buffer, this.exports.sim_trace_ptr(id), 20);
      if (view.getUint32(0, true) === id) {
        const event = { id, ms: view.getUint32(4, true), code: view.getUint32(8, true), a: view.getUint32(12, true), b: view.getUint32(16, true) };
        if (event.code === 5) event.packet = Array.from(new Uint8Array(this.exports.memory.buffer, this.exports.sim_trace_status_ptr(id), 12));
        items.push(event);
      }
    }
    this.traceCursor = end;
    return items;
  }
}

export function describeTrace(event, constants) {
  const direction = ['None', 'Open', 'Close'];
  if (constants?.timedDemo) {
    return [{
      0: 'BOOT',
      1: `NVS assigned=${event.a & 1} pending=${direction[event.b]} fault=${Number(Boolean(event.a & 2))}`,
      2: 'NVS WRITE_FAILED',
      3: `PWM start=${event.a}us target=${direction[event.b]}`,
      4: 'PWM OFF',
      5: `STATE ${STATES[event.a]} error=${ERRORS[event.b]}`,
      6: `GPIO${constants.buttonPin} raw=${event.a & 4 ? 'LOW' : 'HIGH'}`,
      7: `GPIO${constants.buttonPin} debounced=${event.a & 4 ? 'LOW' : 'HIGH'}`,
      8: `BUTTON ${event.a ? 'DOWN' : 'UP'}`,
      9: `POWER ${event.a ? 'ON' : 'OFF'}`,
      10: `RX ${event.a ? String.fromCharCode(event.a) : 'EMPTY'} bytes=${event.b}`,
      11: 'QUEUE OVERFLOW',
      13: 'NVS CRC_CORRUPTED',
    }[event.code] || `EVENT ${event.code}`, 'Simulator.cpp'];
  }
  const flags = (n) => `open=${n & 1 ? 'LOW' : 'HIGH'}, closed=${n & 2 ? 'LOW' : 'HIGH'}, button=${n & 4 ? 'LOW' : 'HIGH'}`;
  return {
    0: ['Boot: PWM off; debounce inputs before NVS reconciliation', 'main.cpp → setup'],
    1: [`NVS committed: ${event.a & 1 ? 'assigned' : 'free'}, pending ${direction[event.b]}, fault=${Boolean(event.a & 2)}`, 'Controller → Hardware::save'],
    2: ['NVS write failed; previous blob unchanged', 'Hardware::save → false'],
    3: [`PWM enabled: ${event.a} µs${constants ? ` at ${constants.servoHz} Hz` : ''}; target ${direction[event.b]}`, 'Controller::move → Hardware::drive'],
    4: ['PWM detached', 'Hardware::stop'],
    5: [`Status: ${STATES[event.a]} · ${ERRORS[event.b]}`, 'Hardware::publish → encodeStatus'],
    6: [`Raw GPIO: ${flags(event.a)}`, 'Simulated microswitch contacts'],
    7: [`Debounced: ${flags(event.a)}`, 'Production DebouncedInput::update'],
    8: [`Physical button ${event.a ? 'pressed' : 'released'}`, constants ? `Simulated GPIO${constants.buttonPin}` : 'Simulated button input'],
    9: [`Main power ${event.a ? 'ON' : 'OFF'}`, 'Simulated supply switch'],
    10: [`Command ${event.a ? String.fromCharCode(event.a) : '(empty)'} · ${event.b} bytes`, 'Queue → Controller::command'],
    11: ['Command queue overflow', 'Controller::rejectBusy'],
    12: [event.a === 2 ? 'Cable held by bolt; removal blocked by geometry' : `Cable eyelet ${event.a ? 'inserted' : 'removed'}`, 'Illustrative mechanical model'],
    13: ['Stored record CRC corrupted for recovery test', 'Simulated flash fault'],
  }[event.code] || ['Unknown event', 'Simulator'];
}
