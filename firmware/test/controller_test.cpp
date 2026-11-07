#include "Controller.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

using namespace tag;
const char* TOKEN_A = "A1B2C3D4E5F60718";
const char* TOKEN_B = "9A8B7C6D5E4F3021";

struct Fake : Hardware {
  Record saved;
  bool writable = true, actuator = true, persisted = false;
  unsigned drives = 0, stops = 0, flashes = 0, writes = 0;
  std::vector<Status> events;
  bool save(const Record& record) override {
    ++writes;
    if (!writable) return false;
    saved = record; persisted = true; return true;
  }
  bool drive(Pending direction) override {
    // Prove the exact assignment and intent were committed before actuation.
    assert(persisted && saved.pending == direction);
    ++drives; return actuator;
  }
  void stop() override { ++stops; }
  void flash(uint32_t) override { ++flashes; }
  void publish(const Status& status) override { events.push_back(status); }
};

void send(Controller& controller, char opcode, const char* token, uint32_t now) {
  char bytes[18]{};
  bytes[0] = opcode;
  if (token) std::memcpy(bytes + 1, token, 16);
  controller.command(bytes, token ? 17 : 1, now);
}
void setupWindow(Controller& controller, uint32_t start) {
  controller.tick({true, false}, true, start);
  controller.tick({true, false}, false, start + 500);
  assert(controller.status().setupMs == 10000);
}
void assigned(Fake& hardware, Controller& controller) {
  controller.begin({}, LoadResult::Missing, {true, false}, 0);
  setupWindow(controller, 0);
  send(controller, 'L', TOKEN_A, 501);
  assert(controller.status().state == State::Moving && hardware.saved.assigned);
  controller.tick({false, true}, false, 601);
  assert(controller.status().state == State::LockedAssigned);
}

void cyclesAndReassignment() {
  Fake hardware; Controller controller(hardware);
  controller.begin({}, LoadResult::Missing, {true, false}, 0);
  for (uint32_t cycle = 0; cycle < 20; ++cycle) {
    const uint32_t now = cycle * 3000;
    const char* token = cycle % 2 ? TOKEN_B : TOKEN_A;
    const char* wrong = cycle % 2 ? TOKEN_A : TOKEN_B;
    setupWindow(controller, now);
    send(controller, 'L', token, now + 501);
    assert(hardware.saved.assigned && hardware.saved.pending == Pending::Close);
    assert(controller.status().state == State::Moving);
    controller.tick({false, false}, false, now + 530);
    assert(controller.status().state == State::Moving);
    controller.tick({false, true}, false, now + 600);
    assert(controller.status().state == State::LockedAssigned);
    const unsigned before = hardware.drives;
    send(controller, 'U', wrong, now + 601);
    assert(controller.status().error == Error::TokenMismatch && hardware.drives == before && hardware.saved.assigned);
    send(controller, 'U', token, now + 602);
    controller.tick({false, false}, false, now + 650);
    assert(hardware.saved.assigned && controller.status().state == State::Moving);
    controller.tick({true, false}, false, now + 700);
    assert(controller.status().state == State::OpenFree && !hardware.saved.assigned);
    for (char c : hardware.saved.token) assert(c == 0);
  }
  assert(hardware.drives == 40);
}

void validation() {
  Fake hardware; Controller controller(hardware);
  controller.begin({}, LoadResult::Missing, {true, false}, 0);
  send(controller, 'L', TOKEN_A, 1);
  assert(controller.status().error == Error::SetupRequired);
  const char* malformed[] = {"", "L", "C0", "F0", "L123456789012345G", "L12345678901234567", "U123456789012345\n"};
  for (const char* value : malformed) {
    controller.command(value, std::strlen(value), 2);
    assert(controller.status().error == Error::Malformed && hardware.drives == 0);
  }
  controller.command("?", 1, 2);
  assert(controller.status().error == Error::UnknownCommand);
  setupWindow(controller, 10);
  send(controller, 'L', "a1b2c3d4e5f60718", 511);
  assert(std::strcmp(hardware.saved.token.data(), TOKEN_A) == 0);
  send(controller, 'U', TOKEN_A, 512);
  assert(controller.status().error == Error::Busy && hardware.drives == 1);
  controller.tick({false, true}, false, 600);
  send(controller, 'C', nullptr, 601);
  assert(controller.status().error == Error::Assigned);
  send(controller, 'L', TOKEN_B, 602);
  assert(controller.status().error == Error::Assigned);
}

