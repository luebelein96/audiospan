//! __PLUGIN_NAME__: an Audiospan effect written in Rust.
//!
//! The smallest complete plugin: `create`, `process`, and the two `parameters`
//! accessors. Indices, ranges and defaults come from
//! generated/audiospan_params.rs, regenerated from plugin.json by
//! `audiospan build`. The trait defaults store and smooth the parameters and
//! implement state and reset. `process` must not allocate or block.

pub mod abi;
#[path = "../generated/audiospan_params.rs"]
mod params;

use abi::{Effect, HostConfig, Parameters, ProcessContext};

pub struct GainEffect {
    params: Parameters,
}

impl Effect for GainEffect {
    fn create(config: &HostConfig) -> Option<Self> {
        Some(Self { params: Parameters::new(&params::PARAMETERS, config.sample_rate as f64) })
    }

    fn parameters(&self) -> Option<&Parameters> {
        Some(&self.params)
    }
    fn parameters_mut(&mut self) -> Option<&mut Parameters> {
        Some(&mut self.params)
    }

    fn process(&mut self, ctx: &mut ProcessContext) {
        for ch in 0..ctx.output_channels() {
            let mut gain = self.params.ramp(params::GAIN, ctx.frame_count()); // per-sample ramp: click-free
            if let Some((input, output)) = ctx.io(ch) {
                for (i, out) in output.iter_mut().enumerate() {
                    *out = input.map_or(0.0, |x| x[i]) * gain.next() as f32;
                }
            }
        }
    }
}

audiospan_define_effect!(GainEffect, 16);
