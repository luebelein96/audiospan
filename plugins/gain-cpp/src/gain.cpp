// Audiospan reference gain effect (C++).
//
// One float parameter "gain" (index 0): linear multiplier, min 0, max 2,
// default 1. One output "level" (index 0): peak absolute sample of the last
// processed block. No clipping, no smoothing, zero latency. Mono or stereo.
#include "audiospan/effect.hpp"

namespace {

constexpr uint32_t kStateMagic = 0x4E474153u;  // "SAGN" little-endian
constexpr uint32_t kStateVersion = 1u;
constexpr double kGainMin = 0.0;
constexpr double kGainMax = 2.0;
constexpr double kGainDefault = 1.0;

struct GainState {
  uint32_t magic;
  uint32_t version;
  float gain;
};

class GainEffect {
 public:
  explicit GainEffect(const audiospan::HostConfig&) noexcept : gain_(static_cast<float>(kGainDefault)), level_(0.0f) {
    audiospan::logDebug("gain-cpp: instance created");  // visible only in `audiospan build --dev` builds
  }

  void reset() noexcept {
    // Gain has no DSP history. Parameter values survive reset by contract.
    level_ = 0.0f;
  }

  // Optional: the host re-reads this after parameter and state changes.
  uint32_t latencyFrames() const noexcept { return 0; }

  // Optional: read-only values for the manifest's "outputs" array.
  bool getOutput(uint32_t index, double& out) const noexcept {
    if (index != 0) return false;
    out = static_cast<double>(level_);
    return true;
  }

  bool setParameter(uint32_t index, double value) noexcept {
    if (index != 0) return false;
    if (value < kGainMin) value = kGainMin;
    if (value > kGainMax) value = kGainMax;
    gain_ = static_cast<float>(value);
    return true;
  }

  bool getParameter(uint32_t index, double& out) const noexcept {
    if (index != 0) return false;
    out = static_cast<double>(gain_);
    return true;
  }

  void process(const audiospan::ProcessContext& ctx) noexcept {
    const float gain = gain_;
    float peak = 0.0f;
    for (uint32_t ch = 0; ch < ctx.outputChannels; ++ch) {
      float* out = ctx.outputs[ch];
      const float* in = ctx.input(ch);
      if (in == nullptr) {
        for (uint32_t i = 0; i < ctx.frameCount; ++i) out[i] = 0.0f;
        continue;
      }
      for (uint32_t i = 0; i < ctx.frameCount; ++i) {
        const float v = in[i] * gain;
        out[i] = v;
        const float a = v < 0.0f ? -v : v;
        if (a > peak) peak = a;
      }
    }
    level_ = peak;
  }

  uint32_t stateSize() const noexcept { return static_cast<uint32_t>(sizeof(GainState)); }

  bool writeState(uint8_t* dest, uint32_t capacity, uint32_t& written) const noexcept {
    if (capacity < sizeof(GainState)) return false;
    GainState state;
    state.magic = kStateMagic;
    state.version = kStateVersion;
    state.gain = gain_;
    memcpy(dest, &state, sizeof(state));
    written = static_cast<uint32_t>(sizeof(state));
    return true;
  }

  bool readState(const uint8_t* src, uint32_t size) noexcept {
    if (size != sizeof(GainState)) return false;
    GainState state;
    memcpy(&state, src, sizeof(state));
    if (state.magic != kStateMagic || state.version != kStateVersion) return false;
    if (!(state.gain >= kGainMin && state.gain <= kGainMax)) return false;  // also rejects NaN
    gain_ = state.gain;
    return true;
  }

 private:
  float gain_;
  float level_;
};

}  // namespace

AUDIOSPAN_DEFINE_EFFECT(GainEffect, 16)
