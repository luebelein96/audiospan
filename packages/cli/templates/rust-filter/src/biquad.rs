// biquad.rs: a typical pre-existing DSP struct. Nothing here knows about Audiospan;
// replace it with your own code.
pub struct Biquad {
    sample_rate: f64,
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    pub fn new(sample_rate: f64) -> Self {
        Self { sample_rate, b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: 0.0, z2: 0.0 }
    }

    /// RBJ cookbook low-pass.
    pub fn set_lowpass(&mut self, cutoff_hz: f64, q: f64) {
        let w0 = 2.0 * core::f64::consts::PI * cutoff_hz / self.sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let cosw0 = w0.cos();
        let a0 = 1.0 + alpha;
        self.b0 = (1.0 - cosw0) / 2.0 / a0;
        self.b1 = (1.0 - cosw0) / a0;
        self.b2 = self.b0;
        self.a1 = -2.0 * cosw0 / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    #[inline]
    pub fn process_sample(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y as f32
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}
