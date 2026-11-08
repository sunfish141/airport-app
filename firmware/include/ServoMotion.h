#pragma once
#include <stdint.h>

// A target-position ramp for a standard positional servo. It estimates the
// commanded position only; it cannot measure the shaft or latch position.
class ServoMotion {
 public:
  explicit ServoMotion(uint16_t initial = 1500) : from_(initial), target_(initial) {}
  uint16_t value(uint32_t now) const {
    const uint32_t elapsed = now - started_;
    if (duration_ == 0 || elapsed >= duration_) return target_;
    const int32_t delta = int32_t(target_) - int32_t(from_);
    return uint16_t(int32_t(from_) + delta * int32_t(elapsed) / int32_t(duration_));
  }
  void start(uint16_t target, uint32_t now, uint16_t duration) {
    from_ = value(now); target_ = target; started_ = now; duration_ = duration;
  }
  void stop(uint32_t now) { from_ = target_ = value(now); duration_ = 0; }
 private:
  uint16_t from_, target_;
  uint32_t started_ = 0;
  uint16_t duration_ = 0;
};
