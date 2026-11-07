export const WIFI_STATES = ['idle', 'scanning', 'ready', 'failed', 'busy'];
export const MAX_ACCESS_POINTS = 12;

export function usableAccessPoints(points) {
  if (!Array.isArray(points) || points.length > MAX_ACCESS_POINTS) throw new Error('Invalid Wi-Fi scan.');
  const unique = new Map();
  for (const point of points) {
    const mac = point.macAddress;
    const rssi = point.signalStrength;
    const channel = point.channel;
    if (typeof mac !== 'string' || !/^([\da-f]{2}:){5}[\da-f]{2}$/i.test(mac)
      || !Number.isInteger(rssi) || rssi < -100 || rssi > -10
      || !Number.isInteger(channel) || channel < 1 || channel > 14) throw new Error('Invalid Wi-Fi access point.');
    const normalized = mac.toLowerCase();
    const first = parseInt(normalized.slice(0, 2), 16);
    if ((first & 3) || normalized === '00:00:00:00:00:00' || normalized.startsWith('00:00:5e:')) continue;
    const previous = unique.get(normalized);
    if (!previous || previous.signalStrength < rssi) unique.set(normalized, { macAddress: normalized, signalStrength: rssi, channel });
  }
  return [...unique.values()].sort((a, b) => b.signalStrength - a.signalStrength);
}
export function decodeWifiScan(value) {
  const view = value instanceof DataView ? value : new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (view.byteLength < 6 || view.getUint8(0) !== 1 || view.getUint8(5) !== 0) throw new Error('Unsupported Wi-Fi scan packet.');
  const state = WIFI_STATES[view.getUint8(1)];
  const count = view.getUint8(4);
  if (!state || count > MAX_ACCESS_POINTS || view.byteLength !== 6 + count * 8 || (state !== 'ready' && count !== 0)) throw new Error('Invalid Wi-Fi scan packet.');
  const points = [];
  for (let i = 0; i < count; ++i) {
    const offset = 6 + i * 8;
    const macAddress = Array.from({ length: 6 }, (_, j) => view.getUint8(offset + j).toString(16).padStart(2, '0')).join(':');
    points.push({ macAddress, signalStrength: view.getInt8(offset + 6), channel: view.getUint8(offset + 7) });
  }
  return { state, request: view.getUint16(2, true), accessPoints: usableAccessPoints(points) };
}
export function validateLocation(result) {
  const { lat, lng } = result?.location || {};
  const accuracy = result?.accuracy;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90
    || typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180
    || typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0) throw new Error('The location service returned an invalid estimate.');
  return { location: { lat, lng }, accuracy };
}
