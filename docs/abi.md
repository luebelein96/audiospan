# Audiospan C ABI

Normative header: [`abi/include/audiospan/abi.h`](../abi/include/audiospan/abi.h). Manifest identifier: `"audiospan-c"`. Version constant: `AUDIOSPAN_ABI_VERSION = 1`. The Rust bindings in `abi/rust/abi.rs` and the TypeScript constants in `packages/runtime/src/abi.ts` mirror the header; `tests/abi/header-sync.test.ts` checks them and that every vendored copy (templates, reference plugins) is identical.

## Model

The host instantiates the WebAssembly module (one instance per plugin instance) and calls named exports. The module owns its instance state and returns integer handles. All memory the host needs inside the module (host config, process descriptor, channel pointer tables, sample buffers, state staging) is obtained through `audiospan_alloc` on the control plane and reused for the lifetime of the instance.

Every export is called from a single thread, never re-entrantly, never concurrently. In the browser that thread is the audio rendering thread; `set_parameter`, `reset`, `get_state`, `set_state` run between render quanta, `process` inside them.

## Types

```c
typedef uint32_t as_status_t;
typedef uint32_t as_instance_t;      /* 0 is never a valid handle */

enum { AS_OK = 0, AS_ERROR_GENERIC = 1, AS_ERROR_INVALID_ARGUMENT = 2, AS_ERROR_UNSUPPORTED = 3,
       AS_ERROR_OUT_OF_MEMORY = 4, AS_ERROR_BAD_STATE = 5, AS_ERROR_BUFFER_TOO_SMALL = 6, AS_ERROR_INVALID_FORMAT = 7 };

typedef struct as_host_config {   /* 20 bytes on wasm32 */
  uint32_t struct_size;              /* = sizeof(as_host_config) or larger */
  uint32_t sample_rate;
  uint32_t max_frames;               /* largest frame_count process() will ever receive */
  uint32_t max_input_channels;
  uint32_t max_output_channels;
} as_host_config;

typedef struct as_process {       /* 24 bytes on wasm32 */
  uint32_t struct_size;
  uint32_t frame_count;
  uint32_t input_channels;
  uint32_t output_channels;
  const float* const* inputs;        /* planar: inputs[ch][frame] */
  float* const* outputs;             /* planar: outputs[ch][frame] */
} as_process;
```

`struct_size` negotiation: a plugin must return `AS_ERROR_INVALID_ARGUMENT` when `struct_size` is smaller than the struct it knows, and must accept (ignoring trailing fields) a larger one. Future versions add fields at the end.

## Required exports

| Export | Contract |
| --- | --- |
| `uint32_t audiospan_get_abi_version(void)` | Returns 1. Any other value is rejected (`ABI_VERSION_MISMATCH`). |
| `void* audiospan_alloc(uint32_t size, uint32_t alignment)` | Returns memory inside linear memory aligned to `alignment` (a power of two), or 0. Control plane only. The host checks alignment and bounds. |
| `void audiospan_free(void* ptr)` | Releases memory from `alloc`. |
| `as_status_t audiospan_create(const as_host_config*, as_instance_t* out)` | Allocates an instance. Validates `struct_size`, non-zero `sample_rate` and `max_frames`. Writes a non-zero handle on success. `AS_ERROR_OUT_OF_MEMORY` when the table is full. |
| `as_status_t audiospan_destroy(as_instance_t)` | Frees the instance. Invalid or already-destroyed handles return `AS_ERROR_INVALID_ARGUMENT`. |
| `as_status_t audiospan_reset(as_instance_t)` | Clears DSP history; parameter values persist. |
| `as_status_t audiospan_process(as_instance_t, const as_process*)` | Processes exactly `frame_count` frames. `frame_count == 0` is a no-op returning `AS_OK`. Null tables with non-zero channel counts, bad handle, null or undersized descriptor → `AS_ERROR_INVALID_ARGUMENT`. Must write every output sample. |
| `as_status_t audiospan_set_parameter(as_instance_t, uint32_t index, double value)` | `index` is the manifest parameter position. Unknown index or NaN → `AS_ERROR_INVALID_ARGUMENT`. Values may be clamped by the plugin. |
| `as_status_t audiospan_get_parameter(as_instance_t, uint32_t index, double* out)` | Current value. |
| `as_status_t audiospan_get_state_size(as_instance_t, uint32_t* out_size)` | Exact byte count the next `get_state` needs. |
| `as_status_t audiospan_get_state(as_instance_t, uint8_t* dst, uint32_t capacity, uint32_t* out_written)` | Copies state into the caller's buffer. `capacity < size` → `AS_ERROR_BUFFER_TOO_SMALL` with `*out_written = 0`. Larger capacity is fine. |
| `as_status_t audiospan_set_state(as_instance_t, const uint8_t* src, uint32_t size)` | Validates then applies. Invalid bytes → `AS_ERROR_INVALID_FORMAT`, leaving the instance unchanged. |

## Optional exports

A module may omit any of these; the host checks for them at load. `AS_ERROR_UNSUPPORTED` from one of them means the same as its absence, so a helper may export them unconditionally (the C++ and Rust helpers do, and answer `AS_ERROR_UNSUPPORTED` when the effect does not implement the method).

