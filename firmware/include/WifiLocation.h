#pragma once
#include <array>
#include <cstring>
#include <stdint.h>

namespace location {
constexpr uint8_t MAX_APS = 12;
constexpr size_t HEADER_SIZE = 6;
constexpr size_t PACKET_SIZE = HEADER_SIZE + MAX_APS * 8;
enum class State : uint8_t { Idle, Scanning, Ready, Failed, Busy };
struct AccessPoint { std::array<uint8_t, 6> mac{}; int8_t rssi = -127; uint8_t channel = 0; };
struct Snapshot {
  State state = State::Idle;
  uint16_t request = 0;
  uint8_t count = 0;
  std::array<AccessPoint, MAX_APS> aps{};
};
inline bool usable(const AccessPoint& ap) {
  bool zero = true;
  for (auto byte : ap.mac) if (byte != 0) zero = false;
  return !zero && !(ap.mac[0] & 3) && !(ap.mac[0] == 0 && ap.mac[1] == 0 && ap.mac[2] == 0x5e)
    && ap.rssi >= -100 && ap.rssi <= -10 && ap.channel >= 1 && ap.channel <= 14;
}
// Keep the strongest unique, globally administered BSSIDs. No SSIDs or tokens.
inline void add(Snapshot& snapshot, AccessPoint ap) {
  if (!usable(ap)) return;
  for (uint8_t i = 0; i < snapshot.count; ++i) {
    if (snapshot.aps[i].mac != ap.mac) continue;
    if (snapshot.aps[i].rssi >= ap.rssi) return;
    for (uint8_t j = i + 1; j < snapshot.count; ++j) snapshot.aps[j - 1] = snapshot.aps[j];
    --snapshot.count;
    break;
  }
  uint8_t index = 0;
  while (index < snapshot.count && snapshot.aps[index].rssi >= ap.rssi) ++index;
  if (index >= MAX_APS) return;
  if (snapshot.count < MAX_APS) ++snapshot.count;
  for (uint8_t i = snapshot.count - 1; i > index; --i) snapshot.aps[i] = snapshot.aps[i - 1];
  snapshot.aps[index] = ap;
}
inline std::array<uint8_t, PACKET_SIZE> encode(const Snapshot& snapshot) {
  std::array<uint8_t, PACKET_SIZE> bytes{};
  bytes[0] = 1; bytes[1] = uint8_t(snapshot.state);
  bytes[2] = uint8_t(snapshot.request); bytes[3] = uint8_t(snapshot.request >> 8);
  bytes[4] = snapshot.state == State::Ready ? snapshot.count : 0;
  for (uint8_t i = 0; i < bytes[4]; ++i) {
    std::memcpy(bytes.data() + HEADER_SIZE + i * 8, snapshot.aps[i].mac.data(), 6);
    bytes[HEADER_SIZE + i * 8 + 6] = uint8_t(snapshot.aps[i].rssi);
    bytes[HEADER_SIZE + i * 8 + 7] = snapshot.aps[i].channel;
  }
  return bytes;
}
}
