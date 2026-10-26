---
title: "From your DSP to a web app"
description: "Take an existing C++ or Rust filter class to a running React app. Every file is complete."
---

You have DSP code: a filter, a compressor, a delay, written in C++ or Rust for a desktop plugin or a research project. By the end of this guide it runs in a React app. A visitor clicks a button, hears the effect on their microphone, turns two knobs and watches a level meter. Every file on this page is complete, and all of it builds and runs as shown.

The example is a resonant low-pass filter. Its DSP is a plain biquad class that knows nothing about Audiospan. The project the CLI generates contains that class as a stand-in for your own code, so the work is: swap in your DSP, adjust a short adapter, describe the parameters in `plugin.json`, and render one generated React component.

The first time takes about half an hour. Later ports of similar code take minutes.

## Before you start

- Node.js 20 or newer.
- For C++: the Emscripten SDK with `emcc` on your `PATH` (3.1.50 or newer). For Rust: a stable toolchain, 1.80 or newer, with `rustup target add wasm32-unknown-unknown`.
- The Audiospan CLI: `npm install -g @audiospan/cli`. Run `audiospan doctor` to see which toolchains it can find.

The split between host and plugin is fixed. Knowing it up front makes the adapter easy to write:

| The host does | Your plugin does |
| --- | --- |
| Owns every buffer, allocates them inside your module's memory, copies audio in and out | Reads planar `float` input channels, writes every sample of every output channel |
| Calls you from one thread, never concurrently, with up to `maxFramesPerProcess` frames per call | Keeps all DSP state in one object per instance |
| Clamps parameter values to the manifest range and sends them between blocks; the helper stores and smooths them | Reads the smoothed value each block and recomputes coefficients when it moved |
| Renders knobs, meters, presets and bypass from `plugin.json` | Describes parameters and outputs once, in JSON |
| Saves and restores state as JSON, with the parameter values inside | Nothing, unless it has state beyond its parameters |

## 1. Scaffold a project

```sh
audiospan create lowpass --language cpp --vendor "Example Audio" --id com.example.lowpass
cd lowpass
audiospan build && audiospan test
```

Use `--language rust` for Rust. The default template is this exact filter. It builds and passes its tests before you change anything:

```
plugin.json                    what the plugin is: parameters, outputs, ports, presets
audiospan.config.json          how to build it: sources, include dirs, compiler flags
src/biquad.h                   the DSP: a stand-in for your code
src/plugin.cpp                 the adapter (Rust: src/lib.rs + src/abi.rs)
generated/audiospan_params.h   indices, ranges and defaults, regenerated from plugin.json on every build
include/audiospan/             abi.h and effect.hpp from the SDK; do not edit
presets/                       default.json and dark.json
test/vectors.json              known-input, known-output checks for `audiospan test`
```

## 2. Bring your DSP

`src/biquad.h` looks like most hand-written DSP: a prepare call that takes the sample rate, setters that compute coefficients, a per-sample process function and a reset. Replace it with your own code. Nothing in it needs to know about Audiospan.

`src/biquad.h`

```cpp
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
```

If your code is spread over several files, list the `.cpp` files under `sources` in `audiospan.config.json` and any header directories under `includeDirs`. Rust modules are declared in `lib.rs` as usual. [Porting existing DSP](../porting-dsp/) covers code with a different shape: interleaved buffers, fixed FFT block sizes, JUCE processors, in-place processing.

## 3. The adapter

`src/plugin.cpp` is the whole bridge between your DSP and the host. It is one class with a constructor, `process()`, a `parameters()` accessor, and two optional members, `reset` and `getOutput`. The `AUDIOSPAN_DEFINE_EFFECT` line generates every ABI export around it.

`src/plugin.cpp`

```cpp
// Lowpass: an Audiospan effect.
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

// touched
```

What each part does:

- **The constructor is where allocation goes.** `config.sampleRate` and `config.maxOutputChannels` are known there, so the vector of filters is sized once. `process()` allocates nothing. If memory grows during a block, the host treats that block as a failure.
- **`parameters()` hands the helper your `Parameters` object**, built from the generated `plugin::kParameters` table. From then on the helper clamps every incoming value to its range, smooths float parameters over about 20 ms at block rate (integers, booleans and enums switch at once), applies values at once before the first block so presets and restored state do not fade in, and implements set, get, state and reset. You never write a `switch` over parameter indices.
- **`params_.value(i)` is the value for this block.** `params_.changed(i)` tells you when to recompute coefficients. `params_.ramp(i, frames)` gives a per-sample ramp for gains and mixes. `params_.target(i)` is the last value the host set.
- **`reset()` clears DSP history.** It is optional. Parameters survive it, and the helper snaps the smoothers for you.
- **`getOutput()` is optional** and serves the manifest's `outputs` array: read-only values the host polls between blocks and shows as meters. Compute them in `process()`, store a member, return it here.
- **There is no state code.** Without `writeState` and `readState`, the helper saves the parameter values in a small versioned blob and validates it on the way back. Add the three state methods only when the plugin has state its parameters do not capture.

