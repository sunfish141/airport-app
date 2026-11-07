import { UUIDS, decodeStatus, decodeSignal, encodeCommand, isNewer } from './protocol.js';

export class TagConnection {
  constructor({ bluetooth = globalThis.navigator?.bluetooth, requireSecureContext = true, onStatus = () => {}, onConnection = () => {} } = {}) {
    Object.assign(this, { bluetooth, requireSecureContext, onStatus, onConnection });
    this.device = null;
    this.status = null;
    this.pending = null;
    this.connecting = false;
    this.session = 0;
    this.gattTail = Promise.resolve();
    this.handleValue = (event) => { if (event.target === this.statusCharacteristic) this.accept(event.target.value); };
    this.handleDisconnect = () => this.cleanup('Tag disconnected. Reconnect to read its confirmed state.');
  }

  get connected() { return Boolean(this.device?.gatt.connected && this.commandCharacteristic); }

  async connect(knownDevice = null) {
    if (this.connecting || this.connected) return;
    if (this.requireSecureContext && !globalThis.isSecureContext) throw new Error('Open this app over HTTPS to use Bluetooth.');
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable. Use Android Chrome.');
    this.connecting = true;
    const session = ++this.session;
    let timer;
    let abort;
    try {
      // requestDevice runs directly within the Connect click gesture, before any await.
      const device = await (knownDevice || this.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }] }));
      if (session !== this.session) throw new Error('Connection cancelled.');
      this.device = device;
      const cancelled = new Promise((_, reject) => { abort = () => reject(new Error('Connection interrupted.')); });
      this.abortConnect = abort;
      // The chooser has no deadline; only the connection handshake is bounded.
      timer = setTimeout(() => { if (session === this.session) this.cleanup('Connection timed out. Keep the tag nearby.'); }, 10000);
      const checkSession = () => { if (session !== this.session) throw new Error('Connection interrupted.'); };
      const step = async (request) => {
        const value = await Promise.race([request, cancelled]);
        checkSession();
        return value;
      };
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      const server = await step(device.gatt.connect());
      checkSession();
      const service = await step(server.getPrimaryService(UUIDS.service));
      checkSession();
      this.service = service;
      this.signalCharacteristic = undefined;
      const commandCharacteristic = await step(service.getCharacteristic(UUIDS.command));
      checkSession();
      this.commandCharacteristic = commandCharacteristic;
      const statusCharacteristic = await step(service.getCharacteristic(UUIDS.status));
      checkSession();
      this.statusCharacteristic = statusCharacteristic;
      this.statusCharacteristic.addEventListener('characteristicvaluechanged', this.handleValue);
      await step(this.statusCharacteristic.startNotifications());
      checkSession();
      const status = await step(this.statusCharacteristic.readValue());
      checkSession();
      this.accept(status);
      if (!this.connected || session !== this.session) throw new Error('Connection interrupted.');
      this.onConnection(true, device.name || 'Luggage tag');
    } catch (error) {
      if (session === this.session) this.disconnect();
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abortConnect === abort) this.abortConnect = null;
      this.connecting = false;
    }
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
    if (status.error !== 'NONE') {
      const error = new Error(errorMessage(status.error));
      error.code = status.error;
      return this.settle(error);
    }
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
      this.performGatt(() => {
        if (this.pending !== pending) return; // Service recovery may have cancelled a queued request.
        return this.commandCharacteristic.writeValueWithResponse(bytes);
      }).catch((error) => {
        if (this.pending === pending) this.settle(error);
      });
    });
  }

  // Serialize reads and writes: Web Bluetooth can reject overlapping GATT
  // operations. Proximity reads are skipped whenever an actuator command waits.
  performGatt(operation, timeoutMs = 0) {
    const session = this.session;
    const task = this.gattTail.then(async () => {
      if (session !== this.session || !this.connected) throw new Error('Tag disconnected.');
      let timer;
      try {
        const result = await (timeoutMs ? Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => { timer = setTimeout(() => {
            if (session === this.session) this.cleanup('Bluetooth read timed out. Reconnect to continue.');
            reject(new Error('Bluetooth read timed out.'));
          }, timeoutMs); }),
        ]) : operation());
        if (session !== this.session) throw new Error('Tag disconnected.');
        return result;
      } finally { clearTimeout(timer); }
    });
    this.gattTail = task.catch(() => {});
    return task;
  }

  readSignal() {
    if (!this.connected) return Promise.reject(new Error('Connect to a tag first.'));
    if (this.pending) return Promise.resolve(null);
    const session = this.session;
    const service = this.service;
    return this.performGatt(async () => {
      if (this.pending) return null;
      if (this.signalCharacteristic === undefined) {
        let characteristic;
        try { characteristic = await service.getCharacteristic(UUIDS.signal); }
        catch (error) {
          if (error.name !== 'NotFoundError') throw error;
          characteristic = null;
        }
        if (session !== this.session) throw new Error('Tag disconnected.');
        this.signalCharacteristic = characteristic;
      }
      if (!this.signalCharacteristic || typeof this.signalCharacteristic.readValue !== 'function') return { supported: false };
      return { supported: true, rssi: decodeSignal(await this.signalCharacteristic.readValue()) };
    }, 2500);
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
    this.abortConnect?.();
    this.abortConnect = null;
    this.settle(new Error(message));
    this.statusCharacteristic?.removeEventListener('characteristicvaluechanged', this.handleValue);
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device?.gatt.disconnect();
    this.commandCharacteristic = null;
    this.statusCharacteristic = null;
    this.service = null;
    this.signalCharacteristic = undefined;
    this.gattTail = Promise.resolve();
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
