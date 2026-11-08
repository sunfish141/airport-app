import { describeTrace } from './firmware-machine.js';
import './workbench.css';

const $ = (id) => document.getElementById(id);
const phone = $('firmware-phone');
const send = (action, value) => phone.contentWindow.postMessage({ type: 'carry-demo-action', action, value }, location.origin);
const setText = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
let current;
let lastTrace = '';
let clearedThrough = 0;

function renderTrace(events = []) {
  // Retain only the installed GPIO27 input, not the adapter's legacy contacts.
  let rawButton, stableButton;
  const visible = events.filter((event) => {
    if (event.id <= clearedThrough || event.code === 12) return false;
    if (event.code === 6 || event.code === 7) {
      const pressed = Boolean(event.a & 4);
      const previous = event.code === 6 ? rawButton : stableButton;
      if (event.code === 6) rawButton = pressed;
      else stableButton = pressed;
      return previous !== undefined && pressed !== previous;
    }
    return true;
  });
  const key = `${visible[0]?.id}:${visible.at(-1)?.id}`;
  if (key === lastTrace) return;
  lastTrace = key;
  const nodes = visible.slice().reverse().map((event) => {
    const [message] = describeTrace(event, current?.constants);
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = `${(event.ms / 1000).toFixed(3)} s`;
    const detail = document.createElement('code');
    detail.textContent = message;
    item.append(time, detail);
    return item;
  });
  $('trace').replaceChildren(...nodes);
}

function render(s) {
  current = s;
  $('load-error').hidden = !s.loadError;
  if (s.loadError) setText('load-error', `${s.loadError} Reset simulation to retry.`);
  setText('engine-state', s.state || 'Loading WASM…');
  $('engine-state').classList.toggle('fault', s.state === 'FAULT');
  setText('engine-error', s.error || '—');
  $('engine-error').classList.toggle('fault', Boolean(s.error && s.error !== 'NONE'));
  setText('sim-time', `${((s.worldMs || 0) / 1000).toFixed(2)} s`);
  setText('pause-sim', s.paused ? 'Resume' : 'Pause');
  $('step-sim').disabled = !s.paused;
  if (!s.constants) return;
  const enabled = s.ready && s.powered;
  for (const id of ['physical-button', 'service-hold', 'reboot-tag', 'connect-firmware']) $(id).disabled = !enabled;
  $('main-power').disabled = false;
  setText('main-power', s.powered ? 'Power off' : 'Power on');
  setText('connect-firmware', s.connected ? 'Disconnect' : 'Connect');
  setText('phone-connection', `BLE: ${s.connected ? 'connected' : 'disconnected'}`);
  setText('servo-pin', `GPIO${s.constants.servoPin}`);
  setText('button-pin', `GPIO${s.constants.buttonPin}`);
  setText('diagram-servo-pin', `GPIO${s.constants.servoPin}`);
  setText('diagram-button-pin', `GPIO${s.constants.buttonPin}`);
  setText('diagram-button-state', s.button ? 'LOW' : 'HIGH');
  $('diagram-button').classList.toggle('pressed', s.button);
  setText('diagram-pwm-state', s.pwm ? 'PWM active' : 'PWM off');
  $('diagram-pwm').classList.toggle('active', s.pwm);
  for (const id of ['diagram-board', 'diagram-servo', 'diagram-regulator', 'diagram-supply', 'diagram-usb', 'diagram-pwm']) $(id).style.opacity = s.powered ? '1' : '.35';
  const angle = Math.max(0, Math.min(180, 180 * (s.commandPulseUs - s.constants.openPulseUs) / (s.constants.closedPulseUs - s.constants.openPulseUs)));
  // Slider-crank illustration: keep the rod length fixed as the horn rotates.
  const radians = angle * Math.PI / 180;
  const crankX = 300 - 42 * Math.cos(radians);
  const crankY = 160 - 42 * Math.sin(radians);
  const sliderX = crankX + Math.sqrt(200 ** 2 - (160 - crankY) ** 2);
  $('servo-horn').setAttribute('transform', `rotate(${angle} 300 160)`);
  $('servo-horn').style.opacity = s.powered ? '1' : '.35';
  $('latch-linkage').setAttribute('x1', crankX);
  $('latch-linkage').setAttribute('y1', crankY);
  $('latch-linkage').setAttribute('x2', sliderX);
  $('latch-bolt').setAttribute('transform', `translate(${sliderX} 0)`);
  $('latch-joint').setAttribute('cx', sliderX);
  $('latch-receiver').classList.toggle('engaged', angle >= 179);
  setText('latch-command', `Latch: ${angle <= 1 ? 'retracted' : angle >= 179 ? 'extended' : 'moving'}`);
  setText('command-angle', `${Math.round(angle)}°`);
  setText('command-pulse', `${s.commandPulseUs} µs`);
  setText('pwm-value', s.pwm ? `${s.pulseUs} µs` : 'Off');
  setText('ram-assigned', s.powered ? Number(s.assigned) : '—');
  setText('nvs-assigned', s.storedAssigned < 0 ? s.nvsState : s.storedAssigned);
  setText('nvs-pending', s.storedPending);
  setText('nvs-saves', s.saves);
  setText('button-reading', `${s.buttonDebounced ? 'LOW' : 'HIGH'}${s.button ? ` · ${s.buttonHeldMs} ms` : ''}`);
  $('physical-button').classList.toggle('held', s.button);
  if (document.activeElement !== $('signal-level')) $('signal-level').value = String(s.rssi);
  setText('signal-output', `${s.rssi} dBm`);
  $('signal-missing').checked = !s.signalAvailable;
  $('storage-failure').checked = s.failWrites;
  setText('source-version', `SHA-256 ${s.sourceHash}`);
  setText('timing-config', `${s.constants.openPulseUs}–${s.constants.closedPulseUs} µs / ${s.constants.servoHz} Hz · ramp ${s.constants.demoSweepMs} ms · completion ${s.constants.demoMovementMs} ms · service hold ${s.constants.serviceHoldMs} ms`);
  renderTrace(s.events);
}

