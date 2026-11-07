import { BrowserQRCodeReader } from '@zxing/browser';
import { TagConnection, errorMessage } from './bluetooth.js';
import { normalizeToken } from './protocol.js';
import { SimulatedTag } from './simulated-tag.js';
import { FirmwareTag } from './firmware-tag.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const demoValue = new URLSearchParams(location.search).get('demo');
const firmwareMode = demoValue === 'firmware';
const demoMode = demoValue === '1' || firmwareMode;
const simulation = firmwareMode ? new FirmwareTag({ onChange: publishDemoStatus }) : demoMode
  ? new SimulatedTag({ onChange: publishDemoStatus })
  : null;
let busy = false;
let scanSession = 0;
let controls;
let setupDeadline = 0;
let latest = null;
let demoScanOpcode = null;
const labels = {
  OPEN_FREE: ['Open & ready', 'Your tag is unassigned and ready for setup.'],
  CLOSED_FREE: ['Closed for storage', 'Hold the tag button for 3 seconds to reopen.'],
  LOCKED_ASSIGNED: ['Locked & assigned', 'Scan the same demo pass to release your tag.'],
  MOVING: ['Bolt is moving', 'Waiting for the position switch to confirm.'],
  FAULT: ['Service needed', 'Check the mechanism, then hold the tag button for 3 seconds.'],
};

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

const connection = new TagConnection({
  ...(simulation ? { bluetooth: simulation.bluetooth } : {}),
  onStatus(status) {
    latest = status;
    setupDeadline = performance.now() + status.setupMs;
    const [title, detail] = labels[status.state];
    $('state-label').textContent = title;
    $('state-detail').textContent = detail;
    $('state-dot').className = `state-dot ${status.state === 'FAULT' ? 'fault' : status.state === 'MOVING' ? 'busy' : 'good'}`;
    if (status.error !== 'NONE') notice(errorMessage(status.error), true);
    else if (status.command === 'S' && status.state === 'OPEN_FREE') notice('Service opening confirmed. Assignment cleared; ready to reuse.');
    else if (status.command === 'S' && status.state === 'MOVING') notice('Service opening requested. Waiting for confirmed release…');
    render();
  },
  onConnection(connected, message) {
    $('connection-pill').textContent = connected ? 'Connected' : 'Disconnected';
    $('connection-pill').classList.toggle('connected', connected);
    $('device-name').textContent = connected ? message : 'Let’s find your tag';
    $('connection-copy').textContent = connected ? (simulation ? 'Virtual tag connected. No hardware is in use.' : 'Your tag is connected over Bluetooth.') : (simulation ? 'Connect the virtual tag to try this demo.' : 'Keep your tag powered on and nearby.');
    $('connect').hidden = connected;
    $('disconnect').hidden = !connected;
    if (!connected) {
      latest = null;
      setupDeadline = 0;
      stopScanner();
      $('state-label').textContent = 'Waiting for connection';
      $('state-detail').textContent = 'Connect to read the current tag state.';
      $('state-dot').className = 'state-dot';
    }
    notice(connected ? 'Connected. Your tag’s confirmed state is shown above.' : message);
    if (simulation) publishDemoStatus(simulation.snapshot());
    render();
  },
});

function render() {
  const active = connection.connected && latest && !busy && latest.state !== 'MOVING';
  const setupMs = Math.max(0, setupDeadline - performance.now());
  $('setup-time').textContent = setupMs > 0 ? `${Math.ceil(setupMs / 1000)} seconds` : 'Inactive';
  const canLock = active && latest.state === 'OPEN_FREE' && setupMs > 0;
  const canUnlock = active && latest.state === 'LOCKED_ASSIGNED';
  $('lock').disabled = $('manual-lock').disabled = !canLock;
  $('unlock').disabled = $('manual-unlock').disabled = !canUnlock;
  $('storage').disabled = !(active && latest.state === 'OPEN_FREE');
  $('flash').disabled = !active;
}

async function run(opcode, token) {
  busy = true;
  render();
  notice(opcode === 'F' ? 'Asking your tag to flash…' : 'Waiting for confirmed bolt position…');
  try {
    await connection.send(opcode, token);
    notice({ L: 'Locked. This pass is now assigned to your tag.', U: 'Open confirmed. Assignment cleared; ready to reuse.', C: 'Closed for storage. Hold the tag button for 3 seconds to reopen.', F: 'Your tag is flashing.' }[opcode]);
  } catch (error) { notice(error.message, true); }
  finally { $('token').value = ''; busy = false; render(); }
}

