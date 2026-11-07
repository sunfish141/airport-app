import { describeTrace } from './firmware-machine.js';
import './workbench.css';

const $ = (id) => document.getElementById(id);
const phone = $('firmware-phone');
let current;
let lastTrace = '';
let clearedThrough = 0;
const send = (action, value) => phone.contentWindow.postMessage({ type: 'carry-demo-action', action, value }, location.origin);
const setText = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };

function renderTrace(events = []) {
  const filtered = events.filter((event) => event.id > clearedThrough && ($('show-contacts').checked || event.code !== 6));
  const key = `${filtered[0]?.id}:${filtered.at(-1)?.id}:${$('show-contacts').checked}`;
  if (key === lastTrace) return;
  lastTrace = key;
  const nodes = filtered.slice().reverse().map((event) => {
    const [message, source] = describeTrace(event);
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = `${(event.ms / 1000).toFixed(3)}s`;
    const detail = document.createElement('div');
    detail.textContent = message;
    const origin = document.createElement('small');
    origin.textContent = source;
    detail.append(origin);
    item.append(time, detail);
    return item;
  });
  $('trace').replaceChildren(...nodes);
}

function explain(s) {
  if (!s.powered) return ['Main power is off', 'The controller and servo supply are off. Bolt position and NVS bytes remain. Power on to observe boot reconciliation; there is no automatic opening.'];
  if (!s.ready) return ['Booting and sampling contacts', 'The firmware waits for stable initial switch readings before Controller::begin() reconciles ownership and pending movement.'];
  if (s.state === 'FAULT') return [`Fault latched · ${s.error}`, 'PWM is detached and ownership is retained. Fix the simulated obstruction or wiring, then hold the physical button for 3 seconds. Opening clears ownership only after the debounced open switch confirms and NVS commits.'];
  if (s.state === 'MOVING') return ['Pending movement was saved before PWM', 'The production controller is waiting for its endpoint switch. Neither switch active is not opening confirmation. If confirmation misses the firmware deadline, movement faults without an automatic retry.'];
  if (s.state === 'LOCKED_ASSIGNED') return ['Closed switch confirmed; assignment retained', 'The bolt crosses the removable cable eyelet. Token matching runs inside the C++ controller. A different pass is rejected without changing the assignment.'];
  if (s.state === 'CLOSED_FREE') return ['Closed for storage; no assignment', 'The same closed switch confirms the storage position. Hold the physical button for 3 seconds to request service opening without a scan.'];
  return ['Open confirmed; ready to assign', 'The open switch is debounced and there is no assignment. Hold the physical button for at least 500 ms and release before 3 seconds to start the 10-second setup window.'];
}

