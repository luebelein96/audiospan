# Plugin authoring (Rust)

This is the reference for the `Effect` trait and the build. [From your DSP to a web app](from-dsp-to-web.md) walks through wrapping an existing DSP struct, with the Rust files alongside the C++ ones; [Porting existing DSP](porting-dsp.md) covers other code shapes.

## Prerequisites

- Rust stable 1.80+ (`[const { None }; N]` requires 1.79) with `rustup target add wasm32-unknown-unknown`.
- Node.js 20+ and the Audiospan CLI.

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

`create` and `process` are the only required methods. Return a [`Parameters`] from `parameters()`/`parameters_mut()` and the trait's defaults implement `set_parameter`, `get_parameter`, `reset` (which snaps the smoothers) and the three state methods (the parameter values in a versioned blob). Implement `set_parameter`/`get_parameter` yourself instead if you prefer the raw contract, as the reference plugin under `plugins/gain-rust` does. `latency_frames` and `get_output` default to `None`, meaning "not provided".

`ProcessContext` exposes `frame_count()`, `input(ch) -> Option<&[f32]>`, `output(ch) -> Option<&mut [f32]>`, and `io(ch)` for both at once. Buffers are host-owned and valid only during `process`.

### Parameters

The generated module declares `pub const CUTOFF: u32 = 0;`-style constants, `PARAMETER_COUNT`, a `PARAMETERS: [ParameterSpec; N]` table (id, kind, min, max, default, step) and `OUT_LEVEL`-style output indices, all from `plugin.json`. `Parameters` (`abi.rs`) is the storage the trait defaults drive: `value(i)` is the smoothed value for the current block (20 ms one-pole at block rate for floats; integers, booleans and enums switch instantly), `changed(i)` says whether it moved since the previous block (true on the first block and after a reset or state restore), `ramp(i, frames)` gives a per-sample linear ramp, `target(i)` is the last value the host set, `set_smoothing(i, seconds)` changes the time constant and `snap()` jumps to the targets. Values arrive in real units and are clamped on set; before the first block they apply instantly, so presets and restored state do not fade in. `Smoothed` is a standalone per-sample one-pole for values you derive yourself.

Outputs are read-only values declared under `outputs` in `plugin.json` (meters, gain reduction); return them from `get_output(index)` and the host polls between process calls while the default UI shows a meter. `latency_frames` lets a plugin whose latency depends on a parameter report it; the host raises `latencychange` when it moves (it does not compensate). If you override `reset`, call `self.params.snap()`.

`abi::log(abi::AS_LOG_INFO, "text")` reaches the host console in development builds: `audiospan build --dev` enables the crate's `audiospan-log` feature, which imports `env.audiospan_log`. Hosts accept such a module only with `pluginLogging: true`; without the feature the function is a no-op and nothing is imported.

The macro generates all `audiospan_*` exports with `#[no_mangle] extern "C"`, a fixed-capacity instance table, an allocator pair (`audiospan_alloc` stores size and alignment in a header so `free` can rebuild the layout), NaN rejection, struct-size negotiation, a `begin_block` call on your `Parameters` before each `process`, and `catch_unwind` around every body. With `panic = "abort"` a panic cannot unwind; it traps instead, which the host handles by bypassing the instance and reporting `INSTANCE_ERRORED`.

## Memory limits

`.cargo/config.toml` passes `--initial-memory=1048576 --max-memory=16777216 -zstack-size=65536` to the linker and enables `target-feature=+simd128`, which every current browser supports (remove it to build a module without SIMD). The maximum must be ≤ `resources.maxMemoryBytes` in `plugin.json`; `audiospan validate` checks this.

## Build, test, run

```sh
audiospan build        # regenerates generated/, cargo build --release --target wasm32-unknown-unknown, copies the .wasm to dist/, validates
audiospan build --dev  # adds --features audiospan-log
audiospan test         # generic ABI checks + test/vectors.json; --update records missing expectations
audiospan dev --watch  # sandbox that rebuilds on save
audiospan pack
```

The crate name comes from `Cargo.toml`; override with `rust.crateName` in `audiospan.config.json`. `rust.profile` may be `dev` for unoptimized builds.
