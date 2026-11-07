import { usableAccessPoints, validateLocation } from './location-protocol.js';

// Each lookup belongs to one live BLE session. Closing, backgrounding or
// disconnecting invalidates late radio/network results; nothing is persisted.
export class TagLocation {
  constructor(connection, { locate, onChange = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { connection, locate, onChange, now });
    this.state = 'idle';
    this.result = null;
    this.message = '';
    this.epoch = 0;
  }
  get busy() { return ['scanning', 'locating'].includes(this.state); }
  update(state, message = '') { this.state = state; this.message = message; this.onChange(); }
  clear() {
    ++this.epoch; this.abort?.abort(); this.abort = null; this.result = null;
    this.update('idle');
  }
  async refresh() {
    if (this.busy) return;
    this.clear();
    if (!this.connection.connected) { this.update('error', 'Connect to your tag first.'); return; }
    if (!this.locate) { this.update('error', 'Location lookup is unavailable. Bluetooth signal search still works.'); return; }
    const epoch = this.epoch;
    const session = this.connection.session;
    const abort = this.abort = new AbortController();
    const current = () => epoch === this.epoch && session === this.connection.session && this.connection.connected && !abort.signal.aborted;
    let timeout;
    this.update('scanning', 'Scanning nearby Wi-Fi…');
    try {
      const accessPoints = usableAccessPoints(await this.connection.scanWifi({ signal: abort.signal }));
      if (!current()) return;
      if (accessPoints.length < 2) throw new Error('Not enough usable Wi-Fi networks for a location estimate.');
      this.update('locating', 'Estimating the tag’s location…');
      timeout = setTimeout(() => abort.abort(new Error('Location lookup timed out. Try again.')), 10000);
      const response = await Promise.race([
        this.locate(accessPoints, { signal: abort.signal }),
        new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })),
      ]);
      if (!current()) return;
      this.result = { ...validateLocation(response), at: this.now() };
      this.update('ready');
    } catch (error) {
      if (epoch !== this.epoch || session !== this.connection.session || !this.connection.connected) return;
      this.update('error', error.message || 'Location unavailable. Try again.');
    } finally { clearTimeout(timeout); if (this.abort === abort) this.abort = null; }
  }
}

export function createLocationClient(endpoint, { fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint) return null;
  const url = new URL(endpoint, globalThis.location?.href);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS for the location service.');
  }
  return async (accessPoints, { signal } = {}) => {
    const response = await fetchImpl(url.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wifiAccessPoints: usableAccessPoints(accessPoints) }), signal,
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'These Wi-Fi networks could not be located.' : 'Location service unavailable. Try again.');
    return validateLocation(await response.json());
  };
}
