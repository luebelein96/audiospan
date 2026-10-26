---
title: "Porting existing DSP"
description: "How real DSP code maps onto an Audiospan effect: interleaved buffers, fixed block sizes, JUCE and VST3 concepts, denormals, dependencies."
---

[From your DSP to a web app](../from-dsp-to-web/) ports one filter from start to finish. This page is the reference behind it: the shapes real code comes in, and what each one needs in the adapter. Read the section that matches your code, then the checklist at the end.

## What the adapter is for

An Audiospan plugin is one class in C++, or one struct implementing a trait in Rust. The host calls it through a fixed set of functions that the helper generates for you. The adapter's only job is to translate between what the host does and what your code expects:

| Host convention | Your code may expect |
| --- | --- |
| Planar `float` buffers: one array per channel, `inputs[ch][frame]` | Interleaved `LRLR…`, `double`, or in-place buffers |
| Variable `frame_count` per call, at most `maxFramesPerProcess` | A fixed block size, often a power of two |
| Sample rate fixed per instance, given at construction | A `setSampleRate()` that can be called any time |
| Channel count negotiated per instance, 1 to 32, input and output equal | Stereo only, or a fixed channel layout |
| Parameters by index, as real values, between blocks | Named parameters, normalized 0 to 1, or atomics read inside the block |
| One thread, never re-entered | Locks, worker threads, lock-free queues |

Each item on the right takes a few lines in the adapter. The sections below show them.

## Buffer layout

**Interleaved code.** Allocate a scratch buffer of `maxFrames × channels` floats in the constructor. Interleave into it, call your code, then deinterleave back:

```cpp
explicit MyEffect(const audiospan::HostConfig& config)
    : channels_(config.maxOutputChannels), scratch_(config.maxFrames * config.maxOutputChannels) {}

void process(const audiospan::ProcessContext& ctx) noexcept {
  const uint32_t n = ctx.frameCount, c = ctx.outputChannels;
  for (uint32_t ch = 0; ch < c; ++ch) {
    const float* in = ctx.input(ch);
    for (uint32_t i = 0; i < n; ++i) scratch_[i * c + ch] = in ? in[i] : 0.0f;
  }
  dsp_.processInterleaved(scratch_.data(), n, c);           // your existing call
  for (uint32_t ch = 0; ch < c; ++ch)
    for (uint32_t i = 0; i < n; ++i) ctx.outputs[ch][i] = scratch_[i * c + ch];
}
```

**In-place code.** Copy each input channel to its output channel first (`memcpy` is fine, they never alias), then run your in-place routine on the output pointers.

**Double-precision code.** Convert at the boundary, in the same loops, and keep your internals in `double`. The filter in the tutorial does this per sample.

**Missing input.** `ctx.input(ch)` returns `nullptr` when the host provides fewer input channels than output channels. Treat it as silence. Mono input into a stereo instance arrives as the same samples on both channels; the host duplicates them for you.

## Block size

The host passes whatever the browser renders: 128 frames today, maybe another size later, and never more than the manifest's `audio.maxFramesPerProcess` (4096 by default; keep it at least 128). Per-sample and per-block DSP needs nothing special.

Code that needs a fixed block, such as an FFT of 1024 samples, needs an internal FIFO. Collect input until a full block is ready, process it, and output from a finished buffer, writing zeros until the first block completes. The delay this adds is latency. Declare it as `audio.latencyFrames` in the manifest, or return it from `latencyFrames()` in C++ or `latency_frames()` in Rust when it depends on a parameter such as an FFT size or an oversampling switch. The host passes it on to the application and raises `latencychange` when it moves. Mark parameters that change latency as `"automatable": false`.

## Sample rate

`HostConfig.sampleRate` is known in the constructor and never changes for that instance. A web `AudioContext` has a fixed rate, and the host creates a new instance if it ever changes. So `prepare(sampleRate)`, `setSampleRate` and coefficient tables all belong in the constructor. Do not assume 44.1 or 48 kHz. Browsers usually run at 48 kHz, but 44.1, 96 and other rates happen.