| Export | Contract |
| --- | --- |
| `as_status_t audiospan_get_latency(as_instance_t, uint32_t* out_frames)` | Current processing latency. The host reads it after `create` and after every `set_parameter`, `set_state` and `reset`, and reports a change to the application (`LATENCY_CHANGED`, the SDK's `latencychange` event). Absent or unsupported, the manifest's `audio.latencyFrames` applies. The runtime does not compensate latency. |
| `as_status_t audiospan_get_output(as_instance_t, uint32_t output_index, double* out_value)` | Read-only values the plugin computes: meters, gain reduction, readouts. Indices follow the manifest's `outputs` array. Required when the manifest declares outputs (`MODULE_EXPORT_MISSING` otherwise). Polled from the audio thread between process calls, `outputsPerSecond` times per second (30 by default); one failing call stops polling for that instance until `reset` or `set_state`. Unknown index → `AS_ERROR_INVALID_ARGUMENT`. |
| `_initialize` | WASI reactor convention, emitted by Emscripten standalone builds. If present the host calls it once after instantiation before anything else. |

The module must either export its linear memory as `memory` with a declared maximum, or import `env.memory`, in which case the host creates the memory with `maximum = min(declared, policy)`. Shared memories are rejected.

## Imports the host provides

- `env.memory` (optional, see above)
- `env.emscripten_notify_memory_growth(index)`: sets a growth flag the runtime checks after `process`
- `wasi_snapshot_preview1.{fd_write, fd_read, fd_close, fd_seek, fd_fdstat_get, environ_sizes_get, environ_get, args_sizes_get, args_get, clock_time_get, random_get}`: return `ENOSYS` (52); `proc_exit` traps
- `env.audiospan_log(uint32_t level, const char* message, uint32_t length)`: **development builds only.** Declared in the header when `AUDIOSPAN_ENABLE_LOG` is defined (`audiospan build --dev`; the Rust template's `audiospan-log` feature). Levels: `AS_LOG_ERROR` 0, `AS_LOG_WARN` 1, `AS_LOG_INFO` 2, `AS_LOG_DEBUG` 3. The host grants it only with `pluginLogging: true`; otherwise a module that imports it is rejected with `MODULE_IMPORT_UNSUPPORTED`. The runtime copies at most 1024 bytes out of plugin memory and posts them raw; the SDK decodes them on the main thread (lenient UTF-8). Lines are rate limited with their own token bucket (`diagnosticsPerSecond`), and a throwing listener never traps the plugin.

Any other import is rejected at load (`MODULE_IMPORT_UNSUPPORTED`). A plugin therefore has no path to the network, filesystem, DOM, or host objects.

## Helper conventions (not part of the ABI)

The C++ and Rust helpers export every optional function unconditionally and answer `AS_ERROR_UNSUPPORTED` where the effect provides nothing. When an effect defines no state methods, they serialise its parameter values as `{ uint32 magic 0x53505341 ("ASPS"), uint32 version 1, uint32 count, uint32 reserved }` followed by `count` little-endian doubles, and reject on restore anything with a different header, count or size, or a non-finite value. Hosts treat the bytes as opaque either way.

## Ownership and lifetime

- The host owns `as_host_config`, `as_process`, both pointer tables and all sample buffers. They are valid only for the duration of the call. Plugins must not retain them.
- The plugin owns its instance; `destroy` releases it. Plugins never free host allocations and the host never frees plugin-internal memory.
- State buffers are caller-provided. There is no ownership transfer across the ABI.
- Pointers are 32-bit offsets into linear memory (wasm32). The runtime treats growth during `process` as an error for that block (the output is still copied, the block is marked failed, and views are refreshed).

## Error handling

Every export returns a status. No exception, panic, or trap may be used deliberately. If a trap does occur (out-of-bounds, `unreachable`, `proc_exit`, stack overflow), the runtime catches the JavaScript exception, treats the block as a processing failure (input is passed through), counts consecutive failures, and bypasses the instance after `processErrorBypassThreshold` (3) until `reset` or `set_state`.

## Memory bridge (how the host calls `process`)

Per instance at creation: `alloc` the config (20 B), process descriptor (24 B), an 8-byte scratch slot, two pointer tables (`channels × 4 B`), and `2 × channels` sample buffers of `max_frames × 4 B` (16-byte aligned). The tables are filled with the buffer offsets once. Per block: copy each input channel into its buffer (`Float32Array.set`), write `frame_count` and channel counts into the descriptor, call `process`, copy each output buffer out. Typed-array views over module memory are cached and recreated only when `memory.buffer` changes (growth) or the frame count changes; the steady state performs no allocation (there is a test asserting zero `Float32Array` constructions over 100 blocks).

## Conformance

`tests/abi/conformance.test.ts` runs against every built plugin under `plugins/*/dist`: required exports and bounded memory; ABI version; undersized/oversized struct negotiation; invalid handles, indices, NaN, null tables; `AS_ERROR_BUFFER_TOO_SMALL` and `AS_ERROR_INVALID_FORMAT`; the optional latency and output exports against the manifest; 100 create/destroy cycles and 8 concurrent instances; generic runtime checks; shared gain vectors; determinism and no buffer retention; identical samples from the C++ and Rust implementations. `audiospan test` runs the generic subset plus your vectors on any project.
