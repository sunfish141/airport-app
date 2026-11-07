const STALE_MS = 5000;
const BOUNDARIES = [-90, -78, -60];
const LABELS = ['Very weak signal', 'Weak signal', 'Medium signal', 'Strong signal'];

// RSSI is an indication of link strength, not a distance measurement. Median
// filtering rejects isolated spikes; smoothing and hysteresis reduce flicker.
export class Proximity {
  constructor() { this.reset(); }
  reset() { this.samples = []; this.history = []; this.filtered = null; this.band = null; this.lastAt = null; }
  add(rssi, now) {
    if (!Number.isInteger(rssi) || rssi < -127 || rssi > 20 || !Number.isFinite(now)) return;
    if (this.lastAt !== null && now <= this.lastAt) return;
    if (this.lastAt !== null && now - this.lastAt >= STALE_MS) this.reset();
    this.lastAt = now;
    this.samples.push(rssi);
    this.samples = this.samples.slice(-5);
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Don't seed the filter from one potentially spurious reading.
    if (this.samples.length < 3) return;
    this.filtered = this.filtered === null ? median : this.filtered * 0.55 + median * 0.45;
    if (this.band === null) this.band = BOUNDARIES.filter((limit) => this.filtered >= limit).length;
    else {
      while (this.band < 3 && this.filtered >= BOUNDARIES[this.band] + 3) ++this.band;
      while (this.band > 0 && this.filtered < BOUNDARIES[this.band - 1] - 3) --this.band;
    }
    this.history.push({ at: now, rssi: this.filtered });
    this.history = this.history.filter((sample) => now - sample.at <= 6000);
  }
  snapshot(now) {
    if (this.lastAt === null) return { state: 'waiting', bars: 0, rssi: null, trend: '' };
    const age = now - this.lastAt;
    if (age >= STALE_MS) return { state: 'stale', bars: 0, rssi: null, trend: '', age };
    if (this.filtered === null) return { state: 'collecting', bars: 0, rssi: null, trend: '', age };
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)];
    const deviations = sorted.map((n) => Math.abs(n - middle)).sort((a, b) => a - b);
    const fluctuating = deviations[Math.floor(deviations.length / 2)] > 6;
    const baseline = this.history.find((sample) => this.lastAt - sample.at >= 4000);
    const change = baseline ? this.filtered - baseline.rssi : 0;
    const trend = fluctuating ? 'Signal fluctuating' : change >= 5 ? 'Getting stronger' : change <= -5 ? 'Getting weaker' : 'Steady signal';
    return { state: 'live', bars: this.band + 1, label: LABELS[this.band], rssi: Math.round(this.filtered), trend, age };
  }
}