void rebootPreservesOwnership() {
  Fake hardware; Controller controller(hardware); assigned(hardware, controller);
  const auto saved = hardware.saved;
  const unsigned drives = hardware.drives;
  Controller reboot(hardware);
  reboot.begin(saved, LoadResult::Valid, {false, true}, 0);
  assert(reboot.status().state == State::LockedAssigned && hardware.drives == drives);
  Controller unexpectedOpen(hardware);
  unexpectedOpen.begin(saved, LoadResult::Valid, {true, false}, 0);
  assert(unexpectedOpen.status().state == State::Fault && hardware.saved.assigned);
  send(unexpectedOpen, 'U', TOKEN_A, 1);
  assert(unexpectedOpen.status().error == Error::RecoveryRequired);
  unexpectedOpen.tick({true, false}, true, 10);
  unexpectedOpen.tick({true, false}, true, 3010);
  assert(unexpectedOpen.status().state == State::OpenFree && !hardware.saved.assigned);
}

void interruptedMovement() {
  for (Pending direction : {Pending::Close, Pending::Open}) {
    Fake hardware; Controller controller(hardware); assigned(hardware, controller);
    if (direction == Pending::Open) send(controller, 'U', TOKEN_A, 700);
    else {
      hardware.saved.pending = Pending::Close;
    }
    const Record interrupted = hardware.saved;
    for (Sensors sensors : {Sensors{true, false}, Sensors{false, true}, Sensors{false, false}}) {
      Controller reboot(hardware);
      const auto drives = hardware.drives;
      reboot.begin(interrupted, LoadResult::Valid, sensors, 0);
      assert(reboot.status().state == State::Fault && reboot.record().assigned && hardware.drives == drives);
    }
  }
}

void timeoutAndRecovery() {
  Fake hardware; Controller controller(hardware); assigned(hardware, controller);
  send(controller, 'U', TOKEN_A, 700);
  controller.tick({false, false}, false, 1700);
  assert(controller.status().state == State::Fault && controller.status().error == Error::Timeout);
  assert(hardware.saved.assigned && hardware.saved.pending == Pending::Open && hardware.saved.fault);
  const unsigned drives = hardware.drives;
  controller.tick({true, false}, false, 1800);
  assert(hardware.saved.assigned && hardware.drives == drives); // No late success, no retry.
  Controller reboot(hardware);
  reboot.begin(hardware.saved, LoadResult::Valid, {false, true}, 0);
  reboot.tick({false, true}, true, 1);
  reboot.tick({false, true}, true, 3001);
  assert(reboot.status().state == State::Moving);
  reboot.tick({true, false}, true, 3100);
  assert(reboot.status().state == State::OpenFree && !hardware.saved.assigned);
  const auto afterService = hardware.drives;
  reboot.tick({true, false}, true, 10000);
  assert(hardware.drives == afterService); // Once per physical press.
  Fake lateHardware; Controller late(lateHardware); assigned(lateHardware, late);
  send(late, 'U', TOKEN_A, 700);
  late.tick({true, false}, false, 1700);
  assert(late.status().error == Error::Timeout && late.record().assigned); // No confirmation at/after deadline.
}

void storageAndButton() {
  Fake hardware; Controller controller(hardware);
  controller.begin({}, LoadResult::Missing, {true, false}, 0);
  controller.tick({true, false}, true, 0);
  controller.tick({true, false}, false, 499);
  assert(controller.status().setupMs == 0);
  setupWindow(controller, 1000);
  send(controller, 'L', TOKEN_A, 11500);
  assert(controller.status().error == Error::SetupRequired);
  send(controller, 'C', nullptr, 11501);
  controller.tick({false, true}, false, 11600);
  assert(controller.status().state == State::ClosedFree && !hardware.saved.assigned);
  send(controller, 'U', TOKEN_A, 11601);
  assert(controller.status().error == Error::Unassigned);
  controller.tick({false, true}, true, 12000);
  controller.tick({false, true}, true, 15000);
  controller.tick({true, false}, true, 15100);
  assert(controller.status().state == State::OpenFree);
}