This is the generated header the adapter includes. `audiospan build` rewrites it from `plugin.json` every time, so the indices and ranges can never drift from the manifest:

`generated/audiospan_params.h`

```cpp
// Generated by `audiospan build` from plugin.json (com.example.lowpass 0.1.0). Do not edit; edit plugin.json.
#pragma once

#include "audiospan/effect.hpp"

namespace plugin {

constexpr const char* kId = "com.example.lowpass";
constexpr const char* kVersion = "0.1.0";

enum Param : uint32_t {
  kCutoff = 0,  // "cutoff" (float, 20..20000, default 1000)
  kQ = 1,  // "q" (float, 0.1..10, default 0.707)
  kParamCount = 2
};

inline constexpr audiospan::ParameterSpec kParameters[kParamCount] = {
  {"cutoff", audiospan::ParameterKind::Float, 20.0, 20000.0, 1000.0, 0.0},
  {"q", audiospan::ParameterKind::Float, 0.1, 10.0, 0.707, 0.0},
};

using Parameters = audiospan::Parameters<kParamCount>;

enum Output : uint32_t {
  kOutLevel = 0,  // "level" (0..1)
  kOutputCount = 1
};

}  // namespace plugin
```

<details>
<summary>Rust: <code>src/lib.rs</code> (the template's; <code>src/biquad.rs</code> mirrors the C++ class)</summary>

```rust
//! Lowpass: an Audiospan effect written in Rust.
//!
//! The DSP lives in biquad.rs; replace it with your own code. This file is the
//! adapter: one filter per channel, parameters read through the generated
//! table, and a level meter. Parameter indices, ranges and defaults come from
//! generated/audiospan_params.rs, which `audiospan build` regenerates from
//! plugin.json. The trait defaults store and smooth the parameters and
//! implement state and reset; override them only when you need more.
//! `process` must not allocate or block.

pub mod abi;
mod biquad;
#[path = "../generated/audiospan_params.rs"]
mod params;

use abi::{Effect, HostConfig, Parameters, ProcessContext};
use biquad::Biquad;

pub struct FilterEffect {
    params: Parameters,
    filters: Vec<Biquad>,
    level: f32,
}

impl FilterEffect {
    fn update_coefficients(&mut self) {
        let (cutoff, q) = (self.params.value(params::CUTOFF), self.params.value(params::Q));
        for filter in &mut self.filters {
            filter.set_lowpass(cutoff, q);
        }
    }
}

impl Effect for FilterEffect {
    // Allocate here, never in process(). The host tells you the sample rate and channel count.
    fn create(config: &HostConfig) -> Option<Self> {
        let sample_rate = config.sample_rate as f64;
        let mut effect = Self {
            params: Parameters::new(&params::PARAMETERS, sample_rate),
            filters: (0..config.max_output_channels.max(1)).map(|_| Biquad::new(sample_rate)).collect(),
            level: 0.0,
        };
        effect.update_coefficients();
        abi::log(abi::AS_LOG_DEBUG, "filter: instance created"); // visible with `audiospan build --dev`
        Some(effect)
    }

    fn parameters(&self) -> Option<&Parameters> {
        Some(&self.params)
    }
    fn parameters_mut(&mut self) -> Option<&mut Parameters> {
        Some(&mut self.params)
    }

    // Clear DSP history; parameter values persist.
    fn reset(&mut self) {
        for filter in &mut self.filters {
            filter.reset();
        }
        self.level = 0.0;
        self.params.snap();
    }

    fn process(&mut self, ctx: &mut ProcessContext) {
        // The trait default smooths parameters at block rate; recompute coefficients when they moved.
        if self.params.changed(params::CUTOFF) || self.params.changed(params::Q) {
            self.update_coefficients();
        }
        let mut peak = 0.0f32;
        let last = self.filters.len() - 1;
        for ch in 0..ctx.output_channels() {
            let filter = &mut self.filters[ch.min(last)];
            if let Some((input, output)) = ctx.io(ch) {
                for (i, out) in output.iter_mut().enumerate() {
                    let y = filter.process_sample(input.map_or(0.0, |x| x[i]));
                    *out = y;
                    peak = peak.max(y.abs());
                }
            }
        }
        self.level = peak;
    }

    // Read-only value for the "outputs" array in plugin.json, shown as a meter.
    fn get_output(&self, index: u32) -> Option<f64> {
        (index == params::OUT_LEVEL).then(|| self.level as f64)
    }
}

audiospan_define_effect!(FilterEffect, 16);
```

The `Effect` trait has default implementations of `set_parameter`, `get_parameter`, `reset` and the three state methods. They use the `Parameters` you return from `parameters()` and `parameters_mut()`. `latency_frames` and `get_output` default to "not provided". Implement only what you need. `abi::log` compiles to nothing unless the crate is built with the `audiospan-log` feature, which `audiospan build --dev` turns on.
</details>

## 4. Describe it

`plugin.json` is the single source of truth: for every host, for the default UI, and for the constants in your adapter.

`plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "com.example.lowpass",
  "name": "Lowpass",
  "version": "0.1.0",
  "vendor": "Example Audio",
  "description": "Lowpass: an Audiospan effect.",
  "category": "filter",
  "entry": { "wasm": "module.wasm", "abi": "audiospan-c" },
  "audio": {
    "inputs": [{ "id": "in", "name": "Input", "channels": { "min": 1, "max": 2 } }],
    "outputs": [{ "id": "out", "name": "Output", "channels": { "min": 1, "max": 2 } }]
  },
  "parameters": [
    { "id": "cutoff", "name": "Cutoff", "type": "float", "min": 20, "max": 20000, "default": 1000, "scale": "logarithmic",
      "display": { "style": "knob", "format": "hertz", "precision": 0 } },
    { "id": "q", "name": "Resonance", "type": "float", "min": 0.1, "max": 10, "default": 0.707, "scale": "logarithmic",
      "display": { "style": "knob", "precision": 2 } }
  ],
  "outputs": [
    { "id": "level", "name": "Level", "min": 0, "max": 1, "display": { "format": "linear", "precision": 2 } }
  ],
  "capabilities": { "presets": true },
  "presets": [
    { "id": "default", "name": "Default", "path": "presets/default.json" },
    { "id": "dark", "name": "Dark", "path": "presets/dark.json" }
  ]
}
```

- `"scale": "logarithmic"` makes the cutoff knob travel in octaves, so the midpoint between 20 Hz and 20 kHz sits near 630 Hz instead of 10 kHz. The value that reaches your plugin is still plain hertz. Resonance uses the same scale, because Q is perceived logarithmically too.
- `"display"` picks the control and the formatting. Hosts render a knob labelled `1000 Hz`, `300 Hz` and so on.
- `"outputs"` declares the level meter. Because this array is not empty, the build fails validation unless the module exports `audiospan_get_output`, which the helper generates from your `getOutput`.
- Everything you leave out gets a sensible default: `state`, `latencyFrames`, `maxFramesPerProcess` and the resource limits are all filled in. `"capabilities": { "presets": true }` is the one flag worth setting, so the preset files load.

Presets are plain state documents; `presets/dark.json` sets 300 Hz and a Q of 1.5. Rename a parameter or change a range, run `audiospan build`, and the generated header, the typed declarations for your app and the sandbox all follow.

## 5. Build, test, listen

```sh
audiospan build
```

The CLI regenerates `generated/audiospan_params.h`, prints the exact `emcc` (or `cargo`) command, writes `dist/` with `module.wasm`, `plugin.json`, `plugin.d.ts` and `presets/`, and validates the result: the manifest rules, required and optional exports against the manifest, imports against the allowlist, the memory maximum, and `WebAssembly.validate`. Modules are built with SIMD and link-time optimisation. The filter comes out at about 36 KB.

### Test vectors

`audiospan test` instantiates `dist/module.wasm` in Node. It first runs the generic checks every plugin has to pass (defaults round-trip, bad indices rejected, finite output, varying frame counts, state round-trip and garbage rejection, the optional exports), then your `test/vectors.json`. For a filter, impulse responses are the natural check. The template ships two, computed from the same formulas in double precision.

`test/vectors.json`

```json
{
  "$comment": "Run with `audiospan test` (48 kHz). Arrays compare the first N output samples; omit \"expect\" and `audiospan test --update` records the current output.",
  "tolerance": 1e-6,
  "cases": [
    { "name": "silence stays silent", "parameters": {}, "input": "silence", "expect": "silence" },
    { "name": "impulse response at the defaults (1 kHz, Q 0.707)", "parameters": {}, "input": "impulse", "channels": 1,
      "expect": [0.003916077, 0.014941078, 0.027784692, 0.03802228, 0.045933941, 0.051788867, 0.055842969, 0.058337115] },
    { "name": "impulse response at 200 Hz, Q 2", "parameters": { "cutoff": 200, "q": 2 }, "input": "impulse", "channels": 2,
      "expect": [0.000170224, 0.000678565, 0.001350057, 0.002011899, 0.002663764, 0.00330534, 0.003936322, 0.004556419] }
  ]
}
```

You do not have to work out reference values by hand. Add a case without `expect` and run `audiospan test --update`. The CLI records the current output into the file, and from then on any change in behaviour fails the test.

```json
{ "name": "dark preset, sine", "parameters": { "cutoff": 300, "q": 1.5 }, "input": "sine", "frames": 32, "channels": 1 }
```

### Hear it

```sh
audiospan dev --watch
```

This serves the project and prints a sandbox URL. Click **Start audio**, pick a source (oscillator, noise or microphone), and you get the panel your users will see: two knobs with logarithmic travel, the level meter, the preset menu, bypass, save and restore, and a log of every event. With `--watch`, saving any source file rebuilds the module, and the sandbox reloads it while keeping your settings.

To get a line in that log from inside the plugin, build with logging compiled in:

```sh
audiospan dev --watch --dev     # or: audiospan build --dev
```

The `audiospan::logDebug("filter: instance created")` call in the template's constructor then shows up as `plugin debug: filter: instance created`. A `--dev` module imports a host function, so production hosts refuse it. `audiospan validate` warns about it, and a plain `audiospan build` before shipping removes it.

## 6. Put it in your React app

There are two cases. Starting fresh, let the CLI generate the app with the plugin already wired in. Adding to an app you already have, let it drop the pieces into place. Either way the integration is one component file, and the only thing served besides your site is the plugin's `dist/` folder. The AudioWorklet script is embedded in `@audiospan/react`.

### A new app

```sh
audiospan create lowpass --language cpp --vendor "Example Audio" --id com.example.lowpass --app react
cd lowpass-app
npm install
npm run plugin      # audiospan build --root ../lowpass → public/plugins/lowpass/ and src/plugins/lowpass.d.ts
npm run dev         # open the URL, click "Start audio", allow the microphone
```

If you already created the plugin in step 1, run the same command with `--force`, or pass `--app-dir` to choose where the app goes. The app is Vite plus React plus TypeScript. The plugin project's `audiospan.config.json` now points `outDir` and `typesOut` into it, so every `npm run plugin` refreshes both the artifact and the typed ids.

### An existing app

```sh
cd my-react-app
npx @audiospan/cli init --language cpp --name lowpass --vendor "Example Audio" --id com.example.lowpass
npm install && npm run plugin
```

This creates the plugin project under `audiospan/lowpass/` (move your DSP in as in step 2), writes `src/plugins/lowpass.d.ts` and `src/audiospan/Lowpass.tsx`, and adds `@audiospan/react`, `@audiospan/cli` (as a devDependency, so the scripts need no global install) and the `plugin` / `plugin:watch` scripts to `package.json`. It touches nothing else. In a Next.js app-router project the files go under `app/`, and the component starts with `"use client"`.

### The component

`src/audiospan/Lowpass.tsx` (generated; yours to edit)

```tsx
"use client";
// Lowpass as a React component. Generated by the Audiospan CLI; edit freely.
//
// useAudiospanHost owns the AudioContext and the Audiospan host (start() must run from a click).
// usePlugin loads the plugin into the chain once the host runs; the generated type makes every id a
// compile-time check. useAudioSource connects a source while running: "microphone", an <audio> element,
// a MediaStream, a decoded AudioBuffer, or (context) => AudioNode.
import { BypassButton, Meters, ParameterControls, PresetSelect, useAudioSource, useAudiospanHost, usePlugin } from "@audiospan/react";
import type { LowpassPlugin } from "../plugins/lowpass.js";

const PLUGIN_URL = "/plugins/lowpass/plugin.json";

export function Lowpass() {
  const audio = useAudiospanHost({ onError: (error) => console.error(error.code, error.message) });
  const plugin = usePlugin<LowpassPlugin>(audio.host, PLUGIN_URL);
  const source = useAudioSource(audio, "microphone");
  const error = audio.error ?? plugin.error ?? source.error;
  const status =
    audio.status === "idle" ? "Click Start audio." : audio.status === "starting" ? "Starting…" : plugin.status === "ready" ? `Running ${plugin.descriptor?.name ?? ""}${source.status === "connected" ? " on the microphone" : ""}` : plugin.status === "loading" ? "Loading plugin…" : audio.status === "error" || plugin.status === "error" ? "Failed." : "Idle.";

  return (
    <section className="as-panel">
      <div className="as-panel__toolbar">
        <button type="button" onClick={() => void audio.start()} disabled={audio.status === "running" || audio.status === "starting"}>
          Start audio
        </button>
        <button type="button" onClick={() => void audio.stop()} disabled={audio.status !== "running"}>
          Stop
        </button>
        <BypassButton plugin={plugin} />
        <PresetSelect plugin={plugin} />
      </div>
      <ParameterControls plugin={plugin} />
      <Meters plugin={plugin} />
      <p className="as-panel__status" role="status">
        {status}
      </p>
      {error && (
        <p role="alert" className="as-panel__status" data-status="error">
          {"code" in error ? `${error.code}: ` : ""}
          {error.message}
        </p>
      )}
    </section>
  );
}
```

Three hooks and a handful of components:

- `useAudiospanHost` owns the `AudioContext` and the Audiospan host. `start()` runs from the click. `stop()` tears everything down, and so does unmounting.
- `usePlugin<LowpassPlugin>` loads the plugin into the chain once the host runs and mirrors its values, meter outputs, bypass and latency into React state. The generated type makes `plugin.values.cutoff`, `plugin.setParameter("cutoff", …)` and `plugin.loadPreset("dark")` compile-time checked. `plugin.setParameter("cuttoff", …)` is an error.
- `useAudioSource` connects the microphone while the host runs and stops the tracks when it does not. An `<audio>` element, a `MediaStream`, a decoded `AudioBuffer` or a `(context) => AudioNode` function work the same way.
- `ParameterControls` renders a knob or slider per parameter, with logarithmic travel where the manifest asks for it. `Meters` renders the level meter, and `PresetSelect` and `BypassButton` the rest. For your own layout, `<Knob plugin={plugin} id="cutoff" />` and friends place single controls, and `useParameter(plugin, "cutoff")` gives you the value, the normalized position, setters and a formatter for a component of your own.

Saving settings is one call away: `plugin.plugin?.getState()` returns JSON you can keep in `localStorage` and pass back as `initialState` in `usePlugin`'s options.

### Without React

The same app in plain TypeScript is `AudiospanHost.create({ audioContext })`, `host.addPlugin<LowpassPlugin>(url)`, `host.connectSource(node)`, `host.connectDestination(audioContext.destination)` and `renderPluginPanel(element, plugin)`. [Web app integration](../web-app-integration/) has it in full, with bundler notes.

## 7. Ship it

```sh
cd ../lowpass
audiospan pack          # dist/../com.example.lowpass-0.1.0.audiospan.tar.gz with SHA-256 checksums
```

The archive is for distributing the plugin to other hosts. Your own app just deploys `public/` with the rest of the site. Static hosting is all it needs, as long as:

- **It is HTTPS** (or `localhost`). AudioWorklet requires a secure context.
- **`.wasm` is served as `application/wasm`.** Every major static host and CDN does this. A dev server that returns `application/octet-stream` makes loading fail with `MODULE_INVALID`.
- **The plugin is on the same origin**, or listed in `allowedPluginOrigins` in the host's `pluginPolicy`, with CORS headers on the plugin files.
- **Your Content Security Policy allows it.** If you set `script-src`, add `'wasm-unsafe-eval'` so the worklet can compile the module, and `blob:` for the embedded worklet (or serve `@audiospan/runtime/dist/audiospan-worklet.js` and pass `workletUrl`). No cross-origin isolation, `SharedArrayBuffer` or special headers are needed.
- **Caches cannot mix versions.** Put the plugin version in the path (`/plugins/lowpass/0.1.0/`) or let your build hash the files, so a new build is never served against a cached manifest.
- **The microphone can be asked for.** `getUserMedia` also needs a secure context and a user gesture. The generated component asks when the user clicks Start.

## 8. Where to go next

- [Porting existing DSP](../porting-dsp/): interleaved buffers, fixed block sizes, JUCE and VST3 concepts, denormals, dependencies, and a checklist before you ship.
- [Web app integration](../web-app-integration/): bundlers and frameworks, audio sources, several plugins in a chain, custom UIs, error handling.
- [Plugin authoring (C++)](../plugin-authoring/) and [Rust](../rust-plugin-authoring/): the full effect class contract, the `Parameters` and `Smoothed` helpers, and build options.
- [Manifest schema](../manifest-schema/): every field, including `skew`, `automatable`, `bipolar` and the output formats.
- [Real-time safety](../realtime-safety/): what `process()` may and may not do, and what the runtime does when it fails.