## Channels

Each instance is created for one channel count, the same on input and output, within the `channels.min` to `channels.max` you declare on the ports. Size per-channel state from `config.maxOutputChannels` in the constructor and loop over `ctx.outputChannels` in `process`. If your code is stereo only, declare `{ "min": 2, "max": 2 }`. A host configured with `maxChannels: 1` then refuses the plugin with a clear error instead of feeding you one channel.

## Parameters

- **Indices, not names.** The index is the position in the manifest's `parameters` array. `audiospan build` generates `plugin::kCutoff` (C++) and `params::CUTOFF` (Rust) constants from it, so the adapter never hard-codes a number. Keep the array order stable across compatible versions.
- **Real values.** The host sends hertz, decibels, seconds, whatever the manifest declares, already clamped to the range. Normalized control positions exist only in the UI, where `scale` and `skew` shape them. If your code wants 0 to 1, convert where you read the value.
- **Smoothing** prevents zipper noise and belongs in the plugin. The `Parameters` helper does it for you: `value(i)` moves towards the target over about 20 ms at block rate, and `ramp(i, frames)` gives you a per-sample ramp for gains and mixes. Integers, booleans and enums switch at once. Values set before the first block apply without a fade, so presets and restored state land exactly. Change the time constant with `setSmoothing` or `set_smoothing`, or set it to 0 for a parameter that has to jump. For per-sample smoothing of a value you derive yourself, such as a delay time in samples, use `Smoothed`.
- **Recompute derived state only when needed.** `changed(i)` is true when `value(i)` moved since the last block, and also on the first block and after a reset or state restore, so coefficient tables are always built from live values.
- **Booleans and enums** arrive as 0 or 1, and as the option's `value`. A mode switch that rebuilds internal structures must still not allocate. Preallocate every mode's state in the constructor.
- **Reading values inside `process`** is safe without atomics. Parameter updates run on the same thread, between blocks.

## Real-time rules in WebAssembly

The rules in [Real-time safety](../realtime-safety/) apply, with a few WebAssembly specifics:

- **No allocation in `process`.** Call `std::vector::reserve` or `Vec::with_capacity` in the constructor, and only `push` within capacity. If the module's memory grows during a block, that block is marked as failed.
- **No exceptions.** Projects compile with `-fno-exceptions`, and the helper uses `std::nothrow`. If a dependency needs exceptions, add `-fwasm-exceptions` to `cpp.extraFlags` and remove `-fno-exceptions`; the helper then catches everything at the boundary. Rust uses `panic = "abort"`: a panic traps and the host bypasses the instance.
- **No threads, no locks.** WebAssembly here is single-threaded and the host never re-enters. Delete the locks. `std::atomic` is harmless but pointless, and thread pools cannot exist.
- **No I/O.** `printf`, `std::cout`, `std::fs`, timers and the network have no implementation. WASI stubs return errors, and `iostream` adds tens of kilobytes to the module. For debugging use `audiospan::logInfo` or `abi::log`, which only `audiospan build --dev` compiles in.
- **Denormals.** WebAssembly has no flush-to-zero mode. Recursive filters that decay towards zero slow down a lot once values reach the denormal range (below about 1e-38 for `float`). Add a tiny alternating or DC offset to feedback paths, or clamp small state values to zero at the end of each block.
- **RTTI is off** by default (`-fno-rtti`): no `dynamic_cast` or `typeid`. Re-enable it through `cpp.extraFlags` if you must.
- **Floating-point flags.** `-O2`, SIMD and link-time optimisation are on. `-ffast-math` is available through `cpp.extraFlags` but changes results between builds; the test vectors will show you by how much.

## State

