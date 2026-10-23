//! Audiospan C ABI bindings and glue for Rust effects.
//!
//! This file mirrors `abi/include/audiospan/abi.h` exactly. Implement the
//! [`Effect`] trait for your type and invoke `audiospan_define_effect!` once
//! to generate the exports. No panic crosses the boundary: every export wraps
//! its body in `catch_unwind` (with `panic = "abort"` a panic traps instead,
//! which the host also handles by bypassing the plugin).
//!
//! Required: [`Effect::create`] and [`Effect::process`]. For parameters either
//! implement [`Effect::set_parameter`] and [`Effect::get_parameter`], or keep
//! a [`Parameters`] field and return it from [`Effect::parameters`] and
//! [`Effect::parameters_mut`]; the trait's default methods then implement
//! set/get, reset and state for you. `audiospan build` generates
//! `generated/audiospan_params.rs` from plugin.json with index constants and
//! the `PARAMETERS` table that [`Parameters::new`] takes.
#![allow(dead_code)]

use core::alloc::Layout;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub type AsStatus = u32;
pub type AsInstance = u32;

pub const AUDIOSPAN_ABI_VERSION: u32 = 1;

pub const AS_OK: AsStatus = 0;
pub const AS_ERROR_GENERIC: AsStatus = 1;
pub const AS_ERROR_INVALID_ARGUMENT: AsStatus = 2;
pub const AS_ERROR_UNSUPPORTED: AsStatus = 3;
pub const AS_ERROR_OUT_OF_MEMORY: AsStatus = 4;
pub const AS_ERROR_BAD_STATE: AsStatus = 5;
pub const AS_ERROR_BUFFER_TOO_SMALL: AsStatus = 6;
pub const AS_ERROR_INVALID_FORMAT: AsStatus = 7;

pub const AS_LOG_ERROR: u32 = 0;
pub const AS_LOG_WARN: u32 = 1;
pub const AS_LOG_INFO: u32 = 2;
pub const AS_LOG_DEBUG: u32 = 3;

#[repr(C)]
pub struct AsHostConfig {
    pub struct_size: u32,
    pub sample_rate: u32,
    pub max_frames: u32,
    pub max_input_channels: u32,
    pub max_output_channels: u32,
}

#[repr(C)]
pub struct AsProcess {
    pub struct_size: u32,
    pub frame_count: u32,
    pub input_channels: u32,
    pub output_channels: u32,
    pub inputs: *const *const f32,
    pub outputs: *const *mut f32,
}

/// Host configuration handed to [`Effect::create`].
#[derive(Clone, Copy, Debug)]
pub struct HostConfig {
    pub sample_rate: u32,
    pub max_frames: u32,
    pub max_input_channels: u32,
    pub max_output_channels: u32,
}

/// Safe view over one process call. Buffers are owned by the host and valid
/// only for the duration of [`Effect::process`].
pub struct ProcessContext {
    frame_count: usize,
    input_channels: usize,
    output_channels: usize,
    inputs: *const *const f32,
    outputs: *const *mut f32,
}

impl ProcessContext {
    pub fn frame_count(&self) -> usize {
        self.frame_count
    }
    pub fn input_channels(&self) -> usize {
        self.input_channels
    }
    pub fn output_channels(&self) -> usize {
        self.output_channels
    }

    /// Input samples for `channel`, or `None` if the channel does not exist.
    pub fn input(&self, channel: usize) -> Option<&[f32]> {
        if channel >= self.input_channels || self.inputs.is_null() {
            return None;
        }
        // SAFETY: the host guarantees `input_channels` valid pointers to `frame_count` floats.
        unsafe {
            let ptr = *self.inputs.add(channel);
            if ptr.is_null() {
                None
            } else {
                Some(core::slice::from_raw_parts(ptr, self.frame_count))
            }
        }
    }

    /// Output samples for `channel`, or `None` if the channel does not exist.
    pub fn output(&mut self, channel: usize) -> Option<&mut [f32]> {
        if channel >= self.output_channels || self.outputs.is_null() {
            return None;
        }
        // SAFETY: as above; output buffers never alias input buffers.
        unsafe {
            let ptr = *self.outputs.add(channel);
            if ptr.is_null() {
                None
            } else {
                Some(core::slice::from_raw_parts_mut(ptr, self.frame_count))
            }
        }
    }

