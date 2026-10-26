---
title: "Plugin authoring (C++)"
description: "The effect class, parameters, state, outputs, latency and the build, for C++ plugins."
---

This page is the reference for the effect class and the build. If you want a walkthrough instead, [From your DSP to a web app](../from-dsp-to-web/) wraps an existing DSP class and ends with it running in a web app. If your code has a different shape, with interleaved buffers, fixed blocks or a JUCE processor, see [Porting existing DSP](../porting-dsp/).

## Prerequisites

- The Emscripten SDK, with `emcc` on your `PATH`. Tested with 3.1.x, 4.x and 5.x. `audiospan doctor` prints the version it finds.
- Node.js 20 or newer and the Audiospan CLI (`npm install -g @audiospan/cli`).

## Create a project

```sh
audiospan create my-effect --language cpp --vendor "Your Name" --id com.yourname.my_effect
cd my-effect
```

There are two templates. `filter`, the default, is a resonant low-pass with a level meter and two presets, built around a stand-in DSP class that you replace with your own. `--template gain` is the smallest complete plugin. You get these files:

```
plugin.json                    manifest (id, parameters, outputs, ports, presets)
audiospan.config.json          build settings: sources, include dirs, emcc options, typesOut
src/plugin.cpp                 your effect class + AUDIOSPAN_DEFINE_EFFECT
src/biquad.h                   (filter) the DSP, independent of Audiospan
generated/audiospan_params.h   regenerated from plugin.json by every build: index enum + parameter table
include/audiospan/             abi.h and effect.hpp, copied from the SDK (do not edit)
presets/*.json
test/vectors.json              known-input/known-output checks for `audiospan test`
```

## Write the effect

`effect.hpp` turns a plain class into a complete ABI implementation. At minimum you need a constructor, `process()`, and some way to handle parameters:

```cpp
#include "audiospan/effect.hpp"
#include "audiospan_params.h"   // generated: plugin::kGain, plugin::kParamCount, plugin::kParameters

class MyEffect {
 public:
  explicit MyEffect(const audiospan::HostConfig& config)        // may allocate; config has sampleRate, maxFrames, channel maxima
      : params_(plugin::kParameters, config.sampleRate) {}
  audiospan::Parameters<plugin::kParamCount>& parameters() noexcept { return params_; }
  void process(const audiospan::ProcessContext& ctx) noexcept;   // real-time

  // Optional, detected at compile time:
  void reset() noexcept;                                         // clear DSP history; parameters persist
  uint32_t latencyFrames() const noexcept;                       // re-read by the host after parameter/state changes
  bool getOutput(uint32_t index, double& out) const noexcept;    // manifest "outputs" (meters); false = bad index
  uint32_t stateSize() const noexcept;                           // all three or none; without them the helper
  bool writeState(uint8_t* dest, uint32_t capacity, uint32_t& written) const noexcept;  // serialises the parameter values
  bool readState(const uint8_t* src, uint32_t size) noexcept;    // false for invalid bytes
 private:
  audiospan::Parameters<plugin::kParamCount> params_;
};
AUDIOSPAN_DEFINE_EFFECT(MyEffect, 16)   // up to 16 simultaneous instances
```

Instead of `parameters()`, a class can implement `bool setParameter(uint32_t index, double value) noexcept` and `bool getParameter(uint32_t index, double& out) const noexcept` itself. The reference plugins under `plugins/` do that, to show the raw contract. You need one or the other. Without either, the helper gives you a compile-time error.

`ProcessContext` has `frameCount`, `inputChannels`, `outputChannels`, planar `inputs` and `outputs` tables, and two helpers: `input(ch)`, which returns `nullptr` for a missing channel, and `output(ch)`. Write every sample of every output channel.

### Parameters

The generated header gives you an enum of indices (`plugin::kCutoff`), `plugin::kParamCount`, a `plugin::kParameters` table of `audiospan::ParameterSpec` entries (id, kind, min, max, default, step), and output indices such as `plugin::kOutLevel`. All of it comes from `plugin.json`. Edit the manifest, build, and the constants follow. Two ids that would produce the same identifier are a build error.

`audiospan::Parameters<N>` is the storage the helper works on:

| Call | Meaning |
| --- | --- |
| `value(i)` | The value for the current block. Smoothed for floats (a 20 ms one-pole at block rate by default), instant for integers, booleans and enums. |
| `changed(i)`, `anyChanged()` | Whether `value(i)` moved since the previous block. True on the first block and after a reset or state restore, so coefficient tables always get built. |
| `ramp(i, frames)` | A per-sample linear ramp from the previous block's value to this one: `auto g = params_.ramp(plugin::kGain, ctx.frameCount); … g.next()` |
| `target(i)` | The last value the host set, before smoothing. |
| `setSmoothing(i, seconds)` | Change the time constant. 0 makes the parameter switch instantly. |
| `snap()` | Jump every parameter to its target. The helper calls it on reset and after a state restore. |

Values arrive in real units such as hertz or decibels. The host clamps them, and `set` clamps them again, rounding integers and snapping booleans. Before the first block every value applies at once, so presets and restored state do not fade in. To smooth a value you derive yourself, use `audiospan::Smoothed`, a per-sample one-pole with `setTime`, `setTarget`, `next()` and `snap()`.

### State

If you define no state methods, the helper saves every parameter value as `{ magic "ASPS", version 1, count, reserved }` followed by little-endian doubles. On restore it checks the header, the count and that every value is finite, then applies the values through the same path the host uses. Most plugins need nothing more.

