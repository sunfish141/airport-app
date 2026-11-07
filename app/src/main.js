import { BrowserQRCodeReader } from '@zxing/browser';
import { TagConnection } from './bluetooth.js';
import { normalizeToken } from './protocol.js';
import { SimulatedTag } from './simulated-tag.js';
import { FirmwareTag } from './firmware-tag.js';
import { LockIntent } from './lock-intent.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const demoValue = new URLSearchParams(location.search).get('demo');
const firmwareMode = demoValue === 'firmware';
const demoMode = demoValue === '1' || firmwareMode;
const simulation = firmwareMode ? new FirmwareTag({ onChange: publishDemoStatus })
  : demoMode ? new SimulatedTag({ onChange: publishDemoStatus }) : null;
const intent = new LockIntent();
let busy = false;
let connecting = false;
let latest = null;
let released = false;
let operation = null;
let scanSession = 0;
let controls;
let demoScanOpcode = null;
let setupDeadline = 0;

const errors = {
  TOKEN_MISMATCH: 'Wrong pass. Scan the pass used to lock this tag.',
  SETUP_REQUIRED: 'Setup expired. Scan again, then press the tag button.',
  ASSIGNED: 'This tag is already locked. Use its original pass.',
  UNASSIGNED: 'No pass is assigned to this tag.',
  NOT_OPEN: 'Open the tag before locking it.',
  BUSY: 'Wait for the tag to stop moving.',
  STORAGE: 'The tag could not save this change. It needs a storage check.',
  SENSOR_CONFLICT: 'Check the position switches, then hold the tag button for 3 seconds.',
  TIMEOUT: 'Clear the bolt, then hold the tag button for 3 seconds.',
  RECOVERY_REQUIRED: 'Clear the bolt, then hold the tag button for 3 seconds.',
  ACTUATOR: 'The motor could not start. Check your tag.',
  MALFORMED: 'Pass not recognised. Use a demo QR pass.',
  UNKNOWN_COMMAND: 'This tag needs a firmware update.',
};
function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
}
function friendlyError(error, source = 'tag') {
  if (errors[error.code]) return errors[error.code];
  if (error.name === 'NotFoundError') return 'No tag selected.';
  if (error.name === 'NotAllowedError') return source === 'camera' ? 'Allow camera access or enter a token in Tag options.' : 'Allow Bluetooth access to connect your tag.';
  if (/No confirmed result/.test(error.message)) return 'No response. Reconnect to check your tag.';
  if (/disconnected|Disconnected/.test(error.message)) return 'Connection lost. Reconnect to continue.';
  return error.message;
}

const connection = new TagConnection({
  ...(simulation ? { bluetooth: simulation.bluetooth } : {}),
  onStatus(status) {
    latest = status;
    setupDeadline = performance.now() + status.setupMs;
    if (status.state !== 'OPEN_FREE') released = false;
    if (status.state === 'OPEN_FREE' && status.error === 'NONE' && ['U', 'S'].includes(status.command)) released = true;
    if (status.error !== 'NONE' && status.state !== 'FAULT') notice(errors[status.error] || 'Try again.', true);
    if (status.state === 'FAULT' || (status.command === 'S' && status.error === 'NONE')) notice();
    consumeIntent();
    render();
  },
  onConnection(connected, name) {
    $('connection-pill').textContent = connected ? 'Connected' : 'Disconnected';
    $('device-name').textContent = connected ? name : '';
    if (!connected) {
      latest = null;
      released = false;
      setupDeadline = 0;
      intent.clear();
      stopScanner();
      if (name.startsWith('Tag disconnected')) notice('Connection lost. Reconnect to continue.', true);
    } else notice();
    if (simulation) publishDemoStatus(simulation.snapshot());
    render();
  },
});