    /// Input and output for the same channel index, for the common in-place-style loop.
    pub fn io(&mut self, channel: usize) -> Option<(Option<&[f32]>, &mut [f32])> {
        if channel >= self.output_channels || self.outputs.is_null() {
            return None;
        }
        // SAFETY: input and output buffers are distinct host allocations.
        unsafe {
            let out_ptr = *self.outputs.add(channel);
            if out_ptr.is_null() {
                return None;
            }
            let output = core::slice::from_raw_parts_mut(out_ptr, self.frame_count);
            let input = if channel < self.input_channels && !self.inputs.is_null() {
                let in_ptr = *self.inputs.add(channel);
                if in_ptr.is_null() {
                    None
                } else {
                    Some(core::slice::from_raw_parts(in_ptr, self.frame_count))
                }
            } else {
                None
            };
            Some((input, output))
        }
    }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ParameterKind {
    Float,
    Integer,
    Boolean,
    Enum,
}

/// One row of the table `audiospan build` generates from plugin.json.
#[derive(Clone, Copy, Debug)]
pub struct ParameterSpec {
    pub id: &'static str,
    pub kind: ParameterKind,
    pub min: f64,
    pub max: f64,
    pub default: f64,
    /// 0 = none.
    pub step: f64,
}

/// Per-sample one-pole smoother: call `set_target` when a parameter changes
/// and `next` once per sample. `snap` jumps to the target without a ramp.
pub struct Smoothed {
    current: f64,
    target: f64,
    coef: f64,
}

impl Default for Smoothed {
    fn default() -> Self {
        Self::new(0.0)
    }
}

impl Smoothed {
    pub fn new(value: f64) -> Self {
        Self { current: value, target: value, coef: 0.0 }
    }
    /// Time constant in seconds (0 disables smoothing).
    pub fn set_time(&mut self, seconds: f64, sample_rate: f64) {
        self.coef = if seconds > 0.0 && sample_rate > 0.0 { (-1.0 / (seconds * sample_rate)).exp() } else { 0.0 };
    }
    pub fn set_target(&mut self, value: f64) {
        self.target = value;
    }
    pub fn snap(&mut self) {
        self.current = self.target;
    }
    pub fn snap_to(&mut self, value: f64) {
        self.current = value;
        self.target = value;
    }
    pub fn target(&self) -> f64 {
        self.target
    }
    pub fn value(&self) -> f64 {
        self.current
    }
    pub fn is_smoothing(&self) -> bool {
        self.current != self.target
    }
    #[inline]
    pub fn next(&mut self) -> f64 {
        if self.current == self.target {
            return self.current;
        }
        self.current = self.target + (self.current - self.target) * self.coef;
        if (self.current - self.target).abs() <= 1e-9 * (1.0 + self.target.abs()) {
            self.current = self.target;
        }
        self.current
    }
}

/// A per-sample linear ramp across one block, from [`Parameters::ramp`].
pub struct Ramp {
    pub value: f64,
    pub step: f64,
}

impl Ramp {
    #[inline]
    pub fn next(&mut self) -> f64 {
        let v = self.value;
        self.value += self.step;
        v
    }
}

/// Storage for the parameters described by a [`ParameterSpec`] table. Clamps
/// on set, smooths float parameters at block rate (20 ms by default; integers,
/// booleans and enums switch instantly), applies values instantly before the
/// first block so presets and restored state do not fade in, and gives the
/// trait defaults everything they need for set/get, reset and state.
///
/// - `value(i)`: the value to use for the current block
/// - `changed(i)`: true when `value(i)` moved since the last block
/// - `ramp(i, frames)`: per-sample linear ramp across the block
/// - `target(i)`: the last value the host set
pub struct Parameters {
    specs: &'static [ParameterSpec],
    sample_rate: f64,
    targets: Vec<f64>,
    current: Vec<f64>,
    block_start: Vec<f64>,
    smoothing: Vec<f64>,
    started: bool,
    pending_snap: bool,
    all_changed: bool,
}

impl Parameters {
    const DEFAULT_SMOOTHING_SECONDS: f64 = 0.02;

