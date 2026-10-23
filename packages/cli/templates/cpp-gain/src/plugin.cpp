// __PLUGIN_NAME__: an Audiospan effect.
//
// The smallest complete plugin: a constructor, process(), and a parameters()
// accessor. Indices, ranges and defaults come from generated/audiospan_params.h,
// regenerated from plugin.json by `audiospan build`. The helper stores and
// smooths the parameters, implements state and reset, and generates every export.
//
// Rules for process(): no allocation, no I/O, no locks, no logging. Write
// every sample of every output channel.
#include "audiospan/effect.hpp"
#include "audiospan_params.h"

class GainEffect {
 public:
  explicit GainEffect(const audiospan::HostConfig& config) : params_(plugin::kParameters, config.sampleRate) {}

  audiospan::Parameters<plugin::kParamCount>& parameters() noexcept { return params_; }

  void process(const audiospan::ProcessContext& ctx) noexcept {
    for (uint32_t ch = 0; ch < ctx.outputChannels; ++ch) {
      auto gain = params_.ramp(plugin::kGain, ctx.frameCount);  // per-sample ramp across the block: click-free
      float* out = ctx.outputs[ch];
      const float* in = ctx.input(ch);
      for (uint32_t i = 0; i < ctx.frameCount; ++i) out[i] = in ? in[i] * static_cast<float>(gain.next()) : 0.0f;
    }
  }

 private:
  audiospan::Parameters<plugin::kParamCount> params_;
};

AUDIOSPAN_DEFINE_EFFECT(GainEffect, 16)
