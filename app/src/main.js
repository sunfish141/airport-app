import { BrowserQRCodeReader } from '@zxing/browser';
import { TagConnection } from './bluetooth.js';
import { normalizeToken } from './protocol.js';
import { SimulatedTag } from './simulated-tag.js';
import { FirmwareTag } from './firmware-tag.js';
import { LockIntent } from './lock-intent.js';
import { Proximity } from './proximity.js';
import { TagReconnect } from './tag-reconnect.js';
import { TagLocation, createLocationClient } from './tag-location.js';
import { simulatedLocation } from './simulated-wifi.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const platform = globalThis.carryPlatform;
const isVisible = () => platform ? platform.active : !document.hidden;
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
const proximity = new Proximity();
let signalSupport = null;
let signalError = false;
let signalEpoch = 0;
let signalTimer;
let connectedTagName = '';
let reconnect;
let tagLocation;

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
  ...(simulation ? { bluetooth: simulation.bluetooth } : platform ? { bluetooth: platform.bluetooth, requireSecureContext: false } : {}),
  onStatus(status) {
    latest = status;
    if (status.state === 'MOVING') tagLocation?.clear();
    setupDeadline = performance.now() + status.setupMs;
    if (status.state !== 'OPEN_FREE') released = false;
    if (status.state === 'OPEN_FREE' && status.error === 'NONE' && ['U', 'S'].includes(status.command)) released = true;
    if (status.error !== 'NONE' && status.state !== 'FAULT') notice(errors[status.error] || 'Try again.', true);
    if (status.state === 'FAULT' || (status.command === 'S' && status.error === 'NONE')) notice();
    consumeIntent();
    render();
  },
  onConnection(connected, name) {
    reconnect?.handleConnection(connected);
    $('connection-pill').textContent = connected ? 'Connected' : 'Disconnected';
    $('device-name').textContent = connected ? name : '';
    if (!connected) {
      tagLocation?.clear();
      stopSignalSearch();
      latest = null;
      released = false;
      setupDeadline = 0;
      intent.clear();
      stopScanner();
      if (reconnect?.searching) notice();
      else if (name.startsWith('Tag disconnected')) notice('Connection lost. Reconnect to continue.', true);
    } else {
      connectedTagName = name;
      notice();
      if ($('finder').open) startSignalSearch();
    }
    if (simulation) publishDemoStatus(simulation.snapshot());
    render();
  },
});
tagLocation = new TagLocation(connection, {
  locate: simulation ? simulatedLocation : platform ? platform.locate : createLocationClient(import.meta.env.VITE_CARRY_LOCATION_ENDPOINT),
  onChange: renderFinder,
});
let rememberedStorage = null;
if (!simulation) { try { rememberedStorage = platform?.storage || localStorage; } catch { /* Same-page reconnection remains available. */ } }
reconnect = new TagReconnect(connection, {
  bluetooth: simulation ? simulation.bluetooth : platform?.bluetooth || navigator.bluetooth,
  storage: rememberedStorage,
  // Native permission dialogs can deactivate the app. Let the bounded
  // connection attempt finish; new retries still pause in the background.
  cancelOnHide: !platform,
  onState() { render(); },
});
reconnect.setVisible(isVisible());

function render() {
  const connected = connection.connected && Boolean(latest);
  if (intent.expired(performance.now())) { intent.clear(); notice('Scan timed out. Scan your pass again.', true); }
  const state = connected ? latest.state : null;
  const waiting = connected && intent.pending;
  const moving = state === 'MOVING';
  const retrying = !connected && reconnect?.searching;
  const canAct = connected && !connection.connecting && !busy && !moving && !waiting;
  let title = 'Connect your tag';
  let detail = 'Switch it on and keep it nearby.';
  let icon = 'connect';
  if (retrying) { title = 'Reconnecting to your tag'; detail = `Looking for ${reconnect.name}. Keep it powered on and nearby.`; }
  else if (connecting) { title = 'Connecting…'; detail = 'Choose your tag in the Bluetooth list.'; }
  else if (!connected && reconnect?.remembered) { title = 'Reconnect your tag'; detail = `Keep ${reconnect.name} powered on and nearby.`; }
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
  $('connect').disabled = connecting || retrying;
  $('connect').textContent = retrying ? 'Reconnecting…' : connecting ? 'Connecting…' : reconnect?.remembered ? 'Reconnect tag' : 'Connect tag';
  $('cancel-reconnect').hidden = !retrying;
  $('forget-tag').hidden = !reconnect?.remembered;
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
  $('find').hidden = !connected;
  $('find').disabled = $('find-in-options').disabled = !canAct || connecting;
  $('finder-flash').disabled = !canAct;
  $('manual-lock').hidden = state !== 'OPEN_FREE';
  $('manual-unlock').hidden = state !== 'LOCKED_ASSIGNED';
  const remaining = Math.max(0, setupDeadline - performance.now());
  $('setup-line').hidden = !(state === 'OPEN_FREE' && remaining > 0 && !waiting && !busy);
  $('setup-time').textContent = `${Math.ceil(remaining / 1000)}s`;
  renderFinder();
}