    /// Allocates; call it from [`Effect::create`], never from `process`.
    pub fn new(specs: &'static [ParameterSpec], sample_rate: f64) -> Self {
        let defaults: Vec<f64> = specs.iter().map(|s| s.default).collect();
        Self {
            specs,
            sample_rate,
            targets: defaults.clone(),
            current: defaults.clone(),
            block_start: defaults,
            smoothing: specs.iter().map(|s| if s.kind == ParameterKind::Float { Self::DEFAULT_SMOOTHING_SECONDS } else { 0.0 }).collect(),
            started: false,
            pending_snap: false,
            all_changed: false,
        }
    }

    pub fn len(&self) -> usize {
        self.specs.len()
    }
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }
    pub fn spec(&self, index: u32) -> Option<&ParameterSpec> {
        self.specs.get(index as usize)
    }

    /// Smoothing time in seconds for one parameter (0 = instant).
    pub fn set_smoothing(&mut self, index: u32, seconds: f64) {
        if let Some(s) = self.smoothing.get_mut(index as usize) {
            *s = seconds.max(0.0);
        }
    }

    /// Host-side entry point (the trait default calls this).
    pub fn set(&mut self, index: u32, value: f64) -> bool {
        let i = index as usize;
        let Some(spec) = self.specs.get(i) else {
            return false;
        };
        if value.is_nan() {
            return false;
        }
        let mut v = value.clamp(spec.min, spec.max);
        match spec.kind {
            ParameterKind::Integer => v = v.round(),
            ParameterKind::Boolean => v = if v >= 0.5 { 1.0 } else { 0.0 },
            _ => {}
        }
        self.targets[i] = v;
        if !self.started || self.smoothing[i] <= 0.0 {
            self.current[i] = v;
        }
        true
    }

    pub fn get(&self, index: u32) -> Option<f64> {
        self.targets.get(index as usize).copied()
    }

    /// Called by the generated exports before every `process`; advances the smoothers by one block.
    pub fn begin_block(&mut self, frames: usize) {
        // On the first block, and on the first block after a snap, every parameter counts as changed so
        // coefficient tables get built from the values set before processing started.
        self.all_changed = !self.started || self.pending_snap;
        self.started = true;
        self.pending_snap = false;
        for i in 0..self.specs.len() {
            self.block_start[i] = self.current[i];
            if self.current[i] == self.targets[i] {
                continue;
            }
            if self.smoothing[i] <= 0.0 || self.sample_rate <= 0.0 {
                self.current[i] = self.targets[i];
                continue;
            }
            let coef = (-(frames as f64) / (self.smoothing[i] * self.sample_rate)).exp();
            let mut v = self.targets[i] + (self.current[i] - self.targets[i]) * coef;
            if (v - self.targets[i]).abs() <= 1e-6 * (1.0 + self.targets[i].abs()) {
                v = self.targets[i];
            }
            self.current[i] = v;
        }
    }

    pub fn value(&self, index: u32) -> f64 {
        self.current.get(index as usize).copied().unwrap_or(0.0)
    }
    pub fn target(&self, index: u32) -> f64 {
        self.targets.get(index as usize).copied().unwrap_or(0.0)
    }
    pub fn changed(&self, index: u32) -> bool {
        let i = index as usize;
        i < self.specs.len() && (self.all_changed || self.current[i] != self.block_start[i])
    }
    pub fn any_changed(&self) -> bool {
        self.all_changed || (0..self.specs.len()).any(|i| self.current[i] != self.block_start[i])
    }
    pub fn ramp(&self, index: u32, frames: usize) -> Ramp {
        let i = index as usize;
        let from = self.block_start.get(i).copied().unwrap_or(0.0);
        let to = self.current.get(i).copied().unwrap_or(0.0);
        Ramp { value: from, step: if frames > 0 { (to - from) / frames as f64 } else { 0.0 } }
    }

