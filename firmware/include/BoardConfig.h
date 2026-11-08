#pragma once
#include <stdint.h>

// Kidsrobot 30-pin ESP-WROOM-32 development board (PlatformIO: esp32dev).
// Numbers are ESP32 GPIOs, not header positions or XIAO D-pin labels.
namespace boardconfig {
constexpr uint8_t SERVO_PIN = 14;
constexpr uint8_t OPEN_PIN = 32;
constexpr uint8_t CLOSED_PIN = 33;
constexpr uint8_t BUTTON_PIN = 27;
// External LED + series resistor; the clone's onboard LED is not assumed.
constexpr uint8_t LED_PIN = 26;

constexpr uint8_t PWM_CHANNEL = 0;
constexpr uint8_t PWM_RESOLUTION = 14;
constexpr uint16_t SERVO_HZ = 50;
constexpr uint32_t SERVO_PERIOD_US = 1000000u / SERVO_HZ;
// Nominal full-range SG90 command (Renesas AN-1057: 0.5–2.5 ms).
// Actual travel/stops need calibration; firmware cannot detect a hard stop.
constexpr uint16_t MIN_PULSE_US = 500;
constexpr uint16_t MAX_PULSE_US = 2500;
constexpr uint16_t OPEN_PULSE_US = MIN_PULSE_US;
constexpr uint16_t CLOSED_PULSE_US = MAX_PULSE_US;
static_assert(OPEN_PULSE_US != CLOSED_PULSE_US, "Open and closed servo targets must differ");

// Exclude flash, boot strapping, UART0 and input-only pins. All five signals
// need output capability or internal pull-ups on the classic ESP32.
constexpr bool usablePin(uint8_t pin) {
  return pin == 4 || pin == 14 || (pin >= 16 && pin <= 19) || (pin >= 21 && pin <= 23) ||
         (pin >= 25 && pin <= 27) || pin == 32 || pin == 33;
}
static_assert(usablePin(SERVO_PIN) && usablePin(OPEN_PIN) && usablePin(CLOSED_PIN) &&
              usablePin(BUTTON_PIN) && usablePin(LED_PIN), "Use supported ESP-WROOM-32 GPIOs");
static_assert(SERVO_PIN != OPEN_PIN && SERVO_PIN != CLOSED_PIN && SERVO_PIN != BUTTON_PIN && SERVO_PIN != LED_PIN &&
              OPEN_PIN != CLOSED_PIN && OPEN_PIN != BUTTON_PIN && OPEN_PIN != LED_PIN &&
              CLOSED_PIN != BUTTON_PIN && CLOSED_PIN != LED_PIN && BUTTON_PIN != LED_PIN, "GPIO assignments must be distinct");
static_assert(OPEN_PULSE_US >= MIN_PULSE_US && OPEN_PULSE_US <= MAX_PULSE_US, "Calibrate servo pulse within limits");
static_assert(CLOSED_PULSE_US >= MIN_PULSE_US && CLOSED_PULSE_US <= MAX_PULSE_US, "Calibrate servo pulse within limits");
}
