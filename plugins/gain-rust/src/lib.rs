//! Gain Rust — an Audiospan effect written in Rust.
//!
//! Edit `GainEffect`. The `audiospan_define_effect!` macro generates every ABI
//! export. Parameter indices follow the order of the "parameters" array in
//! plugin.json. `process` must not allocate or block.

pub mod abi;

use abi::{Effect, HostConfig, ProcessContext};

const STATE_MAGIC: u32 = 0x4E47_4153;
const STATE_VERSION: u32 = 1;
const STATE_SIZE: u32 = 12;
const GAIN_MIN: f64 = 0.0;
const GAIN_MAX: f64 = 2.0;
const GAIN_DEFAULT: f64 = 1.0;

pub struct GainEffect {
    gain: f32,
    /// Peak absolute sample of the last processed block (output "level").
    level: f32,
}

impl Effect for GainEffect {
    fn create(_config: &HostConfig) -> Option<Self> {
        abi::log(abi::AS_LOG_DEBUG, "gain-rust: instance created"); // visible only in `audiospan build --dev` builds
        Some(Self { gain: GAIN_DEFAULT as f32, level: 0.0 })
    }

    fn reset(&mut self) {
        // Gain has no DSP history.
        self.level = 0.0;
    }

    // Optional: the host re-reads this after parameter and state changes.
    fn latency_frames(&self) -> Option<u32> {
        Some(0)
    }

    // Optional: read-only values for the manifest's "outputs" array.
    fn get_output(&self, index: u32) -> Option<f64> {
        (index == 0).then(|| self.level as f64)
    }

    fn set_parameter(&mut self, index: u32, value: f64) -> bool {
        if index != 0 {
            return false;
        }
        self.gain = value.clamp(GAIN_MIN, GAIN_MAX) as f32;
        true
    }

    fn get_parameter(&self, index: u32) -> Option<f64> {
        if index == 0 {
            Some(self.gain as f64)
        } else {
            None
        }
    }

    fn process(&mut self, ctx: &mut ProcessContext) {
        let gain = self.gain;
        let mut peak = 0.0f32;
        for ch in 0..ctx.output_channels() {
            if let Some((input, output)) = ctx.io(ch) {
                match input {
                    Some(input) => {
                        for (o, i) in output.iter_mut().zip(input.iter()) {
                            let v = *i * gain;
                            *o = v;
                            let a = v.abs();
                            if a > peak {
                                peak = a;
                            }
                        }
                    }
                    None => output.fill(0.0),
                }
            }
        }
        self.level = peak;
    }

    fn state_size(&self) -> u32 {
        STATE_SIZE
    }

    fn write_state(&self, dest: &mut [u8]) -> Option<u32> {
        if dest.len() < STATE_SIZE as usize {
            return None;
        }
        dest[0..4].copy_from_slice(&STATE_MAGIC.to_le_bytes());
        dest[4..8].copy_from_slice(&STATE_VERSION.to_le_bytes());
        dest[8..12].copy_from_slice(&self.gain.to_le_bytes());
        Some(STATE_SIZE)
    }

    fn read_state(&mut self, src: &[u8]) -> bool {
        if src.len() != STATE_SIZE as usize {
            return false;
        }
        let magic = u32::from_le_bytes([src[0], src[1], src[2], src[3]]);
        let version = u32::from_le_bytes([src[4], src[5], src[6], src[7]]);
        let gain = f32::from_le_bytes([src[8], src[9], src[10], src[11]]);
        if magic != STATE_MAGIC || version != STATE_VERSION {
            return false;
        }
        if !(gain >= GAIN_MIN as f32 && gain <= GAIN_MAX as f32) {
            return false; // also rejects NaN
        }
        self.gain = gain;
        true
    }
}

audiospan_define_effect!(GainEffect, 16);