    /// Jump every parameter to its target (called on reset and after `read_state`).
    pub fn snap(&mut self) {
        for i in 0..self.specs.len() {
            self.current[i] = self.targets[i];
            self.block_start[i] = self.targets[i];
        }
        self.pending_snap = true;
    }
}

// ---------------------------------------------------------------------------
// The effect trait
// ---------------------------------------------------------------------------

/// Implement this for your DSP type.
pub trait Effect: Sized + 'static {
    /// Allocate and initialise. Return `None` on failure.
    fn create(config: &HostConfig) -> Option<Self>;
    /// Real-time: no allocation, no I/O. Write every output sample.
    fn process(&mut self, ctx: &mut ProcessContext);

    /// Expose a [`Parameters`] field and the defaults below implement set/get, reset and state.
    fn parameters(&self) -> Option<&Parameters> {
        None
    }
    fn parameters_mut(&mut self) -> Option<&mut Parameters> {
        None
    }

    /// Clear DSP history. Parameter values persist. Call `parameters.snap()` if you override this.
    fn reset(&mut self) {
        if let Some(p) = self.parameters_mut() {
            p.snap();
        }
    }
    /// Return `false` for an unknown index. Values arrive already finite.
    fn set_parameter(&mut self, index: u32, value: f64) -> bool {
        match self.parameters_mut() {
            Some(p) => p.set(index, value),
            None => false,
        }
    }
    fn get_parameter(&self, index: u32) -> Option<f64> {
        self.parameters().and_then(|p| p.get(index))
    }

    /// State defaults to every parameter value in a versioned blob; override all three for your own layout.
    fn state_size(&self) -> u32 {
        parameter_state_size(self)
    }
    /// Write state into `dest` (at least `state_size()` bytes). Return bytes written.
    fn write_state(&self, dest: &mut [u8]) -> Option<u32> {
        write_parameter_state(self, dest)
    }
    /// Return `false` if the bytes are not a valid state for this plugin.
    fn read_state(&mut self, src: &[u8]) -> bool {
        read_parameter_state(self, src)
    }

    /// Optional: current processing latency in frames. The host re-reads it
    /// after parameter and state changes and reports changes to the
    /// application. `None` (the default) means "use the manifest's
    /// `audio.latencyFrames`".
    fn latency_frames(&self) -> Option<u32> {
        None
    }

    /// Optional: read-only values for the manifest's `outputs` array (meters,
    /// gain reduction, readouts), polled by the host between process calls.
    /// Return `None` for an unknown index.
    fn get_output(&self, _index: u32) -> Option<f64> {
        None
    }
}

/// Default state layout: `{ magic "ASPS", version 1, count, reserved }` then `count` little-endian f64 values.
pub const PARAMETER_STATE_MAGIC: u32 = 0x5350_5341;
pub const PARAMETER_STATE_VERSION: u32 = 1;
const PARAMETER_STATE_HEADER: usize = 16;
const MAX_PROBED_PARAMETERS: u32 = 512;

pub fn parameter_count<E: Effect>(effect: &E) -> u32 {
    if let Some(p) = effect.parameters() {
        return p.len() as u32;
    }
    let mut n = 0;
    while n < MAX_PROBED_PARAMETERS && effect.get_parameter(n).is_some() {
        n += 1;
    }
    n
}

pub fn parameter_state_size<E: Effect>(effect: &E) -> u32 {
    PARAMETER_STATE_HEADER as u32 + 8 * parameter_count(effect)
}

