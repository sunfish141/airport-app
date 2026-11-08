import { usableAccessPoints, validateLocation } from '../../app/src/location-protocol.js';

// The provider credential stays inside the Android plugin, never in JS.
export function createNativeLocationClient(plugin, requestId = () => crypto.randomUUID()) {
  return async (points, { signal } = {}) => {
    signal?.throwIfAborted();
    const id = requestId();
    const cancel = () => { void plugin.cancel({ id }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await plugin.locate({ id, wifiAccessPoints: usableAccessPoints(points) });
      signal?.throwIfAborted();
      return validateLocation(response);
    } finally { signal?.removeEventListener('abort', cancel); }
  };
}
