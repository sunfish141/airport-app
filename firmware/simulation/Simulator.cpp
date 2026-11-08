// Host hardware adapter. Controller.cpp, Controller.h and Config.h are compiled
// unchanged alongside this file. No Arduino/NimBLE/ESP32 CPU is emulated here.
#include "Controller.h"
#include "BoardConfig.h"
#include "ServoMotion.h"
#include <new>
#include <cstring>

namespace {
struct Trace { uint32_t id, ms, code, a, b; };
Trace traces[256]{};
std::array<uint8_t, 12> tracePackets[256]{};
uint32_t traceId = 0, worldMs = 0, bootAt = 0;
void trace(uint32_t code, uint32_t a = 0, uint32_t b = 0) {
  ++traceId;
  traces[traceId % 256] = {traceId, worldMs, code, a, b};
}
std::array<uint8_t, tag::RECORD_SIZE> nvs{};
std::array<uint8_t, 12> packet{};
char commandBuffer[64]{};
bool nvsPresent = false, failWrites = false, powered = true, ready = false;
bool pwm = false, jam = false, cable = true, rawButton = false, led = false;
bool flashing = false, automaticRelease = false;
uint32_t flashAt = 0, releaseAt = 0, buttonAt = 0, saves = 0, tickRemainder = 0;
uint32_t travelMs = 650;
float position = 0.0f, target = 0.0f;
uint16_t pulseUs = 0;
int sensorMode = 0;
bool idealOpen = true, idealClosed = false, rawOpen = true, rawClosed = false;
uint32_t openChanged = 0, closedChanged = 0;
uint8_t lastRaw = 255, lastDebounced = 255;
tag::DebouncedInput openInput, closedInput, buttonInput;
struct Message { uint8_t length; char bytes[17]; };
Message queue[8]{};
uint8_t queueHead = 0, queueLength = 0;
bool overflow = false;
bool timedDemo = false;
ServoMotion servoMotion;
uint32_t uptime();

class SimHardware : public tag::Hardware {
 public:
  bool save(const tag::Record& record) override {
    if (failWrites) { trace(2); return false; }
    nvs = tag::encodeRecord(record);
    nvsPresent = true;
    ++saves;
    trace(1, uint32_t(record.assigned) | (uint32_t(record.fault) << 1), uint32_t(record.pending));
    return true;
  }
  bool drive(tag::Pending direction) override {
    pwm = true;
    target = direction == tag::Pending::Open ? 0.0f : 1.0f;
    const uint16_t targetPulse = direction == tag::Pending::Open ? boardconfig::OPEN_PULSE_US : boardconfig::CLOSED_PULSE_US;
    servoMotion.start(targetPulse, uptime(), timedDemo ? config::DEMO_SWEEP_MS : 0);
    pulseUs = servoMotion.value(uptime());
    trace(3, pulseUs, uint32_t(direction));
    return true;
  }
  void stop() override {
    servoMotion.stop(uptime());
    if (pwm) trace(4);
    pwm = false;
    pulseUs = 0;
  }
  void flash(uint32_t now) override { flashing = true; flashAt = now; }
  void publish(const tag::Status& status) override {
    packet = tag::encodeStatus(status);
    trace(5, uint32_t(status.state), uint32_t(status.error));
    tracePackets[traceId % 256] = packet;
  }
} hardware;
tag::Controller controller(hardware);

uint32_t uptime() { return worldMs - bootAt; }
void restart() {
  hardware.stop();
  controller.~Controller();
  new (&controller) tag::Controller(hardware, timedDemo ? tag::Mode::TimedDemo : tag::Mode::PositionFeedback);
  servoMotion = ServoMotion();
  openInput = tag::DebouncedInput();
  closedInput = tag::DebouncedInput();
  buttonInput = tag::DebouncedInput();
  ready = false;
  bootAt = worldMs;
  flashing = led = false;
  queueHead = queueLength = 0;
  overflow = false;
  lastRaw = lastDebounced = 255;
  trace(0);
}

bool bounce(bool ideal, uint32_t changed) {
  const uint32_t age = worldMs - changed;
  return age < 12 && (age / 2) % 2 == 0 ? !ideal : ideal;
}
void plant() {
  if (pwm) {
    pulseUs = servoMotion.value(uptime());
    if (timedDemo) {
      target = float(int(pulseUs) - int(boardconfig::OPEN_PULSE_US)) /
               float(int(boardconfig::CLOSED_PULSE_US) - int(boardconfig::OPEN_PULSE_US));
      if (target < 0) target = 0;
      if (target > 1) target = 1;
    }
    const float delta = 2.0f / float(travelMs);
    if (target > position) {
      const float limit = jam ? 0.48f : target;
      if (position < limit) position = position + delta < limit ? position + delta : limit;
    } else if (target < position) {
      const float limit = jam ? 0.52f : target;
      if (position > limit) position = position - delta > limit ? position - delta : limit;
    }
  }
}
void sample() {
  bool open = position <= 0.02f;
  bool closed = position >= 0.98f;
  if (sensorMode == 1) open = closed = true;
  if (sensorMode == 2) open = closed = false;
  if (sensorMode == 3) open = false;
  if (sensorMode == 4) closed = false;
  // D32/D33 are unconnected on the timed-demo board (pull-ups read HIGH).
  if (timedDemo) open = closed = false;
  if (open != idealOpen) { idealOpen = open; openChanged = worldMs; }
  if (closed != idealClosed) { idealClosed = closed; closedChanged = worldMs; }
  rawOpen = bounce(idealOpen, openChanged);
  rawClosed = bounce(idealClosed, closedChanged);
  const uint8_t raw = uint8_t(rawOpen) | (uint8_t(rawClosed) << 1) | (uint8_t(rawButton) << 2);
  if (raw != lastRaw) { trace(6, raw); lastRaw = raw; }
  openInput.update(rawOpen, uptime());
  closedInput.update(rawClosed, uptime());
  buttonInput.update(rawButton, uptime());
  const uint8_t stable = uint8_t(openInput.pressed()) | (uint8_t(closedInput.pressed()) << 1) | (uint8_t(buttonInput.pressed()) << 2);
  if (stable != lastDebounced) { trace(7, stable); lastDebounced = stable; }
}
void tick() {
  // The main switch cuts controller and servo supply together in this model.
  if (!powered) return;
  plant();
  if (automaticRelease && worldMs >= releaseAt) {
    automaticRelease = false;
    rawButton = false;
    trace(8, 0);
  }
  sample();
  if (!ready) {
    if (!openInput.ready() || !closedInput.ready() || !buttonInput.ready()) return;
    tag::Record record;
    const auto loaded = !nvsPresent ? tag::LoadResult::Missing : tag::decodeRecord(nvs.data(), nvs.size(), record) ? tag::LoadResult::Valid : tag::LoadResult::Corrupt;
    controller.begin(record, loaded, {openInput.pressed(), closedInput.pressed()}, uptime());
    ready = true;
    return;
  }
  // Same order as main.cpp: sample/debounce -> tick -> one queued command -> LED.
  controller.tick({openInput.pressed(), closedInput.pressed()}, buttonInput.pressed(), uptime());
  if (queueLength) {
    const Message message = queue[queueHead];
    queueHead = (queueHead + 1) % 8;
    --queueLength;
    trace(10, message.length ? uint8_t(message.bytes[0]) : 0, message.length);
    controller.command(message.bytes, message.length, uptime());
  }
  if (overflow) { overflow = false; trace(11); controller.rejectBusy(uptime()); }
  if (flashing && uint32_t(uptime() - flashAt) >= 2000) flashing = false;
  const bool fault = controller.status().state == tag::State::Fault;
  const bool setup = controller.status().setupMs > 0;
  led = flashing ? (uint32_t(uptime() - flashAt) / 100) % 2 : fault ? (uptime() / 250) % 2 : setup ? (uptime() / 500) % 2 : false;
}
}