pub fn write_parameter_state<E: Effect>(effect: &E, dest: &mut [u8]) -> Option<u32> {
    let count = parameter_count(effect);
    let size = PARAMETER_STATE_HEADER + 8 * count as usize;
    if dest.len() < size {
        return None;
    }
    dest[0..4].copy_from_slice(&PARAMETER_STATE_MAGIC.to_le_bytes());
    dest[4..8].copy_from_slice(&PARAMETER_STATE_VERSION.to_le_bytes());
    dest[8..12].copy_from_slice(&count.to_le_bytes());
    dest[12..16].copy_from_slice(&0u32.to_le_bytes());
    for i in 0..count {
        let value = effect.get_parameter(i).unwrap_or(0.0);
        let offset = PARAMETER_STATE_HEADER + 8 * i as usize;
        dest[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    Some(size as u32)
}

pub fn read_parameter_state<E: Effect>(effect: &mut E, src: &[u8]) -> bool {
    if src.len() < PARAMETER_STATE_HEADER {
        return false;
    }
    let u32_at = |offset: usize| u32::from_le_bytes([src[offset], src[offset + 1], src[offset + 2], src[offset + 3]]);
    let count = parameter_count(effect);
    if u32_at(0) != PARAMETER_STATE_MAGIC || u32_at(4) != PARAMETER_STATE_VERSION || u32_at(8) != count || src.len() != PARAMETER_STATE_HEADER + 8 * count as usize {
        return false;
    }
    let value_at = |i: u32| {
        let offset = PARAMETER_STATE_HEADER + 8 * i as usize;
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&src[offset..offset + 8]);
        f64::from_le_bytes(bytes)
    };
    if (0..count).any(|i| !value_at(i).is_finite()) {
        return false;
    }
    for i in 0..count {
        if !effect.set_parameter(i, value_at(i)) {
            return false;
        }
    }
    if let Some(p) = effect.parameters_mut() {
        p.snap();
    }
    true
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

#[cfg(feature = "audiospan-log")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn audiospan_log(level: u32, message: *const u8, length: u32);
}

/// Development-build logging: reaches the host console when the crate is
/// built with the `audiospan-log` feature (`audiospan build --dev`) and the
/// host has plugin logging enabled. A no-op otherwise, so release modules
/// import nothing extra. Avoid calling it from `process`.
#[inline]
pub fn log(level: u32, message: &str) {
    #[cfg(feature = "audiospan-log")]
    // SAFETY: the host reads exactly `length` bytes from `message` during the call.
    unsafe {
        audiospan_log(level, message.as_ptr(), message.len() as u32);
    }
    #[cfg(not(feature = "audiospan-log"))]
    {
        let _ = (level, message);
    }
}

// ---------------------------------------------------------------------------
// Allocation, instance table, exports
// ---------------------------------------------------------------------------

const ALLOC_HEADER: usize = 16;

/// Host-side scratch allocation. Stores (size, align) in a header so free()
/// can rebuild the layout.
pub unsafe fn alloc_impl(size: u32, align: u32) -> *mut u8 {
    let align = (align.max(1) as usize).max(ALLOC_HEADER);
    if !align.is_power_of_two() {
        return core::ptr::null_mut();
    }
    let size = size.max(1) as usize;
    let total = match size.checked_add(align) {
        Some(t) => t,
        None => return core::ptr::null_mut(),
    };
    let layout = match Layout::from_size_align(total, align) {
        Ok(l) => l,
        Err(_) => return core::ptr::null_mut(),
    };
    let base = std::alloc::alloc(layout);
    if base.is_null() {
        return base;
    }
    let ptr = base.add(align);
    let header = ptr.sub(ALLOC_HEADER) as *mut u64;
    header.write_unaligned(total as u64);
    header.add(1).write_unaligned(align as u64);
    ptr
}

pub unsafe fn free_impl(ptr: *mut u8) {
    if ptr.is_null() {
        return;
    }
    let header = ptr.sub(ALLOC_HEADER) as *const u64;
    let total = header.read_unaligned() as usize;
    let align = header.add(1).read_unaligned() as usize;
    if let Ok(layout) = Layout::from_size_align(total, align) {
        std::alloc::dealloc(ptr.sub(align), layout);
    }
}

/// Fixed-capacity instance table. Handles are 1-based slot indices.
pub struct InstanceTable<E: Effect, const N: usize> {
    slots: [Option<Box<E>>; N],
}

impl<E: Effect, const N: usize> InstanceTable<E, N> {
    pub const fn new() -> Self {
        Self { slots: [const { None }; N] }
    }

    pub fn get(&mut self, handle: AsInstance) -> Option<&mut E> {
        if handle == 0 || handle as usize > N {
            return None;
        }
        self.slots[handle as usize - 1].as_deref_mut()
    }

    pub fn create(&mut self, config: &HostConfig) -> Result<AsInstance, AsStatus> {
        for (i, slot) in self.slots.iter_mut().enumerate() {
            if slot.is_some() {
                continue;
            }
            let effect = E::create(config).ok_or(AS_ERROR_OUT_OF_MEMORY)?;
            *slot = Some(Box::new(effect));
            return Ok(i as AsInstance + 1);
        }
        Err(AS_ERROR_OUT_OF_MEMORY)
    }

    pub fn destroy(&mut self, handle: AsInstance) -> AsStatus {
        if handle == 0 || handle as usize > N {
            return AS_ERROR_INVALID_ARGUMENT;
        }
        match self.slots[handle as usize - 1].take() {
            Some(_) => AS_OK,
            None => AS_ERROR_INVALID_ARGUMENT,
        }
    }
}

/// Run `f`, converting a panic into `AS_ERROR_GENERIC`.
pub fn guarded(f: impl FnOnce() -> AsStatus) -> AsStatus {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(status) => status,
        Err(_) => AS_ERROR_GENERIC,
    }
}

