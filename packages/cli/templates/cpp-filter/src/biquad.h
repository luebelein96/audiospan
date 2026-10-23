// biquad.h: a typical pre-existing DSP class. Nothing in this file knows
// about Audiospan; it is the kind of code you already have.
#pragma once
#include <cmath>

class Biquad {
 public:
  void prepare(double sampleRate) {
    sampleRate_ = sampleRate;
    reset();
  }

  // RBJ cookbook low-pass.
  void setLowpass(double cutoffHz, double q) {
    const double w0 = 2.0 * kPi * cutoffHz / sampleRate_;
    const double alpha = std::sin(w0) / (2.0 * q);
    const double cosw0 = std::cos(w0);
    const double a0 = 1.0 + alpha;
    b0_ = (1.0 - cosw0) / 2.0 / a0;
    b1_ = (1.0 - cosw0) / a0;
    b2_ = b0_;
    a1_ = -2.0 * cosw0 / a0;
    a2_ = (1.0 - alpha) / a0;
  }

  float processSample(float x) {
    const double y = b0_ * x + z1_;
    z1_ = b1_ * x - a1_ * y + z2_;
    z2_ = b2_ * x - a2_ * y;
    return static_cast<float>(y);
  }

  void reset() { z1_ = z2_ = 0.0; }

 private:
  static constexpr double kPi = 3.14159265358979323846;
  double sampleRate_ = 48000.0;
  double b0_ = 1.0, b1_ = 0.0, b2_ = 0.0, a1_ = 0.0, a2_ = 0.0;
  double z1_ = 0.0, z2_ = 0.0;
};
