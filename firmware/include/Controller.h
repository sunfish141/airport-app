#pragma once
#include <stddef.h>
#include <stdint.h>
#include <array>
#include "Config.h"

namespace tag {
enum class State : uint8_t { OpenFree, ClosedFree, LockedAssigned, Moving, Fault };
enum class Error : uint8_t {
  None, Malformed, UnknownCommand, Busy, Assigned, NotOpen, SetupRequired,
  Unassigned, TokenMismatch, Timeout, SensorConflict, RecoveryRequired, Storage, Actuator
};
enum class Pending : uint8_t { None, Open, Close };
enum class LoadResult { Missing, Valid, Corrupt, Unavailable };
enum class Mode { PositionFeedback, TimedDemo };
struct Record {
  bool assigned = false;
  bool fault = false;
  Pending pending = Pending::None;
  std::array<char, 17> token{};
};
struct Sensors { bool open; bool closed; };
struct Status {
  State state = State::Fault;
  Error error = Error::None;
  bool assigned = false;
  Sensors sensors{false, false};
  uint16_t setupMs = 0;
  uint32_t sequence = 0;
  char command = '-';
  bool timedDemo = false;
};
struct Hardware {
  virtual ~Hardware() = default;
  virtual bool save(const Record& record) = 0;
  virtual bool drive(Pending direction) = 0;
  virtual void stop() = 0;
  virtual void flash(uint32_t now) = 0;
  virtual void publish(const Status& status) = 0;
};

class DebouncedInput {
 public:
  void update(bool pressed, uint32_t now) {
    if (!initialized_ || pressed != candidate_) {
      initialized_ = true; candidate_ = pressed; changed_ = now;
    }
    if (uint32_t(now - changed_) >= config::DEBOUNCE_MS) { stable_ = candidate_; ready_ = true; }
  }
  bool pressed() const { return stable_; }
  bool ready() const { return ready_; }
 private:
  bool initialized_ = false, ready_ = false, stable_ = false, candidate_ = false;
  uint32_t changed_ = 0;
};

class Controller {
 public:
  explicit Controller(Hardware& hardware, Mode mode = Mode::PositionFeedback) : hardware_(hardware), mode_(mode) {
    status_.timedDemo = mode == Mode::TimedDemo;
  }
  void begin(Record record, LoadResult loaded, Sensors sensors, uint32_t now);
  void tick(Sensors sensors, bool button, uint32_t now);
  void command(const char* bytes, size_t length, uint32_t now);
  void rejectBusy(uint32_t now) { emit(Error::Busy, '-', now); }
  const Record& record() const { return record_; }
  const Status& status() const { return status_; }
 private:
  Hardware& hardware_;
  Mode mode_;
  Record record_;
  Status status_;
  bool setupActive_ = false, buttonDown_ = false, serviceFired_ = false;
  uint32_t setupStarted_ = 0, moveStarted_ = 0, buttonStarted_ = 0;
  uint16_t lastSetupSecond_ = 0;
  char movementCommand_ = '-';
  uint16_t setupRemaining(uint32_t now) const;
  void emit(Error error, char command, uint32_t now);
  void fault(Error error, char command, uint32_t now);
  bool persist(char command, uint32_t now);
  void move(Pending direction, char command, uint32_t now);
  void finish(uint32_t now);
  void service(uint32_t now);
};

constexpr size_t RECORD_SIZE = 28;
std::array<uint8_t, RECORD_SIZE> encodeRecord(const Record& record);
bool decodeRecord(const uint8_t* bytes, size_t length, Record& record);
std::array<uint8_t, 12> encodeStatus(const Status& status);
}