extern "C" {
void sim_mode(int timed) { timedDemo = bool(timed); restart(); }
void sim_reset() {
  hardware.stop();
  worldMs = bootAt = traceId = tickRemainder = saves = 0;
  nvs.fill(0); packet.fill(0); nvsPresent = failWrites = jam = rawButton = false;
  automaticRelease = false;
  cable = powered = true;
  sensorMode = 0;
  travelMs = 650;
  position = target = 0.0f;
  idealOpen = rawOpen = true;
  idealClosed = rawClosed = false;
  openChanged = closedChanged = 0;
  restart();
}
void sim_advance(uint32_t ms) {
  if (ms > 60000) ms = 60000;
  tickRemainder += ms;
  while (tickRemainder >= 2) { tickRemainder -= 2; worldMs += 2; tick(); }
}
void sim_button(int pressed) {
  automaticRelease = false;
  if (rawButton != bool(pressed)) { rawButton = bool(pressed); if (rawButton) buttonAt = worldMs; trace(8, rawButton); }
}
void sim_hold(uint32_t ms) { sim_button(1); automaticRelease = true; releaseAt = worldMs + ms; }
void sim_power(int on) {
  if (powered == bool(on)) return;
  powered = bool(on);
  trace(9, powered);
  if (!powered) { hardware.stop(); led = false; ready = false; }
  else restart();
}
void sim_faults(int obstruction, int sensors, int storageFailure) {
  jam = bool(obstruction);
  sensorMode = sensors >= 0 && sensors <= 4 ? sensors : 0;
  failWrites = bool(storageFailure);
}
void sim_travel(uint32_t ms) { travelMs = ms < 100 ? 100 : ms > 3000 ? 3000 : ms; }
int sim_cable(int inserted) {
  if (position > 0.15f && cable != bool(inserted)) { trace(12, 2); return 0; }
  cable = bool(inserted); trace(12, cable); return 1;
}
void sim_corrupt() { if (nvsPresent) { nvs[24] ^= 1; trace(13); } }
uint8_t* sim_record_ptr() { return nvs.data(); }
void sim_restore(int present, float boltPosition, int inserted) {
  nvsPresent = bool(present);
  saves = 0; // Discard the bootstrap empty-record write replaced by this saved flash.
  position = boltPosition < 0 ? 0 : boltPosition > 1 ? 1 : boltPosition;
  cable = bool(inserted);
  idealOpen = position <= 0.02f;
  idealClosed = position >= 0.98f;
  openChanged = closedChanged = worldMs;
  restart();
}
char* sim_command_ptr() { return commandBuffer; }
int sim_command(uint32_t length) {
  if (!powered || !ready) return 0;
  if (queueLength == 8) { overflow = true; return 0; }
  Message& message = queue[(queueHead + queueLength) % 8];
  message.length = length > 17 ? 18 : uint8_t(length);
  if (message.length <= 17) std::memcpy(message.bytes, commandBuffer, message.length);
  ++queueLength;
  return 1;
}
uint8_t* sim_status_ptr() { return packet.data(); }
float sim_position() { return position; }
int sim_manual_position(float value) {
  if (pwm) return 0;
  position = value < 0 ? 0 : value > 1 ? 1 : value;
  return 1;
}
int sim_config(int key) {
  switch (key) {
    case 0: return config::DEBOUNCE_MS;
    case 1: return config::SETUP_HOLD_MS;
    case 2: return config::SERVICE_HOLD_MS;
    case 3: return config::SETUP_WINDOW_MS;
    case 4: return config::MOVEMENT_TIMEOUT_MS;
    case 5: return boardconfig::OPEN_PULSE_US;
    case 6: return boardconfig::CLOSED_PULSE_US;
    case 7: return boardconfig::SERVO_PIN;
    case 8: return boardconfig::OPEN_PIN;
    case 9: return boardconfig::CLOSED_PIN;
    case 10: return boardconfig::BUTTON_PIN;
    case 11: return boardconfig::LED_PIN;
    case 12: return boardconfig::SERVO_HZ;
    case 13: return timedDemo;
    case 14: return config::DEMO_MOVEMENT_MS;
    case 15: return config::DEMO_SWEEP_MS;
    default: return 0;
  }
}
uint32_t sim_trace_count() { return traceId; }
Trace* sim_trace_ptr(uint32_t id) { return &traces[id % 256]; }
uint8_t* sim_trace_status_ptr(uint32_t id) { return tracePackets[id % 256].data(); }
int sim_value(int key) {
  tag::Record stored;
  const bool valid = nvsPresent && tag::decodeRecord(nvs.data(), nvs.size(), stored);
  switch (key) {
    case 0: return int(controller.status().state);
    case 1: return int(controller.status().error);
    case 2: return controller.record().assigned;
    case 3: return rawOpen;
    case 4: return rawClosed;
    case 5: return openInput.pressed();
    case 6: return closedInput.pressed();
    case 7: return rawButton;
    case 8: return buttonInput.pressed();
    case 9: return pwm;
    case 10: return pulseUs;
    case 11: return int(controller.record().pending);
    case 12: return valid ? stored.assigned : -1;
    case 13: return valid ? int(stored.pending) : -1;
    case 14: return controller.record().fault;
    case 15: return !nvsPresent ? 0 : valid ? 1 : 2;
    case 16: return ready;
    case 17: return powered;
    case 18: return led;
    case 19: return int(uptime());
    case 20: return int(worldMs);
    case 21: return int(saves);
    case 22: return cable;
    case 23: return sensorMode;
    case 24: return failWrites;
    case 25: return jam;
    case 26: return rawButton ? int(worldMs - buttonAt) : 0;
    case 27: return flashing;
    case 28: return int(travelMs);
    case 29: return valid ? stored.fault : -1;
    case 30: return servoMotion.value(uptime());
    default: return -1;
  }
}
}
