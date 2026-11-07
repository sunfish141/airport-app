#include "WifiLocation.h"
#include <cassert>
#include <iostream>

int main() {
  location::Snapshot snapshot;
  snapshot.request = 0x1234;
  location::AccessPoint ap;
  ap.mac = {{0x10, 0x11, 0x22, 0x33, 0x44, 1}}; ap.rssi = -60; ap.channel = 6;
  location::add(snapshot, ap);
  ap.rssi = -70; location::add(snapshot, ap);
  assert(snapshot.count == 1 && snapshot.aps[0].rssi == -60);
  ap.rssi = -40; location::add(snapshot, ap);
  assert(snapshot.count == 1 && snapshot.aps[0].rssi == -40);
  for (int i = 2; i < 30; ++i) {
    ap.mac[5] = uint8_t(i); ap.rssi = int8_t(-40 - i); location::add(snapshot, ap);
  }
  assert(snapshot.count == location::MAX_APS);
  assert(snapshot.aps[11].rssi == -52);
  ap.mac[0] = 0x12; ap.rssi = -10; location::add(snapshot, ap); // Locally administered.
  ap.mac[0] = 0x11; location::add(snapshot, ap); // Multicast.
  ap.mac = {{0, 0, 0x5e, 0x33, 0x44, 1}}; location::add(snapshot, ap); // IANA.
  ap.mac = {{0, 0, 0, 0, 0, 0}}; location::add(snapshot, ap);
  assert(snapshot.aps[0].rssi == -40 && snapshot.count == 12);
  const auto idle = location::encode(snapshot);
  assert(idle[4] == 0 && idle[6] == 0);
  snapshot.state = location::State::Ready;
  const auto bytes = location::encode(snapshot);
  assert(bytes[0] == 1 && bytes[1] == 2 && bytes[2] == 0x34 && bytes[3] == 0x12 && bytes[4] == 12 && bytes[5] == 0);
  assert(bytes[6] == 0x10 && bytes[11] == 1 && int8_t(bytes[12]) == -40 && bytes[13] == 6);
  std::cout << "Wi-Fi packet, filtering, deduplication and strongest-12 checks passed\n";
}
