import { normalizeToken } from './protocol.js';

// Keep a scan in memory while the user presses the physical setup button.
// Consumption is one-shot; expired or cancelled scans cannot actuate later.
export class LockIntent {
  constructor() { this.clear(); }
  queue(token, now) { this.token = normalizeToken(token); this.expiresAt = now + 30000; }
  get pending() { return this.token !== null; }
  clear() { this.token = null; this.expiresAt = 0; }
  expired(now) { return this.pending && now >= this.expiresAt; }
  take(status, setupMs, now) {
    if (!this.pending) return null;
    if (this.expired(now) || status?.state !== 'OPEN_FREE' || status.assigned) { this.clear(); return null; }
    if (setupMs <= 0) return null;
    const token = this.token;
    this.clear();
    return token;
  }
}