Define `stateSize`, `writeState` and `readState` together when your plugin has state that its parameters do not capture. Return a versioned blob, reject anything you do not recognise (including NaN and out-of-range values), and bump the version when the layout changes.

### Rules for `process()`

No allocation, no I/O, no locks, no logging, no exceptions, no keeping pointers after you return, and bounded work per frame. [Real-time safety](../realtime-safety/) has the full list. Parameter values are updated between blocks on the same thread, so reading `params_.value(i)` needs no synchronisation.

### Outputs (meters, gain reduction)

Declare read-only values under `outputs` in `plugin.json` and implement `getOutput(index, out)`. The index order follows the array (`plugin::kOutLevel`). The host polls these between process calls, `outputsPerSecond` times a second (30 by default), and the default UI shows each one as a meter. Compute the value inside `process()`, whether that is a peak, an envelope or a gain-reduction figure, and store it in a member. `getOutput` just copies it.

### Latency

Report latency through `latencyFrames()` when it can change at runtime, for example a lookahead that depends on a parameter or an oversampling switch. The host reads it again after every parameter and state change and raises `latencychange` on the instance when it moves. If the method is absent, the host uses the manifest's `audio.latencyFrames`. The runtime does not compensate for latency; see [future features](https://github.com/luebelein96/audiospan/blob/main/docs/future-features.md).

### Logging during development

`audiospan::logInfo("text")` reaches the host console and the sandbox log. So do `logError`, `logWarn`, `logDebug` and `audiospan::log(level, text)`. These calls are only compiled in by `audiospan build --dev` (or `audiospan dev --watch --dev`), which defines `AUDIOSPAN_ENABLE_LOG`. Release builds compile them away and import nothing. A `--dev` module imports `env.audiospan_log`, so a host only accepts it with `pluginLogging: true`; the sandbox turns that on. Lines are rate limited and cut at 1024 bytes. Keep logging out of `process()`.

## Build, test, run

```sh
audiospan build            # regenerates generated/, prints the emcc command, writes dist/ (+ plugin.d.ts), validates
audiospan build --dev      # same, with logging compiled in (imports env.audiospan_log)
audiospan generate         # only the bindings and "typesOut" declarations, without compiling
audiospan test             # generic ABI checks + test/vectors.json
audiospan test --update    # record the current output for cases without "expect"
audiospan validate dist
audiospan dev --watch      # sandbox at http://127.0.0.1:8787/__audiospan/demo/?plugin=/dist/plugin.json, rebuilding on save
audiospan pack             # dist/../<id>-<version>.audiospan.tar.gz + .sha256
```

The build command is:

```
emcc <sources> -I<includeDirs> -Igenerated -O2 -std=c++17 -fno-exceptions -fno-rtti -msimd128 -flto \
  [-DAUDIOSPAN_ENABLE_LOG=1] \
  -sSTANDALONE_WASM=1 --no-entry -sINITIAL_MEMORY=<cpp.initialMemoryBytes> \
  -sMAXIMUM_MEMORY=<resources.maxMemoryBytes> -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=<cpp.stackBytes> <cpp.extraFlags> -o dist/module.wasm
```

WebAssembly SIMD (`-msimd128`) and link-time optimisation (`-flto`) are on by default. Turn them off with `cpp.simd: false` and `cpp.lto: false` in `audiospan.config.json`. Every current browser runs SIMD modules; a host that cannot gets a `MODULE_INVALID` error that names SIMD as the cause. `-sMAXIMUM_MEMORY` comes from the manifest, so the module's declared maximum always matches what hosts enforce. Exports are marked with `AUDIOSPAN_EXPORT` (`__attribute__((export_name))`), so there is no `-sEXPORTED_FUNCTIONS` list to maintain. The module imports only `env.emscripten_notify_memory_growth`, which the runtime provides. If you add code that pulls in stdio, the WASI imports such as `fd_write` are stubbed to return `ENOSYS`; `proc_exit` traps and the plugin is bypassed.

### Test vectors

`test/vectors.json`:

```json
{ "tolerance": 1e-6,
  "cases": [
    { "name": "half gain", "parameters": { "gain": 0.5 }, "input": "ramp", "expect": "input*0.5" },
    { "name": "custom", "parameters": {}, "input": [0.1, 0.2, 0.3], "expect": [0.1, 0.2, 0.3], "channels": 1 }
  ] }
```

Inputs can be `silence`, `impulse`, `ramp`, `sine`, `constant:<v>` or an array. Expectations can be `silence`, `input`, `input*<factor>`, an array, or nothing at all. A case without `expect` fails until `audiospan test --update` records the plugin's current output into the file (channel 0, nine significant digits), which turns it into a regression test. Each case may also set `frames`, `channels` and `tolerance`.

## Exceptions

The template compiles with `-fno-exceptions`, and the helper uses `std::nothrow` for `new`. If you need exceptions, add `-fwasm-exceptions` to `cpp.extraFlags` and remove `-fno-exceptions`. The helper then wraps every export in `try/catch` and returns `AS_ERROR_GENERIC`.

## Using your own build system

Only the exports and the manifest matter. Compile however you like. Keep `include/audiospan/abi.h` as the contract, declare a memory maximum, run `audiospan generate` to refresh `generated/audiospan_params.h` whenever the manifest changes, and run `audiospan validate dist` and `audiospan test`. `abi/examples/passthrough.c` is a complete plugin in plain C without the helper.
