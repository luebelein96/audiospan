/*
 * Audiospan C++ effect helper.
 *
 * Implements the ABI exports on top of a plain C++ class. Nothing in this
 * header crosses the ABI boundary: the generated exports are extern "C"
 * functions that forward to your class and translate every failure into an
 * as_status_t. Your class is never exposed to the host.
 *
 * Required members:
 *
 *   explicit Effect(const audiospan::HostConfig& config);        // may allocate
 *   void process(const audiospan::ProcessContext& ctx) noexcept; // no allocation
 *
 * Parameters, one of the two:
 *
 *   audiospan::Parameters<N>& parameters() noexcept;              // the helper stores, clamps,
 *                                                                 // smooths and serialises them
 *   bool setParameter(uint32_t index, double value) noexcept;     // false = bad index
 *   bool getParameter(uint32_t index, double& out) const noexcept;
 *
 * Optional members, detected at compile time:
 *
 *   void reset() noexcept;                                        // clear DSP history; parameters persist
 *   uint32_t latencyFrames() const noexcept;                      // re-read after parameter/state changes
 *   bool getOutput(uint32_t index, double& out) const noexcept;   // manifest "outputs" (meters); false = bad index
 *   uint32_t stateSize() const noexcept;                          // all three, or none: without them the
 *   bool writeState(uint8_t* dest, uint32_t capacity,             // state is the parameter values, in a
 *                   uint32_t& written) const noexcept;            // versioned blob the helper writes and
 *   bool readState(const uint8_t* src, uint32_t size) noexcept;   // validates for you
 *
 * Then, once per module:
 *
 *   AUDIOSPAN_DEFINE_EFFECT(MyEffect, 16)   // up to 16 live instances
 *
 * `audiospan build` generates `generated/audiospan_params.h` from plugin.json
 * with an index enum and a `plugin::kParameters` table, so a complete effect
 * can be:
 *
 *   class Gain {
 *    public:
 *     explicit Gain(const audiospan::HostConfig& c) : params_(plugin::kParameters, c.sampleRate) {}
 *     audiospan::Parameters<plugin::kParamCount>& parameters() noexcept { return params_; }
 *     void process(const audiospan::ProcessContext& ctx) noexcept {
 *       const float gain = static_cast<float>(params_.value(plugin::kGain));
 *       ...
 *     }
 *    private:
 *     audiospan::Parameters<plugin::kParamCount> params_;
 *   };
 *
 * Build with -fno-exceptions (recommended, smallest) or with -fwasm-exceptions.
 * In both modes no exception escapes an export.
 *
 * Logging: audiospan::log(AS_LOG_INFO, "text") and the logError/logWarn/
 * logInfo/logDebug shorthands reach the host console in development builds
 * (`audiospan build --dev`, which defines AUDIOSPAN_ENABLE_LOG). In release
 * builds they compile to nothing and the module imports nothing extra.
 */
#ifndef AUDIOSPAN_EFFECT_HPP
#define AUDIOSPAN_EFFECT_HPP

#include "abi.h"

#include <cmath>
#include <new>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <type_traits>
#include <utility>

namespace audiospan {

struct HostConfig {
  uint32_t sampleRate;
  uint32_t maxFrames;
  uint32_t maxInputChannels;
  uint32_t maxOutputChannels;
};

struct ProcessContext {
  uint32_t frameCount;
  uint32_t inputChannels;
  uint32_t outputChannels;
  const float* const* inputs;
  float* const* outputs;

  const float* input(uint32_t channel) const noexcept {
    return channel < inputChannels ? inputs[channel] : nullptr;
  }
  float* output(uint32_t channel) const noexcept {
    return channel < outputChannels ? outputs[channel] : nullptr;
  }
};

/* ------------------------------------------------------------------------ */
/* Parameters                                                                */
/* ------------------------------------------------------------------------ */

enum class ParameterKind : uint32_t { Float = 0, Integer = 1, Boolean = 2, Enum = 3 };

/* One row of the table `audiospan build` generates from plugin.json. */
struct ParameterSpec {
  const char* id;
  ParameterKind kind;
  double min;
  double max;
  double defaultValue;
  double step; /* 0 = none */
};

/*
 * Per-sample one-pole smoother for values you set from parameters inside
 * process(): call setTarget() when the parameter changes and next() once per
 * sample. snap() jumps to the target without a ramp.
 */
class Smoothed {
 public:
  Smoothed() noexcept = default;
  explicit Smoothed(double value) noexcept : current_(value), target_(value) {}