function render(s) {
  current = s;
  $('load-error').hidden = !s.loadError;
  if (s.loadError) setText('load-error', `${s.loadError} Use Reset saved simulation to retry.`);
  setText('engine-state', s.state || 'Loading WebAssembly…');
  $('engine-state').classList.toggle('fault', s.state === 'FAULT');
  setText('sim-time', `${((s.worldMs || 0) / 1000).toFixed(2)} s`);
  setText('pause-sim', s.paused ? 'Resume' : 'Pause');
  $('step-sim').disabled = !s.paused;
  if (s.position === undefined) return;
  const enabled = s.ready && s.powered;
  for (const id of ['physical-button', 'setup-hold', 'service-hold', 'reboot-tag', 'connect-firmware']) $(id).disabled = !enabled;
  $('main-power').disabled = false;
  setText('main-power', s.powered ? 'Cut main power' : 'Power on');
  setText('connect-firmware', s.connected ? 'Disconnect' : 'Connect');
  setText('phone-connection', `${s.connected ? 'Connected to production C++ controller' : 'Phone disconnected'} · ${s.persistence === 'browser' ? 'NVS bytes saved in this browser' : 'NVS persists within this session only'}`);
  setText('source-version', `Compiled source SHA-256: ${s.sourceHash}. Production timing: debounce ${s.constants.debounceMs} ms, setup ${s.constants.setupWindowMs} ms, service hold ${s.constants.serviceHoldMs} ms, movement timeout ${s.constants.timeoutMs} ms.`);
  $('bolt').setAttribute('transform', `translate(${155 * (s.position - 1)} 0)`);
  const angle = -35 + s.position * 70;
  $('servo-horn').setAttribute('transform', `rotate(${angle} 414 291)`);
  const radians = angle * Math.PI / 180;
  $('linkage').setAttribute('x1', String(414 + 20 * Math.sin(radians)));
  $('linkage').setAttribute('y1', String(291 - 20 * Math.cos(radians)));
  $('linkage').setAttribute('x2', String(472 + 155 * (s.position - 1)));
  $('eyelet').setAttribute('opacity', s.cable ? '1' : '.12');
  $('cable-loop').setAttribute('opacity', s.cable ? '1' : '.12');
  $('open-contact').setAttribute('fill', s.powered && s.rawOpen ? '#3e975e' : '#a2aca0');
  $('closed-contact').setAttribute('fill', s.powered && s.rawClosed ? '#3e975e' : '#a2aca0');
  $('board-led').setAttribute('fill', s.led && s.powered ? '#e4b135' : '#7c8b76');
  $('power-contact').setAttribute('fill', s.powered ? '#6f9d65' : '#e8ebe2');
  for (const id of ['battery-wire', 'servo-power', 'controller-power']) $(id).setAttribute('opacity', s.powered ? '1' : '.15');
  $('pwm-wire').setAttribute('opacity', s.pwm ? '1' : '.2');
  setText('position-value', `${Math.round(s.position * 100)}%`);
  setText('pwm-value', s.pwm ? `${s.pulseUs} µs` : 'Detached');
  setText('pwm-detail', s.pwm ? `50 Hz · target ${s.pending.toLowerCase()}` : 'PWM off ≠ guaranteed motor cutoff');
  setText('open-value', !s.powered ? 'Unpowered' : s.rawOpen ? 'LOW · active' : 'HIGH · released');
  setText('closed-value', !s.powered ? 'Unpowered' : s.rawClosed ? 'LOW · active' : 'HIGH · released');
  setText('open-stable', `Debounced: ${s.open ? 'active' : 'released'} · ${s.constants.debounceMs} ms`);
  setText('closed-stable', `Debounced: ${s.closed ? 'active' : 'released'} · ${s.constants.debounceMs} ms`);
  setText('ram-assigned', s.powered ? s.assigned ? 'Assigned' : 'Free' : 'MCU off');
  setText('nvs-assigned', s.storedAssigned < 0 ? s.nvsState : s.storedAssigned ? 'Assigned' : 'Free');
  setText('nvs-pending', s.storedPending);
  setText('nvs-saves', s.saves);
  setText('diagram-nvs', s.storedAssigned < 0 ? s.nvsState : s.storedAssigned ? 'OWNERSHIP STORED' : 'UNASSIGNED');
  setText('diagram-pending', `pending: ${s.storedPending.toLowerCase()}`);
  setText('mechanical-state', s.position > .85 && s.cable ? 'Cable eyelet retained by bolt' : s.position < .15 ? 'Bolt retracted; eyelet can be removed' : 'Bolt between endpoints');
  $('toggle-cable').disabled = s.position > .15;
  setText('toggle-cable', s.cable ? 'Remove cable eyelet' : 'Insert cable eyelet');
  $('physical-button').classList.toggle('held', s.button);
  setText('button-reading', `GPIO7 · ${s.button ? `pressed ${s.buttonHeldMs} ms · LOW` : 'released · HIGH'} · debounced ${s.buttonDebounced ? 'pressed' : 'released'}`);
  const [title, copy] = explain(s);
  setText('phase-title', title);
  setText('phase-copy', copy);
  $('jam').checked = s.obstructed;
  $('storage-failure').checked = s.failWrites;
  $('sensor-fault').value = String(s.sensorMode);
  $('travel-time').value = String(s.travelMs);
  setText('travel-output', `${s.travelMs} ms (assumed)`);
  $('manual-position').disabled = s.pwm;
  if (document.activeElement !== $('manual-position')) $('manual-position').value = String(s.position);
  renderTrace(s.events);
}

window.addEventListener('message', (event) => {
  if (event.origin === location.origin && event.source === phone.contentWindow && event.data?.type === 'carry-demo-status') render(event.data.status);
});
phone.addEventListener('load', () => send('status'));
$('connect-firmware').addEventListener('click', () => send(current?.connected ? 'disconnect' : 'connect'));
$('setup-hold').addEventListener('click', () => send('setup'));
$('service-hold').addEventListener('click', () => send('service'));
$('main-power').addEventListener('click', () => send('power', !current?.powered));
$('reboot-tag').addEventListener('click', () => send('reboot'));
$('jam').addEventListener('change', (event) => send('obstruction', event.target.checked));
$('sensor-fault').addEventListener('change', (event) => send('sensors', Number(event.target.value)));
$('storage-failure').addEventListener('change', (event) => send('storage-failure', event.target.checked));
$('corrupt-nvs').addEventListener('click', () => send('corrupt-storage'));
$('reset-workbench').addEventListener('click', () => { clearedThrough = 0; lastTrace = ''; send('reset'); });
$('travel-time').addEventListener('input', (event) => send('travel', Number(event.target.value)));
$('manual-position').addEventListener('input', (event) => send('position', Number(event.target.value)));
$('toggle-cable').addEventListener('click', () => send('cable', !current?.cable));
$('sim-speed').addEventListener('change', (event) => send('speed', Number(event.target.value)));
$('pause-sim').addEventListener('click', () => send('pause', !current?.paused));
$('step-sim').addEventListener('click', () => send('step', 20));
$('show-contacts').addEventListener('change', () => { lastTrace = ''; renderTrace(current?.events); });
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
