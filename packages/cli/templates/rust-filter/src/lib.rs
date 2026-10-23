//! __PLUGIN_NAME__: an Audiospan effect written in Rust.
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