  /* Time constant in seconds (0 disables smoothing). */
  void setTime(double seconds, double sampleRate) noexcept {
    coef_ = seconds > 0.0 && sampleRate > 0.0 ? std::exp(-1.0 / (seconds * sampleRate)) : 0.0;
  }
  void setTarget(double value) noexcept { target_ = value; }
  void snap() noexcept { current_ = target_; }
  void snap(double value) noexcept { current_ = target_ = value; }
  double target() const noexcept { return target_; }
  double value() const noexcept { return current_; }
  bool isSmoothing() const noexcept { return current_ != target_; }

  double next() noexcept {
    if (current_ == target_) return current_;
    current_ = target_ + (current_ - target_) * coef_;
    if (std::fabs(current_ - target_) <= 1e-9 * (1.0 + std::fabs(target_))) current_ = target_;
    return current_;
  }

 private:
  double current_ = 0.0;
  double target_ = 0.0;
  double coef_ = 0.0;
};

/*
 * Storage for N parameters driven by a ParameterSpec table. Clamps on set,
 * smooths float parameters at block rate (20 ms by default; integers,
 * booleans and enums switch instantly), applies values instantly before the
 * first block so presets and restored state do not fade in, and gives the
 * helper everything it needs to implement set/get, reset and state.
 *
 *   params_.value(i)          the value to use for the current block
 *   params_.changed(i)        true when value(i) moved since the last block
 *   params_.ramp(i, frames)   per-sample linear ramp across the block
 *   params_.target(i)         the last value the host set
 */
template <uint32_t N>
class Parameters {
  static_assert(N > 0, "Parameters<N> needs at least one parameter");

 public:
  struct Ramp {
    double value;
    double step;
    double next() noexcept {
      const double v = value;
      value += step;
      return v;
    }
  };

  Parameters(const ParameterSpec (&specs)[N], double sampleRate) noexcept : specs_(specs), sampleRate_(sampleRate) {
    for (uint32_t i = 0; i < N; ++i) {
      targets_[i] = current_[i] = blockStart_[i] = specs[i].defaultValue;
      smoothing_[i] = specs[i].kind == ParameterKind::Float ? kDefaultSmoothingSeconds : 0.0;
    }
  }

  static constexpr uint32_t count() noexcept { return N; }
  const ParameterSpec& spec(uint32_t index) const noexcept { return specs_[index < N ? index : 0]; }

  /* Smoothing time in seconds for one parameter (0 = instant). */
  void setSmoothing(uint32_t index, double seconds) noexcept {
    if (index < N) smoothing_[index] = seconds < 0.0 ? 0.0 : seconds;
  }

  /* Host-side entry points (the helper calls these). */
  bool set(uint32_t index, double value) noexcept {
    if (index >= N || value != value) return false;
    const ParameterSpec& s = specs_[index];
    double v = value < s.min ? s.min : value > s.max ? s.max : value;
    if (s.kind == ParameterKind::Integer) v = std::round(v);
    if (s.kind == ParameterKind::Boolean) v = v >= 0.5 ? 1.0 : 0.0;
    targets_[index] = v;
    if (!started_ || smoothing_[index] <= 0.0) current_[index] = v;
    return true;
  }
  bool get(uint32_t index, double& out) const noexcept {
    if (index >= N) return false;
    out = targets_[index];
    return true;
  }