function render() {
  const connected = connection.connected && Boolean(latest);
  if (intent.expired(performance.now())) { intent.clear(); notice('Scan timed out. Scan your pass again.', true); }
  const state = connected ? latest.state : null;
  const waiting = connected && intent.pending;
  const moving = state === 'MOVING';
  const canAct = connected && !busy && !moving && !waiting;
  let title = 'Connect your tag';
  let detail = 'Switch it on and keep it nearby.';
  let icon = 'connect';
  if (connecting) { title = 'Connecting…'; detail = 'Choose your tag in the Bluetooth list.'; }
  else if (waiting) { title = 'Press the tag button'; detail = 'Hold for ½ second, then release. Your pass is scanned.'; icon = 'button'; }
  else if (state === 'OPEN_FREE') { title = released ? 'Bag released' : 'Lock your bag'; detail = released ? 'You can remove the cable.' : 'Insert the cable, then scan your pass.'; icon = released ? 'released' : 'bag'; }
  else if (state === 'LOCKED_ASSIGNED') { title = 'Bag locked'; detail = 'Scan the same pass to release.'; icon = 'locked'; }
  else if (state === 'CLOSED_FREE') { title = 'Tag stored'; detail = 'Hold the tag button for 3 seconds to open.'; icon = 'button'; }
  else if (moving) { title = (operation || latest.command) === 'L' ? 'Locking…' : (operation || latest.command) === 'C' ? 'Closing…' : 'Releasing…'; detail = 'Wait for the tag to finish.'; icon = 'moving'; }
  else if (state === 'FAULT') { title = 'Check your tag'; detail = errors[latest.error] || errors.RECOVERY_REQUIRED; icon = 'fault'; }
  $('state-label').textContent = title;
  $('state-detail').textContent = detail;
  $('status-symbol').setAttribute('href', `#icon-${icon}`);
  $('state-icon').className = `state-icon ${icon === 'fault' ? 'fault' : icon === 'moving' ? 'moving' : ''}`;
  $('device-row').hidden = !connected;
  $('connect').hidden = connected;
  $('connect').disabled = connecting;
  $('connect').textContent = connecting ? 'Connecting…' : 'Connect tag';
  $('lock').hidden = state !== 'OPEN_FREE' || waiting || moving;
  $('unlock').hidden = state !== 'LOCKED_ASSIGNED' || moving;
  $('lock').disabled = $('manual-lock').disabled = !(canAct && state === 'OPEN_FREE');
  $('unlock').disabled = $('manual-unlock').disabled = !(canAct && state === 'LOCKED_ASSIGNED');
  $('lock').textContent = released ? 'Lock again' : 'Scan to lock';
  $('waiting').hidden = !waiting && !moving;
  $('waiting').textContent = moving ? 'Please wait…' : 'Waiting for tag button…';
  $('cancel-lock').hidden = !waiting;
  $('disconnect').hidden = !connected;
  $('storage').hidden = state !== 'OPEN_FREE';
  $('storage').disabled = !(canAct && state === 'OPEN_FREE');
  $('flash').disabled = !canAct;
  $('manual-lock').hidden = state !== 'OPEN_FREE';
  $('manual-unlock').hidden = state !== 'LOCKED_ASSIGNED';
  const remaining = Math.max(0, setupDeadline - performance.now());
  $('setup-line').hidden = !(state === 'OPEN_FREE' && remaining > 0 && !waiting && !busy);
  $('setup-time').textContent = `${Math.ceil(remaining / 1000)}s`;
}

function consumeIntent() {
  if (!intent.pending || !connection.connected || busy) return;
  const token = intent.take(latest, Math.max(0, setupDeadline - performance.now()), performance.now());
  if (token) void run('L', token);
}
function queueLock(token) {
  if (!connection.connected || latest?.state !== 'OPEN_FREE' || busy) { notice('Tag state changed. Reconnect or try again.', true); return; }
  intent.queue(token, performance.now());
  notice();
  consumeIntent();
  render();
}
async function run(opcode, token) {
  intent.clear();
  busy = true;
  operation = opcode;
  notice();
  render();
  try {
    await connection.send(opcode, token);
    if (opcode === 'F') notice('Tag is flashing.');
  } catch (error) {
    if (latest?.state !== 'FAULT') notice(friendlyError(error), true);
  } finally { $('token').value = ''; busy = false; operation = null; render(); }
}

function stopScanner() {
  ++scanSession;
  demoScanOpcode = null;
  controls?.stop();
  controls = undefined;
  $('video').srcObject?.getTracks().forEach((track) => track.stop());
  $('video').srcObject = null;
  if ($('scanner').open) $('scanner').close();
}
function handleScan(opcode, token) {
  if (opcode === 'L') queueLock(token);
  else void run(opcode, token);
}
async function scan(opcode) {
  if (!simulation && (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
    notice('Camera unavailable. Enter a demo token in Tag options.', true); return;
  }
  intent.clear();
  stopScanner();
  const session = scanSession;
  notice();
  $('scanner-purpose').textContent = opcode === 'L' ? 'To lock your bag' : 'To release your bag';
  $('scan-message').textContent = simulation ? 'Choose a demo pass.' : 'Point the camera at your demo QR pass.';
  $('scanner').showModal();
  if (simulation) { demoScanOpcode = opcode; return; }
  try {
    const started = await new BrowserQRCodeReader().decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } }, $('video'), (result, error, currentControls) => {
      if (session !== scanSession) { currentControls.stop(); return; }
      if (!result) return;
      let token;
      try { token = normalizeToken(result.getText()); }
      catch { $('scan-message').textContent = 'Use a demo QR pass.'; return; }
      currentControls.stop(); stopScanner(); handleScan(opcode, token);
    });
    if (session !== scanSession) started.stop(); else controls = started;
  } catch (error) {
    if (session !== scanSession) return;
    stopScanner(); notice(friendlyError(error, 'camera'), true);
  }
}
async function chooseDemoPass(index) {
  const opcode = demoScanOpcode;
  const session = scanSession;
  if (!opcode) return;
  const buttons = document.querySelectorAll('[data-demo-pass]');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await new BrowserQRCodeReader().decodeFromImageUrl(new URL(`./demo-pass-${index}.svg`, location.href).href);
    if (session !== scanSession) return;
    const token = normalizeToken(result.getText());
    stopScanner(); handleScan(opcode, token);
  } catch { if (session === scanSession) $('scan-message').textContent = 'Could not read this pass. Try again.'; }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}
