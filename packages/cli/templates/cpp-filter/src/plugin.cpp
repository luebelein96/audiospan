// __PLUGIN_NAME__: an Audiospan effect.
//
// The DSP lives in biquad.h; replace it with your own code. This file is the
// adapter: one filter per channel, parameters read through the generated table,
// and a level meter. Parameter indices, ranges and defaults come from
// generated/audiospan_params.h, which `audiospan build` regenerates from
// plugin.json. The helper stores and smooths the parameters and implements
// state and reset; add your own only when you need more.
//
// Rules for process(): no allocation, no I/O, no locks, no logging. Write
// every sample of every output channel.
#include "audiospan/effect.hpp"
#include "audiospan_params.h"
#include "biquad.h"

#include <vector>

class FilterEffect {
 public:
  // Allocate here, never in process(). The host tells you the sample rate and channel count.
  explicit FilterEffect(const audiospan::HostConfig& config)
      : params_(plugin::kParameters, config.sampleRate), filters_(config.maxOutputChannels > 0 ? config.maxOutputChannels : 1) {
    for (Biquad& filter : filters_) filter.prepare(config.sampleRate);
    updateCoefficients();
    audiospan::logDebug("filter: instance created");  // visible with `audiospan build --dev`
  }

  audiospan::Parameters<plugin::kParamCount>& parameters() noexcept { return params_; }

  // Clear DSP history; parameter values persist.
  void reset() noexcept {
    for (Biquad& filter : filters_) filter.reset();
    level_ = 0.0f;
  }

  void process(const audiospan::ProcessContext& ctx) noexcept {
    // The helper smooths parameters at block rate; recompute coefficients when they moved.
    if (params_.changed(plugin::kCutoff) || params_.changed(plugin::kQ)) updateCoefficients();
    float peak = 0.0f;
    for (uint32_t ch = 0; ch < ctx.outputChannels; ++ch) {
      Biquad& filter = filters_[ch < filters_.size() ? ch : filters_.size() - 1];
      float* out = ctx.outputs[ch];
      const float* in = ctx.input(ch);
      for (uint32_t i = 0; i < ctx.frameCount; ++i) {
        const float y = filter.processSample(in ? in[i] : 0.0f);
        out[i] = y;
        const float a = y < 0.0f ? -y : y;
        if (a > peak) peak = a;
      }
    }
    level_ = peak;
  }

  // Read-only value for the "outputs" array in plugin.json, shown as a meter.
  bool getOutput(uint32_t index, double& out) const noexcept {
    if (index != plugin::kOutLevel) return false;
    out = level_;
    return true;
  }

 private:
  void updateCoefficients() noexcept {
    for (Biquad& filter : filters_) filter.setLowpass(params_.value(plugin::kCutoff), params_.value(plugin::kQ));
  }

  audiospan::Parameters<plugin::kParamCount> params_;
  std::vector<Biquad> filters_;
  float level_ = 0.0f;
};

AUDIOSPAN_DEFINE_EFFECT(FilterEffect, 16)