  /* Called by the helper before every process(); advances the smoothers by one block. */
  void beginBlock(uint32_t frames) noexcept {
    /* On the first block, and on the first block after a snap, every parameter counts as changed so
       coefficient tables get built from the values set before processing started. */
    allChanged_ = !started_ || pendingSnap_;
    started_ = true;
    pendingSnap_ = false;
    for (uint32_t i = 0; i < N; ++i) {
      blockStart_[i] = current_[i];
      if (current_[i] == targets_[i]) continue;
      if (smoothing_[i] <= 0.0 || sampleRate_ <= 0.0) {
        current_[i] = targets_[i];
        continue;
      }
      const double coef = std::exp(-static_cast<double>(frames) / (smoothing_[i] * sampleRate_));
      double v = targets_[i] + (current_[i] - targets_[i]) * coef;
      if (std::fabs(v - targets_[i]) <= 1e-6 * (1.0 + std::fabs(targets_[i]))) v = targets_[i];
      current_[i] = v;
    }
  }

  double value(uint32_t index) const noexcept { return current_[index < N ? index : 0]; }
  double target(uint32_t index) const noexcept { return targets_[index < N ? index : 0]; }
  bool changed(uint32_t index) const noexcept { return index < N && (allChanged_ || current_[index] != blockStart_[index]); }
  bool anyChanged() const noexcept {
    if (allChanged_) return true;
    for (uint32_t i = 0; i < N; ++i)
      if (current_[i] != blockStart_[i]) return true;
    return false;
  }
  Ramp ramp(uint32_t index, uint32_t frames) const noexcept {
    const uint32_t i = index < N ? index : 0;
    return Ramp{blockStart_[i], frames > 0 ? (current_[i] - blockStart_[i]) / static_cast<double>(frames) : 0.0};
  }

  /* Jump every parameter to its target (the helper calls this on reset and after readState). */
  void snap() noexcept {
    for (uint32_t i = 0; i < N; ++i) current_[i] = blockStart_[i] = targets_[i];
    pendingSnap_ = true;
  }

