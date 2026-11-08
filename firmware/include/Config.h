#pragma once
#include <stdint.h>

namespace config {
constexpr uint16_t DEMO_MOVEMENT_MS = 500;
constexpr uint16_t DEMO_SETTLE_MS = 50;
constexpr uint16_t DEMO_SWEEP_MS = DEMO_MOVEMENT_MS - DEMO_SETTLE_MS;
static_assert(DEMO_MOVEMENT_MS > DEMO_SETTLE_MS, "Allow time for servo travel");
constexpr char SERVICE_UUID[] = "7db10001-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char COMMAND_UUID[] = "7db10002-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char STATUS_UUID[] = "7db10003-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char SIGNAL_UUID[] = "7db10004-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char WIFI_UUID[] = "7db10005-3a7e-4f5c-9b21-51c61a7e0001";
constexpr uint16_t MOVEMENT_TIMEOUT_MS = 1000;
constexpr uint16_t DEBOUNCE_MS = 30;
constexpr uint16_t SETUP_HOLD_MS = 500;
constexpr uint16_t SERVICE_HOLD_MS = 3000;
constexpr uint16_t SETUP_WINDOW_MS = 10000;
}
