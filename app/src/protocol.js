export const UUIDS = Object.freeze({
  service: '7db10001-3a7e-4f5c-9b21-51c61a7e0001',
  command: '7db10002-3a7e-4f5c-9b21-51c61a7e0001',
  status: '7db10003-3a7e-4f5c-9b21-51c61a7e0001',
});

export const STATES = ['OPEN_FREE', 'CLOSED_FREE', 'LOCKED_ASSIGNED', 'MOVING', 'FAULT'];
export const ERRORS = [
  'NONE', 'MALFORMED', 'UNKNOWN_COMMAND', 'BUSY', 'ASSIGNED', 'NOT_OPEN',
  'SETUP_REQUIRED', 'UNASSIGNED', 'TOKEN_MISMATCH', 'TIMEOUT',
  'SENSOR_CONFLICT', 'RECOVERY_REQUIRED', 'STORAGE', 'ACTUATOR',
];
export const DEMO_TOKENS = ['A1B2C3D4E5F60718', '9A8B7C6D5E4F3021'];

export function normalizeToken(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{16}$/.test(value)) {
    throw new Error('Use a demo QR containing exactly 16 hexadecimal characters.');
  }
  return value.toUpperCase();
}

export function encodeCommand(opcode, token) {
  if (!['L', 'U', 'C', 'F'].includes(opcode)) throw new Error('Unknown command.');
  if ((opcode === 'C' || opcode === 'F') && token !== undefined) throw new Error('This command has no payload.');
  return new TextEncoder().encode(opcode + (['L', 'U'].includes(opcode) ? normalizeToken(token) : ''));
}

export function decodeStatus(value) {
  const view = value instanceof DataView ? value : new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (view.byteLength !== 12 || view.getUint8(0) !== 1) throw new Error('Unsupported tag status packet.');
  const state = STATES[view.getUint8(1)];
  const error = ERRORS[view.getUint8(2)];
  const flags = view.getUint8(3);
  const command = String.fromCharCode(view.getUint8(10));
  if (!state || !error || flags > 7 || view.getUint8(11) !== 0 || !'-LUCFS'.includes(command)) {
    throw new Error('Invalid tag status packet.');
  }
  const result = {
    state, error, assigned: Boolean(flags & 1), open: Boolean(flags & 2), closed: Boolean(flags & 4),
    setupMs: view.getUint16(4, true), sequence: view.getUint32(6, true), command,
  };
  const expectedFlags = { OPEN_FREE: 2, CLOSED_FREE: 4, LOCKED_ASSIGNED: 5 }[state];
  if ((expectedFlags !== undefined && flags !== expectedFlags) || result.setupMs > 10000) {
    throw new Error('Tag state conflicts with its confirmed switch readings.');
  }
  return result;
}

export function isNewer(sequence, previous) {
  const distance = (sequence - previous) >>> 0;
  return distance > 0 && distance < 0x80000000;
}
