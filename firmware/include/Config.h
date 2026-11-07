#pragma once
#include <stdint.h>

namespace config {
constexpr char SERVICE_UUID[] = "7db10001-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char COMMAND_UUID[] = "7db10002-3a7e-4f5c-9b21-51c61a7e0001";
constexpr char STATUS_UUID[] = "7db10003-3a7e-4f5c-9b21-51c61a7e0001";
constexpr uint8_t SERVO_PIN = 10;
constexpr uint8_t OPEN_PIN = 5;
constexpr uint8_t CLOSED_PIN = 6;
constexpr uint8_t BUTTON_PIN = 7;
constexpr uint8_t LED_PIN = 21;
// Starting points only. Calibrate unloaded around 1500 us before fitting linkage.
constexpr uint16_t OPEN_PULSE_US = 1400;
constexpr uint16_t CLOSED_PULSE_US = 1600;
constexpr uint16_t MOVEMENT_TIMEOUT_MS = 1000;
constexpr uint16_t DEBOUNCE_MS = 30;
constexpr uint16_t SETUP_HOLD_MS = 500;
constexpr uint16_t SERVICE_HOLD_MS = 3000;
constexpr uint16_t SETUP_WINDOW_MS = 10000;
constexpr uint8_t PWM_CHANNEL = 0;
constexpr uint8_t PWM_RESOLUTION = 14;
static_assert(OPEN_PULSE_US >= 1000 && OPEN_PULSE_US <= 2000, "Calibrate servo pulse within limits");
static_assert(CLOSED_PULSE_US >= 1000 && CLOSED_PULSE_US <= 2000, "Calibrate servo pulse within limits");
}