/// Generates the ABI exports for `$effect` with up to `$max` live instances.
#[macro_export]
macro_rules! audiospan_define_effect {
    ($effect:ty, $max:expr) => {
        mod __audiospan_exports {
            use super::*;
            use $crate::abi::*;

            static mut TABLE: InstanceTable<$effect, $max> = InstanceTable::new();

            // SAFETY: the host calls every export from a single thread and never re-enters.
            #[inline(always)]
            fn table() -> &'static mut InstanceTable<$effect, $max> {
                unsafe { &mut *core::ptr::addr_of_mut!(TABLE) }
            }

            #[no_mangle]
            pub extern "C" fn audiospan_get_abi_version() -> u32 {
                AUDIOSPAN_ABI_VERSION
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_alloc(size: u32, align: u32) -> *mut u8 {
                alloc_impl(size, align)
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_free(ptr: *mut u8) {
                free_impl(ptr)
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_create(config: *const AsHostConfig, out_instance: *mut AsInstance) -> AsStatus {
                guarded(|| {
                    if config.is_null() || out_instance.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let raw = &*config;
                    if (raw.struct_size as usize) < core::mem::size_of::<AsHostConfig>() || raw.sample_rate == 0 || raw.max_frames == 0 {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let hc = HostConfig {
                        sample_rate: raw.sample_rate,
                        max_frames: raw.max_frames,
                        max_input_channels: raw.max_input_channels,
                        max_output_channels: raw.max_output_channels,
                    };
                    match table().create(&hc) {
                        Ok(handle) => {
                            *out_instance = handle;
                            AS_OK
                        }
                        Err(status) => status,
                    }
                })
            }

            #[no_mangle]
            pub extern "C" fn audiospan_destroy(instance: AsInstance) -> AsStatus {
                guarded(|| table().destroy(instance))
            }

            #[no_mangle]
            pub extern "C" fn audiospan_reset(instance: AsInstance) -> AsStatus {
                guarded(|| match table().get(instance) {
                    Some(effect) => {
                        effect.reset();
                        AS_OK
                    }
                    None => AS_ERROR_INVALID_ARGUMENT,
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_process(instance: AsInstance, process: *const AsProcess) -> AsStatus {
                guarded(|| {
                    let effect = match table().get(instance) {
                        Some(e) => e,
                        None => return AS_ERROR_INVALID_ARGUMENT,
                    };
                    if process.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let raw = &*process;
                    if (raw.struct_size as usize) < core::mem::size_of::<AsProcess>() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    if raw.frame_count == 0 {
                        return AS_OK;
                    }
                    if (raw.output_channels > 0 && raw.outputs.is_null()) || (raw.input_channels > 0 && raw.inputs.is_null()) {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let mut ctx = ProcessContext {
                        frame_count: raw.frame_count as usize,
                        input_channels: raw.input_channels as usize,
                        output_channels: raw.output_channels as usize,
                        inputs: raw.inputs,
                        outputs: raw.outputs,
                    };
                    if let Some(params) = effect.parameters_mut() {
                        params.begin_block(raw.frame_count as usize);
                    }
                    effect.process(&mut ctx);
                    AS_OK
                })
            }

            #[no_mangle]
            pub extern "C" fn audiospan_set_parameter(instance: AsInstance, index: u32, value: f64) -> AsStatus {
                guarded(|| {
                    if value.is_nan() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    match table().get(instance) {
                        Some(effect) => {
                            if effect.set_parameter(index, value) {
                                AS_OK
                            } else {
                                AS_ERROR_INVALID_ARGUMENT
                            }
                        }
                        None => AS_ERROR_INVALID_ARGUMENT,
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_get_parameter(instance: AsInstance, index: u32, out_value: *mut f64) -> AsStatus {
                guarded(|| {
                    if out_value.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    match table().get(instance).and_then(|e| e.get_parameter(index)) {
                        Some(v) => {
                            *out_value = v;
                            AS_OK
                        }
                        None => AS_ERROR_INVALID_ARGUMENT,
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_get_state_size(instance: AsInstance, out_size: *mut u32) -> AsStatus {
                guarded(|| {
                    if out_size.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    match table().get(instance) {
                        Some(effect) => {
                            *out_size = effect.state_size();
                            AS_OK
                        }
                        None => AS_ERROR_INVALID_ARGUMENT,
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_get_state(instance: AsInstance, destination: *mut u8, capacity: u32, out_written: *mut u32) -> AsStatus {
                guarded(|| {
                    if out_written.is_null() || (capacity > 0 && destination.is_null()) {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let effect = match table().get(instance) {
                        Some(e) => e,
                        None => return AS_ERROR_INVALID_ARGUMENT,
                    };
                    if capacity < effect.state_size() {
                        *out_written = 0;
                        return AS_ERROR_BUFFER_TOO_SMALL;
                    }
                    let mut empty: [u8; 0] = [];
                    let dest: &mut [u8] = if capacity == 0 { &mut empty } else { core::slice::from_raw_parts_mut(destination, capacity as usize) };
                    match effect.write_state(dest) {
                        Some(written) => {
                            *out_written = written;
                            AS_OK
                        }
                        None => AS_ERROR_BUFFER_TOO_SMALL,
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_set_state(instance: AsInstance, source: *const u8, size: u32) -> AsStatus {
                guarded(|| {
                    if size > 0 && source.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    let effect = match table().get(instance) {
                        Some(e) => e,
                        None => return AS_ERROR_INVALID_ARGUMENT,
                    };
                    let src: &[u8] = if size == 0 { &[] } else { core::slice::from_raw_parts(source, size as usize) };
                    if effect.read_state(src) {
                        AS_OK
                    } else {
                        AS_ERROR_INVALID_FORMAT
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_get_latency(instance: AsInstance, out_frames: *mut u32) -> AsStatus {
                guarded(|| {
                    if out_frames.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    match table().get(instance) {
                        Some(effect) => match effect.latency_frames() {
                            Some(frames) => {
                                *out_frames = frames;
                                AS_OK
                            }
                            None => AS_ERROR_UNSUPPORTED,
                        },
                        None => AS_ERROR_INVALID_ARGUMENT,
                    }
                })
            }

            #[no_mangle]
            pub unsafe extern "C" fn audiospan_get_output(instance: AsInstance, index: u32, out_value: *mut f64) -> AsStatus {
                guarded(|| {
                    if out_value.is_null() {
                        return AS_ERROR_INVALID_ARGUMENT;
                    }
                    match table().get(instance) {
                        Some(effect) => match effect.get_output(index) {
                            Some(value) => {
                                *out_value = value;
                                AS_OK
                            }
                            None => AS_ERROR_INVALID_ARGUMENT,
                        },
                        None => AS_ERROR_INVALID_ARGUMENT,
                    }
                })
            }
        }
    };
}