Most ports need no state code at all. With no state methods defined, the helper saves every parameter value in a small versioned blob (`"ASPS"`, version, count, doubles) and validates it on the way back. The host keeps the values in its JSON document as well. Write your own `stateSize`, `writeState` and `readState` (all three) only for state the parameters do not capture: an internal mode, a learned value, a random seed. Keep it small (the default limit is 1 MiB), start it with a magic number and a version, and have `readState` reject wrong sizes, unknown versions, out-of-range values and NaN. When the layout changes, bump the version and keep reading the old one if you can. `reset()` is a different thing: it clears DSP history such as delay lines and filter memory, and keeps parameters.

## Outputs and latency

Values your plugin computes for display, such as a level, gain reduction or a tuner readout, go in the manifest's `outputs` array and are returned from `getOutput(index, out)` or `get_output(index)`. Compute them in `process` and store a member. The host polls between blocks at a bounded rate and shows a meter. Latency is covered under block size above.

## Dependencies and build options

- **Header-only libraries:** add their directory to `includeDirs` in `audiospan.config.json`.
- **Several source files:** list them under `sources`. The CLI passes all of them to one `emcc` call.
- **Prebuilt libraries** have to be compiled with Emscripten themselves. Add the `.a` path to `cpp.extraFlags`.
- **Rust crates** must build for `wasm32-unknown-unknown`. Pure-Rust DSP crates do. Anything that touches `std::fs`, threads or allocator tuning does not. `std` itself is fine.
- **Memory:** the module declares a maximum equal to `resources.maxMemoryBytes` (16 MiB by default). For large tables or long delays, raise the manifest value and, for Rust, `--max-memory` in `.cargo/config.toml`.

## If you come from a plugin framework

| JUCE | Audiospan |
| --- | --- |
| `prepareToPlay(sampleRate, blockSize)` | The constructor, from `HostConfig` |
| `processBlock(AudioBuffer&, MidiBuffer&)` | `process(ctx)`; MIDI is not in this release |
| `AudioProcessorValueTreeState` parameters | The `parameters` array in `plugin.json`, read through the generated indices and the `Parameters` helper |
| `SmoothedValue` | `Parameters::value`/`ramp` (block rate and per-sample ramps), or `Smoothed` |
| `NormalisableRange` skew | `"scale": "logarithmic"` or `"skew"` in the manifest |
| `getStateInformation` / `setStateInformation` | Nothing, by default (parameter values are saved for you); `writeState` / `readState` for extra state |
| `getLatencySamples()` | `audio.latencyFrames` or `latencyFrames()` |
| `reset()` | `reset()` |
| `releaseResources()` | The destructor |
| `AudioProcessorEditor` | The default panel from `@audiospan/ui`, or the host's own controls from `createControlModels` |

| VST3 / CLAP concept | Audiospan |
| --- | --- |
| Component / plugin class | Your effect class |
| Parameter id and normalized value | Manifest `id` for hosts and presets; index for the ABI; real values on the wire |
| Bus arrangement | One input port and one output port with a channel range |
| Component state stream | The state blob |
| Factory / entry point | `AUDIOSPAN_DEFINE_EFFECT` / `audiospan_define_effect!`, plus `plugin.json` for metadata |

## Checklist before you ship

- Build with `audiospan build`, without `--dev`, so `audiospan validate` shows no `MODULE_DEV_LOGGING` warning.
- `audiospan test` passes, with vectors that would catch a wrong coefficient or a channel swap.
- Nothing in `process` allocates, locks, logs or throws. The sandbox's diagnostics show no `audio-processing-error` or `memory-growth`.
- Parameter indices and ranges come from `generated/audiospan_params.*`. Nothing in the adapter repeats a number from `plugin.json`.
- Sweeping every knob in the sandbox produces no clicks.
- State round-trips: save, change everything, restore, hear the original.
- `audiospan pack` produces the archive you distribute, and your app serves `dist/` as static files.