window.addEventListener('message', (event) => {
  if (event.origin === location.origin && event.source === phone.contentWindow && event.data?.type === 'carry-demo-status') render(event.data.status);
});
phone.addEventListener('load', () => send('status'));
$('connect-firmware').addEventListener('click', () => send(current?.connected ? 'disconnect' : 'connect'));
$('service-hold').addEventListener('click', () => send('service'));
$('main-power').addEventListener('click', () => send('power', !current?.powered));
$('reboot-tag').addEventListener('click', () => send('reboot'));
$('reset-workbench').addEventListener('click', () => { clearedThrough = 0; lastTrace = ''; send('reset'); });
$('signal-level').addEventListener('input', (event) => send('signal', Number(event.target.value)));
$('signal-missing').addEventListener('change', (event) => send('signal-available', !event.target.checked));
$('storage-failure').addEventListener('change', (event) => send('storage-failure', event.target.checked));
$('corrupt-nvs').addEventListener('click', () => send('corrupt-storage'));
$('sim-speed').addEventListener('change', (event) => send('speed', Number(event.target.value)));
$('pause-sim').addEventListener('click', () => send('pause', !current?.paused));
$('step-sim').addEventListener('click', () => send('step', 20));
$('clear-trace').addEventListener('click', () => { clearedThrough = current?.events?.at(-1)?.id || 0; lastTrace = ''; renderTrace(current?.events); });
let manuallyPressed = false;
const press = () => { manuallyPressed = true; send('button', true); };
const release = () => { if (manuallyPressed) { manuallyPressed = false; send('button', false); } };
$('physical-button').addEventListener('pointerdown', (event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); press(); });
$('physical-button').addEventListener('pointerup', release);
$('physical-button').addEventListener('pointercancel', release);
$('physical-button').addEventListener('lostpointercapture', release);
$('physical-button').addEventListener('keydown', (event) => { if ([' ', 'Enter'].includes(event.key) && !event.repeat) { event.preventDefault(); press(); } });
$('physical-button').addEventListener('keyup', (event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); release(); } });
$('physical-button').addEventListener('blur', release);
window.addEventListener('blur', release);
