import { UUIDS } from '../../app/src/protocol.js';

function uuid(value) { return value.toLowerCase(); }
function missing(message) { return new DOMException(message, 'NotFoundError'); }
function cancelled() { return new Error('Connection interrupted.'); }
async function nativeCall(operation) {
  try { return await operation(); }
  catch (error) {
    if (/denied|not authorized|not authorised|not permitted/i.test(error.message)) {
      throw new DOMException('Allow Bluetooth access in your phone settings.', 'NotAllowedError');
    }
    throw error;
  }
}

// Adapt native BLE to the small GATT surface used by TagConnection. Protocol
// validation, command confirmation, timeouts and retries stay in shared code.
export class NativeBluetooth {
  constructor(client, getSaved = () => null) {
    this.client = client;
    this.getSaved = getSaved;
    this.devices = new Map();
  }
  async initialize() {
    // The finder derives proximity, so do not assert neverForLocation.
    await nativeCall(() => this.client.initialize());
    if (!await this.client.isEnabled()) throw new Error('Turn on Bluetooth to connect your tag.');
  }
  wrap(info) {
    let device = this.devices.get(info.deviceId);
    if (!device) {
      device = new NativeDevice(this.client, info);
      this.devices.set(device.id, device);
    } else if (info.name) device.name = info.name;
    return device;
  }
  async requestDevice() {
    await this.initialize();
    return this.wrap(await nativeCall(() => this.client.requestDevice({ services: [UUIDS.service] })));
  }
  async getDevices() {
    const saved = this.getSaved();
    if (!saved?.id) return [];
    await this.initialize();
    const devices = await this.client.getDevices([saved.id]);
    return devices.filter((item) => item.deviceId === saved.id)
      .map((item) => this.wrap({ ...item, name: item.name || saved.name }));
  }
}

class NativeDevice extends EventTarget {
  constructor(client, info) {
    super();
    this.id = info.deviceId;
    this.name = info.name || 'Luggage tag';
    this.gatt = new NativeGatt(client, this);
  }
}
class NativeGatt {
  constructor(client, device) {
    Object.assign(this, { client, device });
    this.connected = false;
    this.epoch = 0;
    this.tail = Promise.resolve();
  }
  connect() {
    const epoch = ++this.epoch;
    const task = this.tail.then(async () => {
      if (epoch !== this.epoch) throw cancelled();
      await nativeCall(() => this.client.connect(this.device.id, () => {
        if (epoch !== this.epoch) return;
        this.connected = false;
        ++this.epoch;
        this.device.dispatchEvent(new Event('gattserverdisconnected'));
      }, { timeout: 9000 }));
      if (epoch !== this.epoch) {
        await this.client.disconnect(this.device.id).catch(() => {});
        throw cancelled();
      }
      this.connected = true;
      return this;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  disconnect() {
    ++this.epoch;
    this.connected = false;
    const cleanup = this.client.disconnect(this.device.id).catch(() => {});
    // Let a cancelled connect finish cleanup before allowing a new one.
    this.tail = Promise.allSettled([this.tail, cleanup]);
  }
  async getPrimaryService(serviceId) {
    const epoch = this.epoch;
    const services = await this.client.getServices(this.device.id);
    if (!this.connected || epoch !== this.epoch) throw cancelled();
    const service = services.find((item) => uuid(item.uuid) === uuid(serviceId));
    if (!service) throw missing('This device is not a Carry tag.');
    return {
      getCharacteristic: async (characteristicId) => {
        if (!this.connected || epoch !== this.epoch) throw cancelled();
        if (!service.characteristics.some((item) => uuid(item.uuid) === uuid(characteristicId))) throw missing('Characteristic unavailable.');
        return new NativeCharacteristic(this, serviceId, characteristicId, epoch);
      },
    };
  }
}
class NativeCharacteristic extends EventTarget {
  constructor(gatt, service, characteristic, epoch) {
    super();
    Object.assign(this, { gatt, service, characteristic, epoch });
  }
  check() { if (!this.gatt.connected || this.gatt.epoch !== this.epoch) throw cancelled(); }
  async readValue() {
    this.check();
    const value = await this.gatt.client.read(this.gatt.device.id, this.service, this.characteristic);
    this.check();
    return value;
  }
  async writeValueWithResponse(bytes) {
    this.check();
    await this.gatt.client.write(this.gatt.device.id, this.service, this.characteristic,
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.check();
  }
  async startNotifications() {
    this.check();
    await this.gatt.client.startNotifications(this.gatt.device.id, this.service, this.characteristic, (value) => {
      if (!this.gatt.connected || this.gatt.epoch !== this.epoch) return;
      this.value = value;
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    });
    this.check();
    return this;
  }
}
