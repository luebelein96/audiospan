---
title: "Plugin authoring (Rust)"
description: "The Effect trait, parameters, memory limits and the build for Rust plugins."
---

This is the reference for the `Effect` trait and the build. For a walkthrough that wraps an existing DSP struct, read [From your DSP to a web app](../from-dsp-to-web/); the Rust files sit next to the C++ ones there. [Porting existing DSP](../porting-dsp/) covers other code shapes.

## Prerequisites

- Rust stable 1.80 or newer (`[const { None }; N]` needs 1.79), with `rustup target add wasm32-unknown-unknown`.
- Node.js 20 or newer and the Audiospan CLI.

## Create a project

```sh
audiospan create my-effect --language rust      # --template gain for the smallest plugin
cd my-effect
```

```
Cargo.toml                      cdylib, panic = "abort", opt-level 2, lto, the audiospan-log feature
.cargo/config.toml              default target wasm32-unknown-unknown, +simd128, linker memory limits
src/abi.rs                      ABI bindings, Parameters, Smoothed, Effect trait, audiospan_define_effect! macro (do not edit)
src/lib.rs                      your effect
src/biquad.rs                   (filter template) the DSP, independent of Audiospan
generated/audiospan_params.rs   regenerated from plugin.json by every build: index constants + PARAMETERS table
plugin.json, audiospan.config.json, presets/, test/vectors.json
```

## Write the effect

```rust
pub mod abi;
#[path = "../generated/audiospan_params.rs"]
mod params;                                   // params::GAIN, params::PARAMETER_COUNT, params::PARAMETERS

use abi::{Effect, HostConfig, Parameters, ProcessContext};

pub struct MyEffect { params: Parameters }

impl Effect for MyEffect {
    fn create(config: &HostConfig) -> Option<Self> {       // may allocate
        Some(Self { params: Parameters::new(&params::PARAMETERS, config.sample_rate as f64) })
    }
    fn parameters(&self) -> Option<&Parameters> { Some(&self.params) }
    fn parameters_mut(&mut self) -> Option<&mut Parameters> { Some(&mut self.params) }
    fn process(&mut self, ctx: &mut ProcessContext) {       // real-time
        for ch in 0..ctx.output_channels() {
            let mut gain = self.params.ramp(params::GAIN, ctx.frame_count());
            if let Some((input, output)) = ctx.io(ch) {
                for (i, o) in output.iter_mut().enumerate() { *o = input.map_or(0.0, |x| x[i]) * gain.next() as f32; }
            }
        }
    }
    // Optional: reset, latency_frames, get_output, state_size/write_state/read_state.
}

audiospan_define_effect!(MyEffect, 16);
```

Only `create` and `process` are required. Return a `Parameters` from `parameters()` and `parameters_mut()`, and the trait's default methods take care of `set_parameter`, `get_parameter`, `reset` (which snaps the smoothers) and the three state methods, which store the parameter values in a versioned blob. If you would rather implement `set_parameter` and `get_parameter` yourself, you can; the reference plugin in `plugins/gain-rust` does. `latency_frames` and `get_output` return `None` by default, which means "not provided".

`ProcessContext` gives you `frame_count()`, `input(ch) -> Option<&[f32]>`, `output(ch) -> Option<&mut [f32]>`, and `io(ch)` for both at once. The buffers belong to the host and are only valid during `process`.

### Parameters

The generated module has one constant per parameter (`pub const CUTOFF: u32 = 0;` and so on), `PARAMETER_COUNT`, a `PARAMETERS: [ParameterSpec; N]` table with id, kind, min, max, default and step, and output indices such as `OUT_LEVEL`. All of it comes from `plugin.json`.

`Parameters` in `abi.rs` is the storage the trait defaults work on:

- `value(i)` is the smoothed value for the current block. Floats use a 20 ms one-pole smoother at block rate; integers, booleans and enums switch at once.
- `changed(i)` tells you whether it moved since the previous block. It is true on the first block and after a reset or a state restore.
- `ramp(i, frames)` gives you a per-sample linear ramp.
- `target(i)` is the last value the host set.
- `set_smoothing(i, seconds)` changes the time constant, and `snap()` jumps straight to the targets.

Values arrive in real units and are clamped when set. Before the first block they apply at once, so presets and restored state do not fade in. `Smoothed` is a standalone per-sample one-pole for values you derive yourself.

Outputs are read-only values declared under `outputs` in `plugin.json`, such as meters or gain reduction. Return them from `get_output(index)`. The host polls them between process calls and the default UI shows a meter. `latency_frames` lets a plugin whose latency depends on a parameter report it; the host raises `latencychange` when it moves but does not compensate. If you override `reset`, call `self.params.snap()`.

`abi::log(abi::AS_LOG_INFO, "text")` reaches the host console in development builds. `audiospan build --dev` turns on the crate's `audiospan-log` feature, which imports `env.audiospan_log`. A host only accepts such a module with `pluginLogging: true`. Without the feature the function does nothing and nothing is imported.

The macro generates every `audiospan_*` export as `#[no_mangle] extern "C"`, a fixed-capacity instance table, an allocator pair (`audiospan_alloc` stores size and alignment in a header so `free` can rebuild the layout), NaN rejection, struct-size negotiation, a `begin_block` call on your `Parameters` before each `process`, and `catch_unwind` around every body. With `panic = "abort"` a panic cannot unwind, so it traps instead. The host handles that by bypassing the instance and reporting `INSTANCE_ERRORED`.

## Memory limits

`.cargo/config.toml` passes `--initial-memory=1048576 --max-memory=16777216 -zstack-size=65536` to the linker and turns on `target-feature=+simd128`, which every current browser supports. Remove it to build without SIMD. The maximum must not exceed `resources.maxMemoryBytes` in `plugin.json`; `audiospan validate` checks this.

## Build, test, run

```sh
audiospan build        # regenerates generated/, cargo build --release --target wasm32-unknown-unknown, copies the .wasm to dist/, validates
audiospan build --dev  # adds --features audiospan-log
audiospan test         # generic ABI checks + test/vectors.json; --update records missing expectations
audiospan dev --watch  # sandbox that rebuilds on save
audiospan pack
```

The crate name comes from `Cargo.toml`. Override it with `rust.crateName` in `audiospan.config.json`. Set `rust.profile` to `dev` for unoptimised builds.