 private:
  static constexpr double kDefaultSmoothingSeconds = 0.02;
  const ParameterSpec* specs_;
  double sampleRate_;
  double targets_[N];
  double current_[N];
  double blockStart_[N];
  double smoothing_[N];
  bool started_ = false;
  bool pendingSnap_ = false;
  bool allChanged_ = false;
};

/* ------------------------------------------------------------------------ */
/* Logging                                                                   */
/* ------------------------------------------------------------------------ */

/* Development-build logging; a no-op unless AUDIOSPAN_ENABLE_LOG is defined. */
inline void log(uint32_t level, const char* message) noexcept {
#if defined(AUDIOSPAN_ENABLE_LOG)
  if (message == nullptr) return;
  audiospan_log(level, message, static_cast<uint32_t>(strlen(message)));
#else
  (void)level;
  (void)message;
#endif
}
inline void logError(const char* message) noexcept { log(AS_LOG_ERROR, message); }
inline void logWarn(const char* message) noexcept { log(AS_LOG_WARN, message); }
inline void logInfo(const char* message) noexcept { log(AS_LOG_INFO, message); }
inline void logDebug(const char* message) noexcept { log(AS_LOG_DEBUG, message); }

/* ------------------------------------------------------------------------ */
/* Implementation detail: optional-member detection and dispatch            */
/* ------------------------------------------------------------------------ */

namespace detail {

template <typename>
inline constexpr bool dependentFalse = false;

template <typename T, typename = void>
struct HasSetParameter : std::false_type {};
template <typename T>
struct HasSetParameter<T, std::void_t<decltype(std::declval<T&>().setParameter(std::declval<uint32_t>(), std::declval<double>()))>> : std::true_type {};

template <typename T, typename = void>
struct HasGetParameter : std::false_type {};
template <typename T>
struct HasGetParameter<T, std::void_t<decltype(std::declval<const T&>().getParameter(std::declval<uint32_t>(), std::declval<double&>()))>> : std::true_type {};

template <typename T, typename = void>
struct HasParameters : std::false_type {};
template <typename T>
struct HasParameters<T, std::void_t<decltype(std::declval<T&>().parameters().snap())>> : std::true_type {};

template <typename T, typename = void>
struct HasReset : std::false_type {};
template <typename T>
struct HasReset<T, std::void_t<decltype(std::declval<T&>().reset())>> : std::true_type {};

template <typename T, typename = void>
struct HasLatencyFrames : std::false_type {};
template <typename T>
struct HasLatencyFrames<T, std::void_t<decltype(std::declval<const T&>().latencyFrames())>> : std::true_type {};

template <typename T, typename = void>
struct HasGetOutput : std::false_type {};
template <typename T>
struct HasGetOutput<T, std::void_t<decltype(std::declval<const T&>().getOutput(std::declval<uint32_t>(), std::declval<double&>()))>>
    : std::true_type {};

template <typename T, typename = void>
struct HasStateSize : std::false_type {};
template <typename T>
struct HasStateSize<T, std::void_t<decltype(std::declval<const T&>().stateSize())>> : std::true_type {};
template <typename T, typename = void>
struct HasWriteState : std::false_type {};
template <typename T>
struct HasWriteState<T, std::void_t<decltype(std::declval<const T&>().writeState(std::declval<uint8_t*>(), std::declval<uint32_t>(), std::declval<uint32_t&>()))>>
    : std::true_type {};
template <typename T, typename = void>
struct HasReadState : std::false_type {};
template <typename T>
struct HasReadState<T, std::void_t<decltype(std::declval<T&>().readState(std::declval<const uint8_t*>(), std::declval<uint32_t>()))>> : std::true_type {};

template <typename T>
struct HasState {
  static constexpr int provided = int(HasStateSize<T>::value) + int(HasWriteState<T>::value) + int(HasReadState<T>::value);
  static_assert(provided == 0 || provided == 3, "Effect must define all of stateSize/writeState/readState or none of them");
  static constexpr bool value = provided == 3;
};

template <typename Effect>
as_status_t setParameter(Effect& effect, uint32_t index, double value) noexcept {
  if constexpr (HasSetParameter<Effect>::value) {
    return effect.setParameter(index, value) ? AS_OK : AS_ERROR_INVALID_ARGUMENT;
  } else if constexpr (HasParameters<Effect>::value) {
    return effect.parameters().set(index, value) ? AS_OK : AS_ERROR_INVALID_ARGUMENT;
  } else {
    static_assert(dependentFalse<Effect>, "Effect needs setParameter()/getParameter() or a parameters() accessor returning audiospan::Parameters<N>&");
    return AS_ERROR_UNSUPPORTED;
  }
}

template <typename Effect>
as_status_t getParameter(const Effect& effect, uint32_t index, double& out) noexcept {
  if constexpr (HasGetParameter<Effect>::value) {
    return effect.getParameter(index, out) ? AS_OK : AS_ERROR_INVALID_ARGUMENT;
  } else if constexpr (HasParameters<Effect>::value) {
    /* parameters() is non-const by design (the host also sets through it); reading is const in spirit. */
    return const_cast<Effect&>(effect).parameters().get(index, out) ? AS_OK : AS_ERROR_INVALID_ARGUMENT;
  } else {
    static_assert(dependentFalse<Effect>, "Effect needs setParameter()/getParameter() or a parameters() accessor returning audiospan::Parameters<N>&");
    return AS_ERROR_UNSUPPORTED;
  }
}

template <typename Effect>
void beforeProcess(Effect& effect, uint32_t frames) noexcept {
  if constexpr (HasParameters<Effect>::value) effect.parameters().beginBlock(frames);
  else (void)frames;
}

template <typename Effect>
void reset(Effect& effect) noexcept {
  if constexpr (HasReset<Effect>::value) effect.reset();
  if constexpr (HasParameters<Effect>::value) effect.parameters().snap();
}

template <typename Effect>
as_status_t getLatency(const Effect& effect, uint32_t& out) noexcept {
  if constexpr (HasLatencyFrames<Effect>::value) {
    out = static_cast<uint32_t>(effect.latencyFrames());
    return AS_OK;
  } else {
    (void)effect;
    (void)out;
    return AS_ERROR_UNSUPPORTED;
  }
}

template <typename Effect>
as_status_t getOutput(const Effect& effect, uint32_t index, double& out) noexcept {
  if constexpr (HasGetOutput<Effect>::value) {
    return effect.getOutput(index, out) ? AS_OK : AS_ERROR_INVALID_ARGUMENT;
  } else {
    (void)effect;
    (void)index;
    (void)out;
    return AS_ERROR_UNSUPPORTED;
  }
}

/*
 * Default state when the effect defines no state methods: every parameter
 * value, little-endian doubles behind a 16-byte header
 * { magic "ASPS", version 1, count, reserved }.
 */
constexpr uint32_t kParameterStateMagic = 0x53505341u;
constexpr uint32_t kParameterStateVersion = 1u;
constexpr uint32_t kParameterStateHeader = 16u;
constexpr uint32_t kMaxProbedParameters = 512u;

template <typename Effect>
uint32_t parameterCount(const Effect& effect) noexcept {
  if constexpr (HasParameters<Effect>::value) {
    return std::decay_t<decltype(std::declval<Effect&>().parameters())>::count();
  } else {
    uint32_t n = 0;
    double scratch = 0.0;
    while (n < kMaxProbedParameters && getParameter(effect, n, scratch) == AS_OK) ++n;
    return n;
  }
}

template <typename Effect>
as_status_t stateSize(const Effect& effect, uint32_t& out) noexcept {
  if constexpr (HasState<Effect>::value) out = effect.stateSize();
  else out = kParameterStateHeader + 8u * parameterCount(effect);
  return AS_OK;
}

template <typename Effect>
as_status_t writeState(const Effect& effect, uint8_t* dest, uint32_t capacity, uint32_t& written) noexcept {
  if constexpr (HasState<Effect>::value) {
    if (capacity < effect.stateSize()) {
      written = 0;
      return AS_ERROR_BUFFER_TOO_SMALL;
    }
    return effect.writeState(dest, capacity, written) ? AS_OK : AS_ERROR_BUFFER_TOO_SMALL;
  } else {
    const uint32_t count = parameterCount(effect);
    const uint32_t size = kParameterStateHeader + 8u * count;
    if (capacity < size) {
      written = 0;
      return AS_ERROR_BUFFER_TOO_SMALL;
    }
    const uint32_t header[4] = {kParameterStateMagic, kParameterStateVersion, count, 0u};
    memcpy(dest, header, sizeof(header));
    for (uint32_t i = 0; i < count; ++i) {
      double v = 0.0;
      getParameter(effect, i, v);
      memcpy(dest + kParameterStateHeader + 8u * i, &v, sizeof(v));
    }
    written = size;
    return AS_OK;
  }
}

template <typename Effect>
as_status_t readState(Effect& effect, const uint8_t* src, uint32_t size) noexcept {
  if constexpr (HasState<Effect>::value) {
    return effect.readState(src, size) ? AS_OK : AS_ERROR_INVALID_FORMAT;
  } else {
    if (size < kParameterStateHeader) return AS_ERROR_INVALID_FORMAT;
    uint32_t header[4];
    memcpy(header, src, sizeof(header));
    const uint32_t count = parameterCount(effect);
    if (header[0] != kParameterStateMagic || header[1] != kParameterStateVersion || header[2] != count || size != kParameterStateHeader + 8u * count) {
      return AS_ERROR_INVALID_FORMAT;
    }
    for (uint32_t i = 0; i < count; ++i) {
      double v;
      memcpy(&v, src + kParameterStateHeader + 8u * i, sizeof(v));
      if (!std::isfinite(v)) return AS_ERROR_INVALID_FORMAT;
    }
    for (uint32_t i = 0; i < count; ++i) {
      double v;
      memcpy(&v, src + kParameterStateHeader + 8u * i, sizeof(v));
      if (setParameter(effect, i, v) != AS_OK) return AS_ERROR_INVALID_FORMAT;
    }
    if constexpr (HasParameters<Effect>::value) effect.parameters().snap();
    return AS_OK;
  }
}

template <typename Effect, uint32_t MaxInstances>
struct InstanceTable {
  static Effect* slots[MaxInstances];