void storageFailures() {
  Fake hardware; Controller controller(hardware);
  controller.begin({}, LoadResult::Missing, {true, false}, 0);
  setupWindow(controller, 0);
  hardware.writable = false;
  send(controller, 'L', TOKEN_A, 501);
  assert(hardware.drives == 0 && controller.status().error == Error::Storage);
  Fake second; Controller assignedController(second); assigned(second, assignedController);
  send(assignedController, 'U', TOKEN_A, 700);
  second.writable = false;
  assignedController.tick({true, false}, false, 800);
  assert(assignedController.status().state == State::Fault && assignedController.record().assigned);
  assert(second.saved.assigned && second.saved.pending == Pending::Open);
  Fake unavailable; unavailable.writable = false; Controller boot(unavailable);
  boot.begin({}, LoadResult::Unavailable, {true, false}, 0);
  assert(boot.status().state == State::Fault && boot.record().assigned);
}

void sensorsAndActuator() {
  for (Sensors sensors : {Sensors{true, true}, Sensors{false, false}}) {
    Fake hardware; Controller controller(hardware);
    controller.begin({}, LoadResult::Missing, sensors, 0);
    assert(controller.status().state == State::Fault && hardware.drives == 0);
  }
  Fake hardware; Controller controller(hardware); assigned(hardware, controller);
  send(controller, 'U', TOKEN_A, 700);
  controller.tick({true, true}, false, 800);
  assert(controller.status().error == Error::SensorConflict && hardware.saved.assigned);
  controller.tick({true, true}, true, 900);
  controller.tick({true, true}, true, 3900);
  assert(controller.status().state == State::Fault && hardware.saved.assigned);
  Fake actuator; Controller failed(actuator);
  failed.begin({}, LoadResult::Missing, {true, false}, 0);
  actuator.actuator = false;
  send(failed, 'C', nullptr, 1);
  assert(failed.status().state == State::Fault && failed.status().error == Error::Actuator);
}

void recordsAndPackets() {
  Record record; record.assigned = true; record.pending = Pending::Open;
  std::memcpy(record.token.data(), TOKEN_A, 16);
  auto bytes = encodeRecord(record); Record decoded;
  assert(decodeRecord(bytes.data(), bytes.size(), decoded));
  assert(decoded.assigned && decoded.pending == Pending::Open && decoded.token == record.token);
  for (size_t i = 0; i < bytes.size(); ++i) {
    auto corrupt = bytes; corrupt[i] ^= 0x10;
    assert(!decodeRecord(corrupt.data(), corrupt.size(), decoded));
  }
  assert(!decodeRecord(bytes.data(), bytes.size() - 1, decoded));
  Fake hardware; Controller boot(hardware);
  boot.begin({}, LoadResult::Corrupt, {false, true}, 0);
  assert(boot.status().state == State::Fault && boot.record().assigned && hardware.drives == 0);
  Status status; status.state = State::LockedAssigned; status.assigned = true;
  status.sensors = {false, true}; status.sequence = 0x12345678; status.command = 'L';
  const auto packet = encodeStatus(status);
  const std::array<uint8_t, 12> expected{{1, 2, 0, 5, 0, 0, 0x78, 0x56, 0x34, 0x12, 'L', 0}};
  assert(packet == expected);
}

void debounceAndClockWrap() {
  DebouncedInput input;
  input.update(true, 0); input.update(true, 29); assert(!input.ready());
  input.update(true, 30); assert(input.ready() && input.pressed());
  input.update(false, 31); input.update(true, 40); input.update(true, 70); assert(input.pressed());
  input.update(false, 71); input.update(false, 101); assert(!input.pressed());
  Fake hardware; Controller controller(hardware);
  controller.begin({}, LoadResult::Missing, {true, false}, 0xffffff00);
  setupWindow(controller, 0xffffff00);
  send(controller, 'L', TOKEN_A, uint32_t(0xffffff00u + 501));
  controller.tick({false, false}, false, uint32_t(0xffffff00u + 1501));
  assert(controller.status().error == Error::Timeout && controller.record().assigned);
}

int main() {
  cyclesAndReassignment(); validation(); rebootPreservesOwnership(); interruptedMovement();
  timeoutAndRecovery(); storageAndButton(); storageFailures(); sensorsAndActuator();
  recordsAndPackets(); debounceAndClockWrap();
  std::cout << "10 firmware test groups passed (including 20 assignment/reuse cycles).\n";
}
