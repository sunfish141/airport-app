const KEY = 'carry.remembered-tag.v1';

// Retain the selected BluetoothDevice, never a boarding-pass credential. Restore
// only the exact browser device ID; a name match or first result isn't enough.
export class TagReconnect {
  constructor(connection, { bluetooth = globalThis.navigator?.bluetooth, storage = null, cancelOnHide = true, onState = () => {} } = {}) {
    Object.assign(this, { connection, bluetooth, storage, cancelOnHide, onState });
    this.device = null;
    this.saved = null;
    this.enabled = false;
    this.visible = true;
    this.active = false;
    this.epoch = 0;
    this.attempt = 0;
    this.state = 'idle';
    try {
      const saved = JSON.parse(storage?.getItem(KEY) || 'null');
      if (saved && typeof saved.id === 'string' && saved.id && typeof saved.name === 'string' && typeof saved.auto === 'boolean') {
        this.saved = { id: saved.id, name: saved.name, auto: saved.auto };
      }
    } catch { /* Storage is optional; same-page reconnection still works. */ }
  }
  get searching() { return ['restoring', 'waiting'].includes(this.state) || (this.state === 'connecting' && Boolean(this.device)); }
  get remembered() { return Boolean(this.device || this.saved); }
  get name() { return this.device?.name || this.saved?.name || 'your tag'; }
  setState(state) { this.state = state; this.onState(state); }
  persist() {
    if (this.saved) this.saved.auto = this.enabled;
    try {
      if (this.saved) this.storage?.setItem(KEY, JSON.stringify(this.saved));
      else this.storage?.removeItem(KEY);
    } catch { /* No dependency on local storage for operating the tag. */ }
  }
  cancelTimer() { ++this.epoch; clearTimeout(this.timer); }
  handleConnection(connected) {
    if (connected) {
      this.cancelTimer();
      this.device = this.connection.device;
      this.enabled = true;
      this.attempt = 0;
      this.saved = this.device?.id ? { id: this.device.id, name: this.device.name || 'Luggage tag', auto: true } : null;
      this.persist();
      this.setState('connected');
    } else if (this.enabled && !this.active) this.schedule();
  }
  async connect() {
    if (this.active || this.connection.connected) return;
    this.cancelTimer();
    this.active = true;
    // Remembered devices can reconnect directly. Without a device object the
    // user gesture must reach requestDevice before any asynchronous lookup.
    this.enabled = Boolean(this.device);
    this.setState('connecting');
    try { await this.connection.connect(this.device); }
    catch (error) { this.permissionFailure(error); throw error; }
    finally {
      this.active = false;
      if (!this.connection.connected) {
        if (this.enabled && this.device) this.schedule();
        else this.setState('idle');
      }
    }
  }
  schedule(immediate = false) {
    this.cancelTimer();
    if (!this.enabled || !this.device || this.connection.connected) return;
    if (!this.visible) { this.setState('paused'); return; }
    const epoch = this.epoch;
    const delay = immediate ? 0 : Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.setState('waiting');
    this.timer = setTimeout(async () => {
      if (epoch !== this.epoch || !this.enabled || !this.visible) return;
      this.active = true;
      this.setState('connecting');
      try { await this.connection.connect(this.device); }
      catch (error) { this.permissionFailure(error); }
      finally {
        this.active = false;
        if (!this.connection.connected && this.enabled && this.device) this.schedule();
      }
    }, delay);
  }
  async restore() {
    if (!this.visible || !this.saved?.auto || typeof this.bluetooth?.getDevices !== 'function') return;
    const epoch = this.epoch;
    this.setState('restoring');
    try {
      const devices = await this.bluetooth.getDevices();
      if (epoch !== this.epoch) return;
      this.device = devices.find((device) => device.id === this.saved?.id) || null;
      if (this.device) { this.enabled = true; this.schedule(true); }
      else this.setState('idle');
    } catch { if (epoch === this.epoch) this.setState('idle'); }
  }
  permissionFailure(error) {
    if (!['NotAllowedError', 'SecurityError'].includes(error.name)) return;
    this.enabled = false;
    this.device = null;
    this.persist();
    this.setState('idle');
  }
  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      this.cancelTimer();
      if (this.cancelOnHide && this.active && this.connection.connecting) this.connection.disconnect();
      if (this.state === 'restoring') this.setState('idle');
      if (this.enabled && !this.connection.connected) this.setState('paused');
    } else if (!this.active && this.enabled && !this.connection.connected && this.device) this.schedule(true);
    else if (!this.active && !this.device && this.saved?.auto && this.state !== 'restoring') void this.restore();
  }
  stop({ forget = false } = {}) {
    this.enabled = false;
    this.cancelTimer();
    if (forget) { this.device = null; this.saved = null; }
    this.persist();
    if (this.connection.connecting) this.connection.disconnect();
    this.setState(this.connection.connected ? 'connected' : 'idle');
  }
}
