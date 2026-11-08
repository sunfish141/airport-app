import './emulator.css';

const $ = (id) => document.getElementById(id);
const frame = $('app-frame');
let rotated = false;
let snapshot;
const labels = { OPEN_FREE: 'Open & ready', CLOSED_FREE: 'Closed for storage', LOCKED_ASSIGNED: 'Locked & assigned', MOVING: 'Bolt is moving', FAULT: 'Service needed' };

function send(action, value) {
  frame.contentWindow.postMessage({ type: 'carry-demo-action', action, value }, location.origin);
}
function fitPhone() {
  const selected = $('device-size').value.split(',').map(Number);
  const [width, height] = rotated ? selected.reverse() : selected;
  const bezel = 24;
  const availableWidth = Math.max(180, $('device-stage').clientWidth - 32);
  const availableHeight = Math.max(360, window.innerHeight - 240);
  const scale = Math.min(1, availableWidth / (width + bezel), availableHeight / (height + bezel));
  Object.assign(frame.style, { width: `${width}px`, height: `${height}px` });
  Object.assign($('phone').style, { width: `${width + bezel}px`, height: `${height + bezel}px`, transform: `scale(${scale})` });
  Object.assign($('phone-scale').style, { width: `${(width + bezel) * scale}px`, height: `${(height + bezel) * scale}px` });
  $('viewport-size').textContent = `${width} × ${height}`;
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'carry-demo-status') return;
  snapshot = event.data.status;
  $('virtual-state').textContent = labels[snapshot.state] || 'Waiting for app';
  $('virtual-connection').textContent = `${snapshot.connected ? 'Connected' : 'Disconnected'} · ${snapshot.assigned ? 'Pass assigned' : 'No assignment'}`;
  $('tag-status-dot').className = snapshot.state === 'FAULT' ? 'fault' : '';
  $('demo-connect').textContent = snapshot.connected ? 'Disconnect virtual tag' : 'Connect virtual tag';
  $('demo-setup').disabled = snapshot.state !== 'OPEN_FREE';
  $('obstruction').checked = Boolean(snapshot.obstructed);
  if (document.activeElement !== $('signal-level')) $('signal-level').value = String(snapshot.rssi);
  $('signal-output').textContent = `${snapshot.rssi} dBm`;
  $('signal-missing').checked = !snapshot.signalAvailable;
});
$('demo-connect').addEventListener('click', () => send(snapshot?.connected ? 'disconnect' : 'connect'));
$('demo-setup').addEventListener('click', () => send('setup'));
$('demo-service').addEventListener('click', () => send('service'));
$('demo-reboot').addEventListener('click', () => send('reboot'));
$('demo-reset').addEventListener('click', () => send('reset'));
$('obstruction').addEventListener('change', (event) => send('obstruction', event.target.checked));
$('signal-level').addEventListener('input', (event) => send('signal', Number(event.target.value)));
$('signal-missing').addEventListener('change', (event) => send('signal-available', !event.target.checked));
$('device-size').addEventListener('change', fitPhone);
$('rotate').addEventListener('click', () => { rotated = !rotated; fitPhone(); });
frame.addEventListener('load', () => send('status'));
new ResizeObserver(fitPhone).observe($('device-stage'));
window.addEventListener('resize', fitPhone);
fitPhone();