function publishDemoStatus(status) {
  if (window.parent !== window) window.parent.postMessage({ type: 'carry-demo-status', status }, location.origin);
}

$('connect').addEventListener('click', async () => {
  connecting = true; notice(); render();
  try { await connection.connect(); }
  catch (error) { notice(friendlyError(error), true); }
  finally { connecting = false; render(); }
});
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('options').addEventListener('click', () => $('tag-options').showModal());
$('disconnect').addEventListener('click', () => { $('tag-options').close(); connection.disconnect(); notice(); });
$('lock').addEventListener('click', () => scan('L'));
$('unlock').addEventListener('click', () => scan('U'));
$('storage').addEventListener('click', () => { $('tag-options').close(); void run('C'); });
$('flash').addEventListener('click', () => { $('tag-options').close(); void run('F'); });
$('cancel-lock').addEventListener('click', () => { intent.clear(); notice(); render(); });
$('cancel-scan').addEventListener('click', stopScanner);
$('scanner').addEventListener('cancel', (event) => { event.preventDefault(); stopScanner(); });
$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const opcode = event.submitter?.value;
  if (!['L', 'U'].includes(opcode) || event.submitter.disabled) return;
  try {
    const token = normalizeToken($('token').value);
    $('token').value = ''; $('tag-options').close(); handleScan(opcode, token);
  } catch { notice('Enter a 16-character demo token.', true); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopScanner(); intent.clear(); render(); } });
window.addEventListener('pagehide', () => { intent.clear(); stopScanner(); connection.disconnect(); simulation?.dispose(); });
setInterval(render, 200);

if (simulation) {
  document.body.dataset.demo = firmwareMode ? 'firmware' : 'demo';
  document.querySelector('.brand').href = firmwareMode ? './?demo=firmware' : './?demo=1';
  $('demo-label').hidden = false;
  $('demo-tools').hidden = window.parent !== window;
  $('quick-setup').addEventListener('click', () => { $('tag-options').close(); simulation.setup(); });
  $('quick-service').addEventListener('click', () => { $('tag-options').close(); simulation.service(); });
  $('camera-frame').hidden = true;
  $('demo-scanner').hidden = false;
  document.querySelectorAll('[data-demo-pass]').forEach((button) => button.addEventListener('click', () => chooseDemoPass(Number(button.dataset.demoPass))));
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'carry-demo-action') return;
    const { action, value } = event.data;
    if (action === 'connect' && !connection.connected && !connection.connecting) $('connect').click();
    else if (action === 'disconnect') connection.disconnect();
    else if (action === 'setup') simulation.setup();
    else if (action === 'service') simulation.service();
    else if (action === 'obstruction') simulation.setObstructed(value);
    else if (action === 'reboot') simulation.reboot();
    else if (action === 'reset') simulation.reset();
    else if (action === 'power') simulation.power?.(value);
    else if (action === 'button') simulation.button?.(value);
    else if (action === 'sensors') simulation.setSensors?.(value);
    else if (action === 'storage-failure') simulation.setStorageFailure?.(value);
    else if (action === 'corrupt-storage') simulation.corruptStorage?.();
    else if (action === 'travel') simulation.setTravel?.(value);
    else if (action === 'position') simulation.setPosition?.(value);
    else if (action === 'cable') simulation.setCable?.(value);
    else if (action === 'speed') simulation.setSpeed?.(value);
    else if (action === 'pause') simulation.setPaused?.(value);
    else if (action === 'step') simulation.step?.(value);
    publishDemoStatus(simulation.snapshot());
  });
  publishDemoStatus(simulation.snapshot());
  simulation.ready?.catch((error) => notice(`Simulation could not start: ${error.message}`, true));
} else if (!globalThis.isSecureContext) notice('Open this app over HTTPS to connect your tag.', true);
else if (!navigator.bluetooth) notice('Use Android Chrome to connect your tag.', true);
render();
