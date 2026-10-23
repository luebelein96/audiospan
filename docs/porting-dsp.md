# Porting existing DSP

This is the reference behind [From your DSP to a web app](from-dsp-to-web.md). That guide ports one filter; this page covers the shapes real code comes in and how each maps onto an Audiospan effect. Read the section that matches your code, then the checklist at the end.

## What the adapter is for

An Audiospan plugin is one class (C++) or one struct implementing a trait (Rust). The host calls it through a fixed set of functions that the helper header generates for you. The adapter's whole job is to translate between the host's calling convention and your code's:

| Host convention | Your code may expect |
| --- | --- |
| Planar `float` buffers: one array per channel, `inputs[ch][frame]` | Interleaved `LRLR…`, `double`, or in-place buffers |
| Variable `frame_count` per call, at most `maxFramesPerProcess` | A fixed block size, often a power of two |
| Sample rate fixed per instance, given at construction | A `setSampleRate()` that can be called any time |
| Channel count negotiated per instance, 1 to 32, input and output equal | Stereo only, or a fixed channel layout |
| Parameters by index, as real values, between blocks | Named parameters, normalized 0 to 1, or atomics read inside the block |
| One thread, never re-entered | Locks, worker threads, lock-free queues |

Everything on the right is handled in the adapter with a few lines each. The sections below show them.

## Buffer layout

**Interleaved code.** Allocate a scratch buffer of `maxFrames × channels` floats in the constructor, interleave into it, call your code, deinterleave back:

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

**In-place code.** Copy each input channel to its output channel first (`memcpy`, they never alias), then run your in-place routine on the output pointers.

**Double-precision code.** Convert at the boundary in the same loops; keep your internals in `double`. The filter in the tutorial does this per sample.

**Missing input.** `ctx.input(ch)` returns `nullptr` when the host provides fewer input channels than output channels; treat it as silence. Mono input to a stereo instance arrives as the same samples on both channels, which the host duplicates for you.

## Block size

The host passes whatever the browser renders: 128 frames today, possibly another size later, never more than the manifest's `audio.maxFramesPerProcess` (default 4096; keep it at least 128). Per-sample and per-block DSP needs nothing special.

Code that requires a fixed block, such as an FFT of 1024 samples, needs an internal FIFO: accumulate input until a full block is available, process it, and output from a ready buffer, emitting zeros until the first block completes. The delay this introduces is latency; declare it as `audio.latencyFrames` in the manifest, or return it from `latencyFrames()` (C++) / `latency_frames()` (Rust) when it depends on a parameter such as an FFT size or oversampling switch. The host reports it to the application and raises `latencychange` when it moves. Mark parameters that change latency `"automatable": false`.

## Sample rate

`HostConfig.sampleRate` is known in the constructor and never changes for that instance; a web `AudioContext` has a fixed rate, and the host creates a new instance if it ever changes. So `prepare(sampleRate)`, `setSampleRate`, or coefficient tables go in the constructor. Do not assume 44.1 or 48 kHz: browsers commonly run at 48 kHz, but 44.1, 96 and others occur.

## Channels

Each instance is created for one channel count, equal on input and output, within the `channels.min` to `channels.max` you declare on the ports. Size per-channel state from `config.maxOutputChannels` in the constructor and loop over `ctx.outputChannels` in `process`. If your code is stereo-only, declare `{ "min": 2, "max": 2 }`; a host configured with `maxChannels: 1` then refuses the plugin with a clear error instead of feeding you one channel.

## Parameters

- **Indices, not names.** The index is the position in the manifest's `parameters` array. `audiospan build` generates `plugin::kCutoff` (C++) and `params::CUTOFF` (Rust) constants from it, so the adapter never hard-codes a number; keep the array order stable across compatible versions.
- **Real values.** The host sends hertz, decibels, seconds, whatever the manifest declares, already clamped to the range. Normalized control positions exist only in the UI, where `scale` and `skew` shape them. If your code wants 0 to 1, convert where you read the value.
- **Smoothing** prevents zipper noise and belongs in the plugin, and the `Parameters` helper does it for you: `value(i)` moves towards the target over about 20 ms at block rate, `ramp(i, frames)` gives a per-sample ramp for gains and mixes, integers, booleans and enums switch instantly, and values set before the first block apply without a fade so presets and restored state land exactly. Change the time constant with `setSmoothing` / `set_smoothing`, or set it to 0 for a parameter that must jump. For per-sample smoothing of a value you derive yourself (a delay time in samples), use `Smoothed`.
- **Recompute derived state only when needed.** `changed(i)` is true when `value(i)` moved since the last block, and also on the first block and after a reset or state restore, so coefficient tables are always built from the live values.
- **Booleans and enums** arrive as 0/1 and as the option's `value`. Mode switches that rebuild internal structures should still not allocate; preallocate every mode's state in the constructor.
- **Reading values inside `process`** is safe without atomics: parameter updates run on the same thread between blocks.