  static Effect* get(as_instance_t handle) noexcept {
    if (handle == 0 || handle > MaxInstances) return nullptr;
    return slots[handle - 1];
  }

  static as_status_t create(const as_host_config* config, as_instance_t* out) noexcept {
    if (config == nullptr || out == nullptr) return AS_ERROR_INVALID_ARGUMENT;
    if (config->struct_size < sizeof(as_host_config)) return AS_ERROR_INVALID_ARGUMENT;
    if (config->sample_rate == 0 || config->max_frames == 0) return AS_ERROR_INVALID_ARGUMENT;
    for (uint32_t i = 0; i < MaxInstances; ++i) {
      if (slots[i] != nullptr) continue;
      HostConfig hc;
      hc.sampleRate = config->sample_rate;
      hc.maxFrames = config->max_frames;
      hc.maxInputChannels = config->max_input_channels;
      hc.maxOutputChannels = config->max_output_channels;
      Effect* effect = nullptr;
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS)
      try {
        effect = new (std::nothrow) Effect(hc);
      } catch (...) {
        effect = nullptr;
      }
#else
      effect = new (std::nothrow) Effect(hc);
#endif
      if (effect == nullptr) return AS_ERROR_OUT_OF_MEMORY;
      slots[i] = effect;
      *out = i + 1;
      return AS_OK;
    }
    return AS_ERROR_OUT_OF_MEMORY;
  }

