import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { usableAccessPoints, validateLocation } from '../src/location-protocol.js';

// Development relay: listen on loopback only. Keep the provider key off the
// phone/firmware. A deployed service must supply its own user authentication.
export function locationHandler({ apiKey, fetchImpl = fetch, now = Date.now } = {}) {
  let lastCall = -Infinity;
  let active = false;
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    const send = (status, body) => { response.writeHead(status); response.end(JSON.stringify(body)); };
    if (request.url !== '/geolocate') return send(404, { error: 'Not found' });
    if (request.method !== 'POST') return send(405, { error: 'Use POST' });
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Use JSON' });
    if (!apiKey) return send(503, { error: 'Location service is not configured' });
    let points;
    try {
      let body = '';
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) return send(413, { error: 'Request too large' });
        body += chunk.toString();
      }
      const payload = JSON.parse(body);
      if (!payload || Object.keys(payload).length !== 1 || !('wifiAccessPoints' in payload)) throw new Error();
      points = usableAccessPoints(payload.wifiAccessPoints);
      if (points.length < 2) throw new Error();
    } catch { return send(400, { error: 'Provide at least two usable Wi-Fi access points' }); }
    if (active || now() - lastCall < 10000) return send(429, { error: 'Wait before updating again' });
    active = true; lastCall = now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    const closed = () => { if (!response.writableEnded) abort.abort(); };
    response.on('close', closed);
    try {
      const upstream = await fetchImpl(`https://www.googleapis.com/geolocation/v1/geolocate?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Never substitute the phone/relay IP address for the tag's position.
        body: JSON.stringify({ considerIp: false, wifiAccessPoints: points }), signal: abort.signal,
      });
      if (!upstream.ok) return send(upstream.status === 404 ? 404 : 502, { error: 'Location unavailable' });
      send(200, validateLocation(await upstream.json()));
    } catch { if (!response.destroyed) send(502, { error: 'Location unavailable' }); }
    finally { clearTimeout(timer); response.removeListener('close', closed); active = false; }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GOOGLE_GEOLOCATION_API_KEY) {
    console.error('Set GOOGLE_GEOLOCATION_API_KEY before starting the location relay.');
    process.exitCode = 1;
  } else createServer(locationHandler({ apiKey: process.env.GOOGLE_GEOLOCATION_API_KEY }))
    .listen(8787, '127.0.0.1', () => console.log('Location relay: http://127.0.0.1:8787/geolocate (loopback only)'));
}
