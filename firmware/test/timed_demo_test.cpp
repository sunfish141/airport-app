#include "Controller.h"
#include "ServoMotion.h"
#include "BoardConfig.h"
#include <cassert>
#include <cstring>
#include <iostream>

using namespace tag;
const char* A = "A1B2C3D4E5F60718";
const char* B = "9A8B7C6D5E4F3021";
struct DemoHardware : Hardware {
  Record saved;
  bool writable = true, actuator = true;
  unsigned drives = 0, stops = 0;
  bool save(const Record& record) override { if (!writable) return false; saved = record; return true; }
  bool drive(Pending direction) override { assert(saved.pending == direction); ++drives; return actuator; }
  void stop() override { ++stops; }
  void flash(uint32_t) override {}
  void publish(const Status&) override {}
};
void send(Controller& controller, char command, const char* token, uint32_t now) {
  char bytes[17]; bytes[0] = command;
  if (token) std::memcpy(bytes + 1, token, 16);
  controller.command(bytes, token ? 17 : 1, now);
}
void startupAndCycles() {
  DemoHardware hardware; Controller controller(hardware, Mode::TimedDemo);
  controller.begin({}, LoadResult::Missing, {false, false}, 0);
  assert(controller.status().state == State::Moving && hardware.drives == 1);
  controller.tick({false, false}, false, 499);
  assert(controller.status().state == State::Moving);
  controller.tick({false, false}, false, 500);
  assert(controller.status().state == State::OpenFree && controller.status().timedDemo);
  assert(!controller.record().assigned && controller.status().setupMs == 0);
  for (uint32_t i = 0; i < 20; ++i) {
    const uint32_t now = 1100 + i * 2200;
    send(controller, 'L', A, now); // No setup hold or endpoint contacts.
    assert(controller.status().state == State::Moving && hardware.saved.assigned);
    controller.tick({false, true}, false, now + 499); // Even an early contact is not completion.
    assert(controller.status().state == State::Moving);
    controller.tick({false, false}, false, now + 500);
    assert(controller.status().state == State::LockedAssigned);
    const auto drives = hardware.drives;
    send(controller, 'U', B, now + 1001);
    assert(controller.status().error == Error::TokenMismatch && hardware.drives == drives);
    send(controller, 'U', A, now + 1100);
    controller.tick({false, false}, false, now + 1599);
    assert(controller.status().state == State::Moving && controller.record().assigned);
    controller.tick({false, false}, false, now + 1600);
    assert(controller.status().state == State::OpenFree && !controller.record().assigned);
  }
  assert(encodeStatus(controller.status())[11] == 1);
}
void bootResetAndFailures() {
  DemoHardware hardware;
  Record previous; previous.assigned = previous.fault = true; previous.pending = Pending::Close;
  std::memcpy(previous.token.data(), A, 16);
  Controller controller(hardware, Mode::TimedDemo);
  controller.begin(previous, LoadResult::Valid, {true, true}, 0);
  controller.tick({true, true}, false, 1000); // Ignored contacts in timed mode.
  assert(controller.status().state == State::OpenFree && !controller.record().assigned);
  controller.tick({false, false}, true, 1001);
  controller.tick({false, false}, false, 1601);
  assert(controller.status().setupMs == 0);
  controller.tick({false, false}, true, 2000);
  controller.tick({false, false}, true, 5000);
  assert(controller.status().state == State::Moving);
  controller.tick({false, false}, true, 6000);
  assert(controller.status().state == State::OpenFree);
  const auto drives = hardware.drives;
  controller.tick({false, false}, true, 9000);
  assert(hardware.drives == drives);
  DemoHardware bad; bad.writable = false;
  Controller storage(bad, Mode::TimedDemo);
  storage.begin({}, LoadResult::Unavailable, {false, false}, 0);
  assert(storage.status().error == Error::Storage && bad.drives == 0);
  DemoHardware stalled; stalled.actuator = false;
  Controller actuator(stalled, Mode::TimedDemo);
  actuator.begin({}, LoadResult::Missing, {false, false}, 0);
  assert(actuator.status().error == Error::Actuator && actuator.status().state == State::Fault);
  DemoHardware failed; Controller commit(failed, Mode::TimedDemo);
  commit.begin({}, LoadResult::Missing, {false, false}, 0);
  commit.tick({false, false}, false, 1000);
  send(commit, 'L', A, 1001);
  commit.tick({false, false}, false, 2001);
  send(commit, 'U', A, 2002); failed.writable = false;
  commit.tick({false, false}, false, 3002);
  assert(commit.status().state == State::Fault && commit.record().assigned);
}
void rampAndWrap() {
  const auto open = boardconfig::OPEN_PULSE_US, closed = boardconfig::CLOSED_PULSE_US;
  const uint32_t sweep = config::DEMO_SWEEP_MS;
  ServoMotion motion;
  motion.start(open, 0, sweep);
  assert(motion.value(0) == 1500 && motion.value(sweep / 2) == (1500 + open) / 2 && motion.value(sweep) == open);
  const uint32_t closeAt = config::DEMO_MOVEMENT_MS;
  motion.stop(closeAt); motion.start(closed, closeAt, sweep);
  uint16_t previous = open;
  for (uint32_t t = closeAt; t <= closeAt + sweep; ++t) {
    const auto pulse = motion.value(t);
    assert(pulse >= previous && pulse >= open && pulse <= closed); previous = pulse;
  }
  const uint32_t reverseAt = closeAt + sweep / 2;
  motion.stop(reverseAt); // Interrupt halfway and reverse without a pulse jump.
  const auto middle = motion.value(reverseAt);
  motion.start(open, reverseAt, sweep);
  assert(motion.value(reverseAt) == middle && motion.value(reverseAt + sweep) == open);
  motion.start(closed, 0xffffff00, sweep);
  assert(motion.value(uint32_t(0xffffff00u + sweep / 2)) == (open + closed) / 2);
  assert(motion.value(uint32_t(0xffffff00u + sweep)) == closed);
  DemoHardware hardware; Controller controller(hardware, Mode::TimedDemo);
  controller.begin({}, LoadResult::Missing, {false, false}, 0xffffff00);
  controller.tick({false, false}, false, uint32_t(0xffffff00u + 499));
  assert(controller.status().state == State::Moving);
  controller.tick({false, false}, false, uint32_t(0xffffff00u + 500));
  assert(controller.status().state == State::OpenFree);
}
int main() {
  startupAndCycles(); bootResetAndFailures(); rampAndWrap();
  std::cout << "Timed demo: startup, 20 lock/release cycles, pass rejection, storage/actuator failures and servo ramp checks passed.\n";
}
