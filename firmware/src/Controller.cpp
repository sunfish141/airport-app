#include "Controller.h"
#include <cstring>

namespace tag {
namespace {
bool normalize(const char* bytes, size_t length, std::array<char, 17>& token) {
  if (length != 16) return false;
  for (size_t i = 0; i < 16; ++i) {
    const char c = bytes[i];
    if (c >= 'a' && c <= 'f') token[i] = c - 'a' + 'A';
    else if ((c >= 'A' && c <= 'F') || (c >= '0' && c <= '9')) token[i] = c;
    else return false;
  }
  token[16] = '\0';
  return true;
}
bool matches(const std::array<char, 17>& a, const std::array<char, 17>& b) {
  uint8_t difference = 0;
  for (size_t i = 0; i < 16; ++i) difference |= uint8_t(a[i] ^ b[i]);
  return difference == 0;
}
uint32_t checksum(const uint8_t* data, size_t length) {
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}
void write32(uint8_t* out, uint32_t value) {
  for (uint8_t i = 0; i < 4; ++i) out[i] = uint8_t(value >> (i * 8));
}
uint32_t read32(const uint8_t* data) {
  uint32_t value = 0;
  for (uint8_t i = 0; i < 4; ++i) value |= uint32_t(data[i]) << (i * 8);
  return value;
}
}

uint16_t Controller::setupRemaining(uint32_t now) const {
  if (!setupActive_) return 0;
  const uint32_t elapsed = now - setupStarted_;
  return elapsed >= config::SETUP_WINDOW_MS ? 0 : config::SETUP_WINDOW_MS - elapsed;
}

void Controller::emit(Error error, char command, uint32_t now) {
  status_.error = error;
  status_.command = command;
  status_.assigned = record_.assigned;
  status_.setupMs = setupRemaining(now);
  ++status_.sequence;
  hardware_.publish(status_);
}

void Controller::fault(Error error, char command, uint32_t now) {
  hardware_.stop();
  status_.state = State::Fault;
  setupActive_ = false;
  record_.fault = true;
  // Keep pending movement and ownership intact for recovery after reset.
  if (!hardware_.save(record_)) error = Error::Storage;
  emit(error, command, now);
}

bool Controller::persist(char command, uint32_t now) {
  if (hardware_.save(record_)) return true;
  hardware_.stop();
  record_.fault = true;
  status_.state = State::Fault;
  setupActive_ = false;
  emit(Error::Storage, command, now);
  return false;
}

void Controller::begin(Record record, LoadResult loaded, Sensors sensors, uint32_t now) {
  record_ = record;
  status_.sensors = sensors;
  hardware_.stop();
  if (loaded == LoadResult::Corrupt || loaded == LoadResult::Unavailable) {
    // Unknown persisted ownership must never become an unassigned tag at boot.
    record_.assigned = true;
    record_.fault = true;
    status_.state = State::Fault;
    emit(loaded == LoadResult::Unavailable ? Error::Storage : Error::RecoveryRequired, '-', now);
    return;
  }
  if (loaded == LoadResult::Missing && !persist('-', now)) return;
  if (sensors.open && sensors.closed) return fault(Error::SensorConflict, '-', now);
  if (record_.fault || record_.pending != Pending::None || (!sensors.open && !sensors.closed) || (record_.assigned && !sensors.closed)) {
    return fault(Error::RecoveryRequired, '-', now);
  }
  status_.state = sensors.open ? State::OpenFree : record_.assigned ? State::LockedAssigned : State::ClosedFree;
  emit(Error::None, '-', now);
}

void Controller::move(Pending direction, char command, uint32_t now) {
  setupActive_ = false;
  record_.pending = direction;
  if (!persist(command, now)) return;
  movementCommand_ = command;
  moveStarted_ = now;
  status_.state = State::Moving;
  if (!hardware_.drive(direction)) return fault(Error::Actuator, command, now);
  emit(Error::None, command, now);
}

void Controller::finish(uint32_t now) {
  hardware_.stop();
  const bool opened = record_.pending == Pending::Open;
  const Record previous = record_;
  if (opened) { record_.assigned = false; record_.token.fill(0); }
  record_.pending = Pending::None;
  record_.fault = false;
  if (!hardware_.save(record_)) {
    // A failed final commit must not report ownership cleared.
    record_ = previous;
    return fault(Error::Storage, movementCommand_, now);
  }
  status_.state = opened ? State::OpenFree : record_.assigned ? State::LockedAssigned : State::ClosedFree;
  emit(Error::None, movementCommand_, now);
}

void Controller::service(uint32_t now) {
  hardware_.stop();
  setupActive_ = false;
  if (status_.sensors.open && status_.sensors.closed) return fault(Error::SensorConflict, 'S', now);
  // Even an already-open recovery saves a pending intent before clearing ownership.
  if (status_.sensors.open) {
    record_.pending = Pending::Open;
    if (!persist('S', now)) return;
    movementCommand_ = 'S';
    finish(now);
  } else move(Pending::Open, 'S', now);
}

void Controller::tick(Sensors sensors, bool button, uint32_t now) {
  status_.sensors = sensors;
  if (sensors.open && sensors.closed) {
    if (status_.state != State::Fault) fault(Error::SensorConflict, movementCommand_, now);
  } else if (status_.state == State::Moving) {
    if (uint32_t(now - moveStarted_) >= config::MOVEMENT_TIMEOUT_MS) fault(Error::Timeout, movementCommand_, now);
    else if ((record_.pending == Pending::Open && sensors.open) || (record_.pending == Pending::Close && sensors.closed)) finish(now);
  } else if (status_.state != State::Fault) {
    const bool expected = status_.state == State::OpenFree ? sensors.open && !sensors.closed : sensors.closed && !sensors.open;
    if (!expected) fault(Error::RecoveryRequired, '-', now);
  }

  if (button && !buttonDown_) { buttonDown_ = true; buttonStarted_ = now; serviceFired_ = false; }
  if (button && !serviceFired_ && uint32_t(now - buttonStarted_) >= config::SERVICE_HOLD_MS) {
    serviceFired_ = true;
    service(now);
  }
  if (!button && buttonDown_) {
    const uint32_t held = now - buttonStarted_;
    buttonDown_ = false;
    if (!serviceFired_ && held >= config::SETUP_HOLD_MS && status_.state == State::OpenFree && !record_.assigned) {
      setupActive_ = true;
      setupStarted_ = now;
      lastSetupSecond_ = 10;
      emit(Error::None, '-', now);
    }
  }
  if (setupActive_) {
    const uint16_t seconds = (setupRemaining(now) + 999) / 1000;
    if (seconds != lastSetupSecond_) {
      lastSetupSecond_ = seconds;
      if (seconds == 0) setupActive_ = false;
      emit(Error::None, '-', now);
    }
  }
}

void Controller::command(const char* bytes, size_t length, uint32_t now) {
  if (length == 0 || length > 17) return emit(Error::Malformed, '-', now);
  const char opcode = bytes[0];
  const bool tokenCommand = opcode == 'L' || opcode == 'U';
  if (!tokenCommand && opcode != 'C' && opcode != 'F') return emit(Error::UnknownCommand, '-', now);
  std::array<char, 17> token{};
  if ((tokenCommand && !normalize(bytes + 1, length - 1, token)) || (!tokenCommand && length != 1)) {
    return emit(Error::Malformed, opcode, now);
  }
  if (status_.state == State::Moving) return emit(Error::Busy, opcode, now);
  if (opcode == 'F') { hardware_.flash(now); return emit(Error::None, opcode, now); }
  if (status_.state == State::Fault) return emit(Error::RecoveryRequired, opcode, now);
  if (opcode == 'L') {
    if (record_.assigned) return emit(Error::Assigned, opcode, now);
    if (status_.state != State::OpenFree) return emit(Error::NotOpen, opcode, now);
    if (!setupRemaining(now)) return emit(Error::SetupRequired, opcode, now);
    record_.assigned = true;
    record_.token = token;
    move(Pending::Close, opcode, now);
  } else if (opcode == 'U') {
    if (!record_.assigned) return emit(Error::Unassigned, opcode, now);
    if (!matches(token, record_.token)) return emit(Error::TokenMismatch, opcode, now);
    move(Pending::Open, opcode, now);
  } else {
    if (record_.assigned) return emit(Error::Assigned, opcode, now);
    if (status_.state != State::OpenFree) return emit(Error::NotOpen, opcode, now);
    move(Pending::Close, opcode, now);
  }
}

std::array<uint8_t, RECORD_SIZE> encodeRecord(const Record& record) {
  std::array<uint8_t, RECORD_SIZE> bytes{};
  bytes[0] = 'L'; bytes[1] = 'T'; bytes[2] = 'A'; bytes[3] = 'G'; bytes[4] = 1;
  bytes[5] = uint8_t(record.assigned) | (uint8_t(record.fault) << 1);
  bytes[6] = uint8_t(record.pending);
  std::memcpy(bytes.data() + 8, record.token.data(), 16);
  write32(bytes.data() + 24, checksum(bytes.data(), 24));
  return bytes;
}

bool decodeRecord(const uint8_t* bytes, size_t length, Record& record) {
  if (length != RECORD_SIZE || std::memcmp(bytes, "LTAG", 4) != 0 || bytes[4] != 1 || bytes[5] > 3 || bytes[6] > 2 || bytes[7] != 0 || read32(bytes + 24) != checksum(bytes, 24)) return false;
  Record decoded;
  decoded.assigned = bytes[5] & 1;
  decoded.fault = bytes[5] & 2;
  decoded.pending = Pending(bytes[6]);
  if (decoded.assigned) {
    if (!normalize(reinterpret_cast<const char*>(bytes + 8), 16, decoded.token)) return false;
  } else {
    for (size_t i = 8; i < 24; ++i) if (bytes[i] != 0) return false;
  }
  record = decoded;
  return true;
}

std::array<uint8_t, 12> encodeStatus(const Status& status) {
  std::array<uint8_t, 12> bytes{};
  bytes[0] = 1; bytes[1] = uint8_t(status.state); bytes[2] = uint8_t(status.error);
  bytes[3] = uint8_t(status.assigned) | (uint8_t(status.sensors.open) << 1) | (uint8_t(status.sensors.closed) << 2);
  bytes[4] = uint8_t(status.setupMs); bytes[5] = uint8_t(status.setupMs >> 8);
  write32(bytes.data() + 6, status.sequence);
  bytes[10] = uint8_t(status.command);
  return bytes;
}
}