function renderFinder() {
  if (!$('finder').open) return;
  const sample = proximity.snapshot(performance.now());
  let label = 'Checking signal…';
  let trend = 'Hold the phone steady for a few seconds.';
  let bars = 0;
  let reading = '';
  if (!connection.connected) { label = reconnect?.searching ? 'Reconnecting…' : 'Connection lost'; trend = reconnect?.searching ? `Looking for ${reconnect.name}. Move closer and keep the tag powered on.` : 'Reconnect to search again. The tag may be off or out of range.'; }
  else if (!isVisible()) { label = 'Search paused'; trend = 'Return to the app to continue.'; }
  else if (signalSupport === false) { label = 'Update tag firmware'; trend = 'This tag does not provide signal readings. You can still flash its light.'; }
  else if (sample.state === 'stale') { label = 'Signal unavailable'; trend = 'No fresh reading. Move closer or reconnect.'; }
  else if (sample.state === 'live') { label = sample.label; trend = sample.trend; bars = sample.bars; reading = `${sample.rssi} dBm · smoothed`; }
  else if (signalError && sample.state === 'waiting') { label = 'Waiting for signal'; trend = 'No valid reading yet. Move closer or reconnect.'; }
  if (!reading && proximity.lastAt !== null) reading = `Last reading ${Math.max(0, Math.floor((performance.now() - proximity.lastAt) / 1000))}s ago`;
  // Avoid repeatedly announcing unchanged live-region text on each UI tick.
  for (const [id, text] of [['finder-device', connectedTagName], ['signal-label', label], ['signal-trend', trend], ['signal-reading', reading]]) {
    if ($(id).textContent !== text) $(id).textContent = text;
  }
  $('signal-bars').dataset.bars = String(bars);
  $('signal-bars').setAttribute('aria-label', `${label}${bars ? `, ${bars} of 4 bars` : ''}`);
  $('finder-reconnect').hidden = connection.connected || reconnect?.searching;
  $('finder-stop').hidden = connection.connected || !reconnect?.searching;
  $('finder-flash').hidden = !connection.connected;
  const result = tagLocation?.result;
  $('location-update').disabled = !connection.connected || !isVisible() || Boolean(tagLocation?.busy) || Boolean(connection.wifiScan) || busy || Boolean(intent.pending) || latest?.state === 'MOVING' || latest?.setupMs > 0;
  $('location-update').textContent = tagLocation?.busy ? 'Updating location…' : result ? 'Update location' : 'Estimate location';
  $('location-message').hidden = !tagLocation?.message && !result;
  const locationText = result
    ? `${demoMode ? 'Simulated estimate · ' : ''}Accuracy radius: ${Math.ceil(result.accuracy)} m`
    : tagLocation?.message || '';
  if ($('location-status').textContent !== locationText) $('location-status').textContent = locationText;
  $('location-age').textContent = result ? ` · ${Math.max(0, Math.floor((Date.now() - result.at) / 1000))}s ago` : '';
  $('location-map').hidden = !result;
  if (result) $('location-map').href = `https://www.google.com/maps/search/?api=1&query=${result.location.lat},${result.location.lng}`;
}
function stopSignalSearch() { ++signalEpoch; clearTimeout(signalTimer); }
function startSignalSearch() {
  stopSignalSearch();
  proximity.reset();
  signalSupport = null;
  signalError = false;
  const epoch = signalEpoch;
  async function poll() {
    if (epoch !== signalEpoch || !$('finder').open || !isVisible() || !connection.connected) return;
    try {
      const sample = await connection.readSignal();
      if (epoch !== signalEpoch) return;
      if (sample) {
        signalSupport = sample.supported;
        signalError = sample.supported && sample.rssi === null;
        if (sample.supported && sample.rssi !== null) proximity.add(sample.rssi, performance.now());
      }
    } catch { if (epoch === signalEpoch) signalError = true; }
    if (epoch !== signalEpoch) return;
    renderFinder();
    if (signalSupport !== false && connection.connected) signalTimer = setTimeout(poll, 1000);
  }
  void poll();
  renderFinder();
}
function openFinder() {
  $('tag-options').close();
  $('finder-message').textContent = '';
  $('finder').showModal();
  startSignalSearch();
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
  if (!simulation && platform) {
    if (platform.scanning) return;
    intent.clear(); stopScanner(); notice();
    const session = scanSession;
    try {
      const result = await platform.scan();
      if (session !== scanSession || !isVisible() || !connection.connected || !result) return;
      handleScan(opcode, normalizeToken(result));
    } catch (error) {
      if (session === scanSession) notice(friendlyError(error, 'camera'), true);
    }
    return;
  }
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
  try { await reconnect.connect(); }
  catch (error) { notice(friendlyError(error), true); }
  finally { connecting = false; render(); }
});
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('options').addEventListener('click', () => $('tag-options').showModal());
$('disconnect').addEventListener('click', () => { $('tag-options').close(); reconnect.stop(); connection.disconnect(); notice(); });
$('cancel-reconnect').addEventListener('click', () => { reconnect.stop(); notice(); render(); });
$('forget-tag').addEventListener('click', () => { $('tag-options').close(); reconnect.stop({ forget: true }); connection.disconnect(); notice(); });
$('lock').addEventListener('click', () => scan('L'));
$('unlock').addEventListener('click', () => scan('U'));
$('storage').addEventListener('click', () => { $('tag-options').close(); void run('C'); });
$('flash').addEventListener('click', () => { $('tag-options').close(); void run('F'); });
$('find').addEventListener('click', openFinder);
$('find-in-options').addEventListener('click', openFinder);
$('finder').addEventListener('close', () => { stopSignalSearch(); tagLocation.clear(); });
$('location-update').addEventListener('click', () => void tagLocation.refresh());
$('finder-flash').addEventListener('click', async () => { await run('F'); $('finder-message').textContent = $('notice').textContent; });
$('finder-reconnect').addEventListener('click', () => { $('finder').close(); $('connect').click(); });
$('finder-stop').addEventListener('click', () => reconnect.stop());
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
function visibilityChanged() {
  reconnect.setVisible(isVisible());
  if (!isVisible()) {
    // Android's native scanner opens a camera Activity. Its result still
    // belongs to this scan; a disconnect or explicit cancel invalidates it.
    if (!platform?.scanning) stopScanner();
    intent.clear(); stopSignalSearch(); tagLocation.clear(); render();
  }
  else if ($('finder').open) startSignalSearch();
}
if (platform) platform.onVisibility(visibilityChanged);
else document.addEventListener('visibilitychange', visibilityChanged);
window.addEventListener('pagehide', () => { intent.clear(); stopSignalSearch(); tagLocation.clear(); stopScanner(); reconnect.setVisible(false); connection.disconnect(); simulation?.dispose(); });
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
    else if (action === 'disconnect') { reconnect.stop(); connection.disconnect(); }
    else if (action === 'setup') simulation.setup();
    else if (action === 'service') simulation.service();
    else if (action === 'obstruction') simulation.setObstructed(value);
    else if (action === 'reboot') simulation.reboot();
    else if (action === 'reset') { reconnect.stop({ forget: true }); simulation.reset(); }
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
    else if (action === 'signal') simulation.setSignal(value);
    else if (action === 'signal-available') simulation.setSignalAvailable(value);
    publishDemoStatus(simulation.snapshot());
  });
  publishDemoStatus(simulation.snapshot());
  simulation.ready?.catch((error) => notice(`Simulation could not start: ${error.message}`, true));
}
if (platform) {
  document.body.dataset.native = 'true';
  document.querySelector('.support-note').textContent = 'Allow Bluetooth and camera access when asked. Demo QR passes only.';
  document.querySelector('.brand').addEventListener('click', (event) => event.preventDefault());
  platform.onBack(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (dialog?.id === 'scanner') stopScanner();
    else dialog?.close();
    return Boolean(dialog);
  });
} else if (!simulation && !globalThis.isSecureContext) notice('Open this app over HTTPS to connect your tag.', true);
else if (!simulation && !navigator.bluetooth) notice('Use Android Chrome to connect your tag.', true);
render();