  static as_status_t destroy(as_instance_t handle) noexcept {
    Effect* effect = get(handle);
    if (effect == nullptr) return AS_ERROR_INVALID_ARGUMENT;
    slots[handle - 1] = nullptr;
    delete effect;
    return AS_OK;
  }
};

template <typename Effect, uint32_t MaxInstances>
Effect* InstanceTable<Effect, MaxInstances>::slots[MaxInstances] = {};

}  // namespace detail
}  // namespace audiospan

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS)
#define AUDIOSPAN_DETAIL_TRY try {
#define AUDIOSPAN_DETAIL_CATCH(status) } catch (...) { return (status); }
#else
#define AUDIOSPAN_DETAIL_TRY
#define AUDIOSPAN_DETAIL_CATCH(status)
#endif

#define AUDIOSPAN_DEFINE_EFFECT(EffectType, MaxInstances)                                       \
  extern "C" {                                                                                  \
  typedef ::audiospan::detail::InstanceTable<EffectType, (MaxInstances)> audiospan_table_t;    \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_abi_version)                                                   \
  uint32_t audiospan_get_abi_version(void) { return AUDIOSPAN_ABI_VERSION; }                    \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_alloc)                                                             \
  void* audiospan_alloc(uint32_t size, uint32_t alignment) {                                    \
    if (size == 0) size = 1;                                                                    \
    if (alignment < sizeof(void*)) alignment = sizeof(void*);                                   \
    if ((alignment & (alignment - 1)) != 0) return nullptr;                                     \
    void* ptr = nullptr;                                                                        \
    if (posix_memalign(&ptr, alignment, size) != 0) return nullptr;                             \
    return ptr;                                                                                 \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_free)                                                              \
  void audiospan_free(void* ptr) { free(ptr); }                                                 \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_create)                                                            \
  as_status_t audiospan_create(const as_host_config* config, as_instance_t* out) {              \
    return audiospan_table_t::create(config, out);                                              \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_destroy)                                                           \
  as_status_t audiospan_destroy(as_instance_t instance) {                                       \
    return audiospan_table_t::destroy(instance);                                                \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_reset)                                                             \
  as_status_t audiospan_reset(as_instance_t instance) {                                         \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr) return AS_ERROR_INVALID_ARGUMENT;                                    \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    ::audiospan::detail::reset(*effect);                                                        \
    return AS_OK;                                                                               \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_process)                                                           \
  as_status_t audiospan_process(as_instance_t instance, const as_process* process) {            \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || process == nullptr) return AS_ERROR_INVALID_ARGUMENT;              \
    if (process->struct_size < sizeof(as_process)) return AS_ERROR_INVALID_ARGUMENT;            \
    if (process->frame_count == 0) return AS_OK;                                                \
    if (process->output_channels > 0 && process->outputs == nullptr) return AS_ERROR_INVALID_ARGUMENT; \
    if (process->input_channels > 0 && process->inputs == nullptr) return AS_ERROR_INVALID_ARGUMENT;   \
    ::audiospan::ProcessContext ctx;                                                            \
    ctx.frameCount = process->frame_count;                                                      \
    ctx.inputChannels = process->input_channels;                                                \
    ctx.outputChannels = process->output_channels;                                              \
    ctx.inputs = process->inputs;                                                               \
    ctx.outputs = process->outputs;                                                             \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    ::audiospan::detail::beforeProcess(*effect, process->frame_count);                          \
    effect->process(ctx);                                                                       \
    return AS_OK;                                                                               \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_set_parameter)                                                     \
  as_status_t audiospan_set_parameter(as_instance_t instance, uint32_t index, double value) {   \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr) return AS_ERROR_INVALID_ARGUMENT;                                    \
    if (value != value) return AS_ERROR_INVALID_ARGUMENT; /* NaN */                             \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::setParameter(*effect, index, value);                            \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_parameter)                                                     \
  as_status_t audiospan_get_parameter(as_instance_t instance, uint32_t index, double* out) {    \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || out == nullptr) return AS_ERROR_INVALID_ARGUMENT;                  \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::getParameter(*effect, index, *out);                             \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_state_size)                                                    \
  as_status_t audiospan_get_state_size(as_instance_t instance, uint32_t* out_size) {            \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || out_size == nullptr) return AS_ERROR_INVALID_ARGUMENT;             \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::stateSize(*effect, *out_size);                                  \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_state)                                                         \
  as_status_t audiospan_get_state(as_instance_t instance, uint8_t* destination,                 \
                                  uint32_t capacity, uint32_t* out_written) {                   \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || out_written == nullptr) return AS_ERROR_INVALID_ARGUMENT;          \
    if (capacity > 0 && destination == nullptr) return AS_ERROR_INVALID_ARGUMENT;               \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::writeState(*effect, destination, capacity, *out_written);       \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_set_state)                                                         \
  as_status_t audiospan_set_state(as_instance_t instance, const uint8_t* source,                \
                                  uint32_t size) {                                              \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr) return AS_ERROR_INVALID_ARGUMENT;                                    \
    if (size > 0 && source == nullptr) return AS_ERROR_INVALID_ARGUMENT;                        \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::readState(*effect, source, size);                               \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_latency)                                                       \
  as_status_t audiospan_get_latency(as_instance_t instance, uint32_t* out_frames) {             \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || out_frames == nullptr) return AS_ERROR_INVALID_ARGUMENT;           \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::getLatency(*effect, *out_frames);                               \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
                                                                                                \
  AUDIOSPAN_EXPORT(audiospan_get_output)                                                        \
  as_status_t audiospan_get_output(as_instance_t instance, uint32_t index, double* out) {       \
    EffectType* effect = audiospan_table_t::get(instance);                                      \
    if (effect == nullptr || out == nullptr) return AS_ERROR_INVALID_ARGUMENT;                  \
    AUDIOSPAN_DETAIL_TRY                                                                        \
    return ::audiospan::detail::getOutput(*effect, index, *out);                                \
    AUDIOSPAN_DETAIL_CATCH(AS_ERROR_GENERIC)                                                    \
  }                                                                                             \
  } /* extern "C" */

#endif /* AUDIOSPAN_EFFECT_HPP */
