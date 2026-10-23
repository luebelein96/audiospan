/*
 * Audiospan C ABI, version 1.
 *
 * This header is the normative contract between the Audiospan host runtime
 * and a plugin compiled to WebAssembly. It compiles as C and C++ and is
 * mirrored exactly by the Rust bindings in the Rust starter template.
 *
 * Rules (see docs/abi.md for the full text):
 *   - Every export returns AS_OK or a defined error code. Never trap or throw
 *     across this boundary on purpose.
 *   - The host owns all process buffers and the process descriptor. The plugin
 *     must not retain any pointer after the call returns.
 *   - The plugin owns its instance state. audiospan_destroy releases it.
 *   - State buffers are caller-provided; there is no ownership transfer.
 *   - All calls are made from one thread. The runtime never calls two exports
 *     concurrently. set_parameter is called from the audio thread between
 *     process calls, so plugins need no internal synchronisation.
 *   - Pointers are 32-bit offsets into the module's linear memory (wasm32).
 */
#ifndef AUDIOSPAN_ABI_H
#define AUDIOSPAN_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AUDIOSPAN_ABI_VERSION 1u

/* Marks a function as a WebAssembly export when compiling for wasm. */
#if defined(__wasm__)
#define AUDIOSPAN_EXPORT(name) __attribute__((export_name(#name), used, visibility("default")))
#else
#define AUDIOSPAN_EXPORT(name)
#endif

typedef uint32_t as_status_t;
typedef uint32_t as_instance_t;

enum {
  AS_OK = 0,
  AS_ERROR_GENERIC = 1,
  AS_ERROR_INVALID_ARGUMENT = 2,
  AS_ERROR_UNSUPPORTED = 3,
  AS_ERROR_OUT_OF_MEMORY = 4,
  AS_ERROR_BAD_STATE = 5,
  AS_ERROR_BUFFER_TOO_SMALL = 6,
  AS_ERROR_INVALID_FORMAT = 7
};

/*
 * Host configuration passed to audiospan_create.
 * struct_size allows compatible extension: a plugin must reject a struct that
 * is smaller than the fields it needs (AS_ERROR_INVALID_ARGUMENT) and must
 * ignore trailing fields it does not know about.
 */
typedef struct as_host_config {
  uint32_t struct_size;
  uint32_t sample_rate;
  uint32_t max_frames;
  uint32_t max_input_channels;
  uint32_t max_output_channels;
} as_host_config;

/*
 * Process descriptor. inputs/outputs are tables of planar channel buffers,
 * each holding frame_count 32-bit floats. Only the first input_channels /
 * output_channels entries are valid. The plugin must write every sample of
 * every output channel.
 */
typedef struct as_process {
  uint32_t struct_size;
  uint32_t frame_count;
  uint32_t input_channels;
  uint32_t output_channels;
  const float* const* inputs;
  float* const* outputs;
} as_process;

/* ------------------------------------------------------------------------ */
/* Required exports. A module missing any of these is rejected by the host. */
/* ------------------------------------------------------------------------ */

/* Returns AUDIOSPAN_ABI_VERSION. The host rejects any other value. */
uint32_t audiospan_get_abi_version(void);

/*
 * Host-side scratch allocation inside the module's linear memory. The host
 * uses this on the control plane to reserve the process descriptor, channel
 * pointer tables, sample buffers, and state staging buffers. Never called
 * from the audio callback. Returns 0 on failure. alignment is a power of two.
 */
void* audiospan_alloc(uint32_t size, uint32_t alignment);
void audiospan_free(void* ptr);

as_status_t audiospan_create(
  const as_host_config* config,
  as_instance_t* out_instance
);

as_status_t audiospan_destroy(as_instance_t instance);

/* Clears DSP history (delay lines, filters) but keeps parameter values. */
as_status_t audiospan_reset(as_instance_t instance);

as_status_t audiospan_process(
  as_instance_t instance,
  const as_process* process
);

/* Parameter values use indices equal to the manifest's parameter array order. */
as_status_t audiospan_set_parameter(
  as_instance_t instance,
  uint32_t parameter_index,
  double value
);

as_status_t audiospan_get_parameter(
  as_instance_t instance,
  uint32_t parameter_index,
  double* out_value
);

/* State is copied into/out of caller-provided memory. No ownership transfer. */
as_status_t audiospan_get_state_size(
  as_instance_t instance,
  uint32_t* out_size
);

as_status_t audiospan_get_state(
  as_instance_t instance,
  uint8_t* destination,
  uint32_t destination_capacity,
  uint32_t* out_written
);

as_status_t audiospan_set_state(
  as_instance_t instance,
  const uint8_t* source,
  uint32_t source_size
);

/* ------------------------------------------------------------------------ */
/* Optional exports. The host checks for their presence at load time; a     */
/* module may omit any of them. Hosts also treat AS_ERROR_UNSUPPORTED from  */
/* these as "not provided", so a helper may export them unconditionally.    */
/* ------------------------------------------------------------------------ */

/*
 * Current processing latency in frames. The host reads it after create and
 * after every set_parameter, set_state and reset, and reports changes to the
 * application. When absent, or when it returns AS_ERROR_UNSUPPORTED, the
 * manifest's static audio.latencyFrames applies.
 */
as_status_t audiospan_get_latency(
  as_instance_t instance,
  uint32_t* out_frames
);

/*
 * Read-only values the plugin computes for display: meters, gain reduction,
 * tuner readouts. Indices follow the manifest's `outputs` array. The host
 * polls them from the audio thread between process calls at a bounded rate
 * (30 Hz by default). Required when the manifest declares outputs. Unknown
 * index → AS_ERROR_INVALID_ARGUMENT; a module without outputs may return
 * AS_ERROR_UNSUPPORTED instead.
 */
as_status_t audiospan_get_output(
  as_instance_t instance,
  uint32_t output_index,
  double* out_value
);

/*
 * `_initialize` (WASI reactor convention, emitted by Emscripten standalone
 * builds). If present the host calls it exactly once after instantiation,
 * before any other export.
 */

/* ------------------------------------------------------------------------ */
/* Optional import, development builds only.                                */
/* ------------------------------------------------------------------------ */

enum {
  AS_LOG_ERROR = 0,
  AS_LOG_WARN = 1,
  AS_LOG_INFO = 2,
  AS_LOG_DEBUG = 3
};

/*
 * env.audiospan_log: writes a UTF-8 message (not NUL-terminated; `length`
 * bytes) to the host's log. Declared only when AUDIOSPAN_ENABLE_LOG is
 * defined (`audiospan build --dev`), so release builds import nothing. A host
 * provides the import only with plugin logging enabled; otherwise the module
 * is rejected at load with MODULE_IMPORT_UNSUPPORTED. The host rate limits
 * messages and truncates them to 1024 bytes. Avoid calling it from process().
 */
#if defined(AUDIOSPAN_ENABLE_LOG)
#if defined(__wasm__)
__attribute__((import_module("env"), import_name("audiospan_log")))
#endif
void audiospan_log(uint32_t level, const char* message, uint32_t length);
#endif

#ifdef __cplusplus
}
#endif

#endif /* AUDIOSPAN_ABI_H */
