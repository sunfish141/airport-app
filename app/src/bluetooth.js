import { UUIDS, decodeStatus, encodeCommand, isNewer } from './protocol.js';

export class TagConnection {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, onStatus = () => {}, onConnection = () => {} } = {}) {
    Object.assign(this, { bluetooth, onStatus, onConnection });
    this.device = null;
    this.status = null;
    this.pending = null;
    this.connecting = false;
    this.session = 0;
    this.handleValue = (event) => this.accept(event.target.value);
    this.handleDisconnect = () => this.cleanup('Tag disconnected. Reconnect to read its confirmed state.');
  }

  get connected() { return Boolean(this.device?.gatt.connected && this.commandCharacteristic); }

  async connect() {
    if (this.connecting || this.connected) return;
    if (!globalThis.isSecureContext) throw new Error('Open this app over HTTPS to use Bluetooth.');
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable. Use Android Chrome.');
    this.connecting = true;
    const session = ++this.session;
    try {
      // requestDevice runs directly within the Connect click gesture, before any await.
      const device = await this.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] });
      if (session !== this.session) throw new Error('Connection cancelled.');
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(UUIDS.service);
      this.commandCharacteristic = await service.getCharacteristic(UUIDS.command);
      this.statusCharacteristic = await service.getCharacteristic(UUIDS.status);
      this.statusCharacteristic.addEventListener('characteristicvaluechanged', this.handleValue);
      await this.statusCharacteristic.startNotifications();
      this.accept(await this.statusCharacteristic.readValue());
      if (!this.connected || session !== this.session) throw new Error('Connection interrupted.');
      this.onConnection(true, device.name || 'Luggage tag');
    } catch (error) {
      this.disconnect();
      throw error;
    } finally { this.connecting = false; }
  }

  accept(value) {
    let status;
    try { status = decodeStatus(value); }
    catch (error) { this.cleanup(error.message); return; }
    if (this.status && !isNewer(status.sequence, this.status.sequence)) return;
    this.status = status;
    this.onStatus(status);
    const pending = this.pending;
    if (!pending || !isNewer(status.sequence, pending.baseline)) return;
    if (status.command === 'S' && pending.opcode !== 'F') {
      return this.settle(new Error('Service opening interrupted this command. Check the confirmed tag state.'));
    }
    if (status.command !== pending.opcode) return;
    if (status.error !== 'NONE') return this.settle(new Error(errorMessage(status.error)));
    const target = { L: 'LOCKED_ASSIGNED', U: 'OPEN_FREE', C: 'CLOSED_FREE' }[pending.opcode];
    if (pending.opcode === 'F' || status.state === target) this.settle(null, status);
  }

  send(opcode, token) {
    if (!this.connected || !this.status) return Promise.reject(new Error('Connect to a tag first.'));
    if (this.pending) return Promise.reject(new Error('Wait for the current command to finish.'));
    const bytes = encodeCommand(opcode, token);
    return new Promise((resolve, reject) => {
      const pending = { opcode, baseline: this.status.sequence, resolve, reject };
      this.pending = pending;
      pending.timer = setTimeout(() => {
        this.settle(new Error('No confirmed result received. Reconnect and check the tag before trying again.'));
        this.disconnect();
      }, 5000);
      // A GATT write acknowledgement is transport delivery, not movement success.
      Promise.resolve().then(() => this.commandCharacteristic.writeValueWithResponse(bytes)).catch((error) => {
        if (this.pending === pending) this.settle(error);
      });
    });
  }

  settle(error, status) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(status);
  }

  cleanup(message) {
    ++this.session;
    this.settle(new Error(message));
    this.statusCharacteristic?.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
    this.commandCharacteristic = null;
    this.statusCharacteristic = null;
    this.status = null;
    this.device = null;
    this.onConnection(false, message);
  }

  disconnect() { this.cleanup('Disconnected. Connect to read the current tag state.'); }
}

export function errorMessage(code) {
  return {
    MALFORMED: 'The tag rejected the command format.', UNKNOWN_COMMAND: 'The tag does not support this command.',
    BUSY: 'The bolt is moving. Wait for its confirmed position.', ASSIGNED: 'This tag already has an assignment.',
    NOT_OPEN: 'The bolt must be confirmed open first.', SETUP_REQUIRED: 'Hold the tag button briefly, then release to start setup.',
    UNASSIGNED: 'This tag has no assignment. Hold its button for 3 seconds to open it.',
    TOKEN_MISMATCH: 'This pass does not match the tag. The assignment is unchanged.',
    TIMEOUT: 'Movement timed out. Check the mechanism and use the service button to recover.',
    SENSOR_CONFLICT: 'Both position switches are active. Check the mechanism before service recovery.',
    RECOVERY_REQUIRED: 'The tag needs service recovery. Hold its button for 3 seconds.',
    STORAGE: 'The tag could not save its state. Check firmware storage before recovery.',
    ACTUATOR: 'The servo could not start. Check the firmware configuration.',
  }[code] || 'The tag reported an error.';
}