function stopScanner() {
  ++scanSession;
  demoScanOpcode = null;
  controls?.stop();
  controls = undefined;
  const stream = $('video').srcObject;
  stream?.getTracks().forEach((track) => track.stop());
  $('video').srcObject = null;
  if ($('scanner').open) $('scanner').close();
}

async function scan(opcode) {
  if (!simulation && (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
    notice('Camera scanning needs HTTPS and camera permission. You can also enter a demo token manually.', true);
    return;
  }
  stopScanner();
  const session = scanSession;
  $('scanner-title').textContent = opcode === 'L' ? 'Scan to lock' : 'Scan to unlock';
  $('scan-message').textContent = 'Place the demo QR inside the frame.';
  $('scanner').showModal();
  if (simulation) {
    demoScanOpcode = opcode;
    $('scan-message').textContent = 'Choose a synthetic pass to simulate scanning its QR.';
    return;
  }
  try {
    const reader = new BrowserQRCodeReader();
    const started = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } }, $('video'), (result, error, currentControls) => {
      if (session !== scanSession) { currentControls.stop(); return; }
      if (!result) return;
      let token;
      try { token = normalizeToken(result.getText()); }
      catch (validationError) { $('scan-message').textContent = validationError.message; return; }
      currentControls.stop();
      stopScanner();
      void run(opcode, token);
    });
    if (session !== scanSession) started.stop(); else controls = started;
  } catch (error) {
    if (session !== scanSession) return;
    stopScanner();
    notice(`Camera unavailable: ${error.message}. Use manual token entry if needed.`, true);
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
    stopScanner();
    await run(opcode, token);
  } catch (error) {
    if (session === scanSession) $('scan-message').textContent = error.message;
  } finally { buttons.forEach((button) => { button.disabled = false; }); }
}

function publishDemoStatus(status) {
  if (window.parent !== window) window.parent.postMessage({ type: 'carry-demo-status', status }, location.origin);
}

$('connect').addEventListener('click', async () => {
  $('connect').disabled = true;
  notice('Choose your nearby Carry tag…');
  try { await connection.connect(); }
  catch (error) { notice(error.message, true); }
  finally { $('connect').disabled = false; }
});
$('disconnect').addEventListener('click', () => connection.disconnect());
$('lock').addEventListener('click', () => scan('L'));
$('unlock').addEventListener('click', () => scan('U'));
$('storage').addEventListener('click', () => run('C'));
$('flash').addEventListener('click', () => run('F'));
$('cancel-scan').addEventListener('click', stopScanner);
$('scanner').addEventListener('cancel', (event) => { event.preventDefault(); stopScanner(); });
$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const opcode = event.submitter?.value;
  if (!['L', 'U'].includes(opcode) || event.submitter.disabled) return;
  try { void run(opcode, normalizeToken($('token').value)); }
  catch (error) { notice(error.message, true); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScanner(); });
window.addEventListener('pagehide', () => { stopScanner(); connection.disconnect(); simulation?.dispose(); });
setInterval(render, 200);
if (simulation) {
  document.querySelector('.brand').href = firmwareMode ? './?demo=firmware' : './?demo=1';
  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  banner.innerHTML = '<strong>Demo mode · Virtual tag</strong><span>No real Bluetooth or motor</span><div><button id="quick-setup">Start setup</button><button id="quick-service">Service open</button></div>';
  if (firmwareMode) banner.innerHTML = '<strong>Production firmware · Simulated hardware</strong><span>C++ controller running in WebAssembly</span><div><button id="quick-setup">Hold for setup · 650 ms</button><button id="quick-service">Hold for service · 3.2 s</button></div>';
  document.body.prepend(banner);
  $('quick-setup').addEventListener('click', () => simulation.setup());
  $('quick-service').addEventListener('click', () => simulation.service());
  $('camera-frame').hidden = true;
  $('demo-scanner').hidden = false;
  document.querySelectorAll('[data-demo-pass]').forEach((button) => {
    button.addEventListener('click', () => chooseDemoPass(Number(button.dataset.demoPass)));
  });
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
  notice('Demo mode: connect the virtual tag, start setup, then scan a demo pass.');
  simulation.ready?.catch((error) => notice(`Firmware simulation could not start: ${error.message}`, true));
} else if (!globalThis.isSecureContext) notice('Open this app over HTTPS on Android Chrome to enable Bluetooth and the camera.', true);
else if (!navigator.bluetooth) notice('Web Bluetooth is unavailable in this browser. Open this app in Android Chrome.', true);