## Real-time rules in WebAssembly

The rules in [realtime-safety.md](realtime-safety.md) apply, with a few WebAssembly specifics:

- **No allocation in `process`.** `std::vector::reserve` and `Vec::with_capacity` in the constructor; `push` only within capacity. Growth of the module's memory during a block is detected and that block is failed.
- **No exceptions.** Projects compile with `-fno-exceptions`; the helper uses `std::nothrow`. If a dependency needs exceptions, add `-fwasm-exceptions` to `cpp.extraFlags` and remove `-fno-exceptions`; the helper then catches everything at the boundary. Rust uses `panic = "abort"`: a panic traps and the host bypasses the instance.
- **No threads, no locks.** WebAssembly here is single-threaded and the host never re-enters; delete the locks, `std::atomic` is harmless but unnecessary, and thread pools cannot exist.
- **No I/O.** `printf`, `std::cout`, `std::fs`, timers and the network have no implementation; WASI stubs return errors and the module grows by tens of kilobytes for `iostream`. For debugging use `audiospan::logInfo` / `abi::log`, compiled in only by `audiospan build --dev`.
- **Denormals.** There is no flush-to-zero mode in WebAssembly. Recursive filters that decay towards zero slow down dramatically once values reach the denormal range (below about 1e-38 for `float`). Add a tiny alternating or DC offset to feedback paths, or clamp small state values to zero at block end.
- **RTTI is off** by default (`-fno-rtti`): no `dynamic_cast` or `typeid`. Re-enable with `cpp.extraFlags` if you must.
- **Floating-point flags.** `-O2`, SIMD and link-time optimisation are on. `-ffast-math` is available through `cpp.extraFlags` but changes results across builds; the test vectors will tell you by how much.

## State

Most ports need no state code at all. With no state methods defined, the helper serialises every parameter value in a small versioned blob (`"ASPS"`, version, count, doubles) and validates it on the way back; the host additionally keeps the values in its JSON document. Write your own `stateSize`/`writeState`/`readState` (all three) only for state the parameters do not capture: an internal mode, a learned value, a random seed. Keep it small (the default limit is 1 MiB), start it with a magic number and a version, and in `readState` reject wrong sizes, unknown versions, out-of-range values and NaN. When the layout changes, bump the version and keep reading the old one if you can. `reset()` is different from state: it clears DSP history (delay lines, filter memory) and keeps parameters.

## Outputs and latency

Values your plugin computes for display, such as a level, gain reduction or a tuner readout, go in the manifest's `outputs` array and are returned from `getOutput(index, out)` / `get_output(index)`. Compute them in `process` and store a member; the host polls between blocks at a bounded rate and shows a meter. Latency is covered under block size above.

## Dependencies and build options

- **Header-only libraries:** add their directory to `includeDirs` in `audiospan.config.json`.
- **Several source files:** list them under `sources`; the CLI passes all of them to one `emcc` call.
- **Prebuilt libraries** need to be compiled with Emscripten themselves; add the `.a` path to `cpp.extraFlags`.
- **Rust crates** must build for `wasm32-unknown-unknown`: pure-Rust DSP crates do; anything touching `std::fs`, threads or the system allocator's tuning does not. `std` itself is fine.
- **Memory:** the module declares a maximum equal to `resources.maxMemoryBytes` (16 MiB by default); raise both the manifest value and, for Rust, `--max-memory` in `.cargo/config.toml` for large tables or long delays.

## If you come from a plugin framework

| JUCE | Audiospan |
| --- | --- |
| `prepareToPlay(sampleRate, blockSize)` | The constructor, from `HostConfig` |
| `processBlock(AudioBuffer&, MidiBuffer&)` | `process(ctx)`; MIDI is not in this release |
| `AudioProcessorValueTreeState` parameters | The `parameters` array in `plugin.json`, read through the generated indices and the `Parameters` helper |
| `SmoothedValue` | `Parameters::value`/`ramp` (block rate and per-sample ramps), or `Smoothed` |
| `NormalisableRange` skew | `"scale": "logarithmic"` or `"skew"` in the manifest |
| `getStateInformation` / `setStateInformation` | Nothing, by default (parameter values are serialised for you); `writeState` / `readState` for extra state |
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

- `audiospan build` without `--dev` (no `MODULE_DEV_LOGGING` warning from `audiospan validate`).
- `audiospan test` passes with vectors that would catch a wrong coefficient or a channel swap.
- Nothing in `process` allocates, locks, logs, or throws; the sandbox's diagnostics show no `audio-processing-error` or `memory-growth`.
- Parameter indices and ranges come from `generated/audiospan_params.*`; nothing in the adapter repeats a number from `plugin.json`.
- Sweeping every knob in the sandbox produces no clicks.
- State round-trips: save, change everything, restore, hear the original.
- `audiospan pack` produces the archive you distribute; your app serves `dist/` as static files.
