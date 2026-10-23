/**
 * Constants mirroring abi/include/audiospan/abi.h. The C header is the
 * source of truth; tests/abi/header-sync.test.ts checks these stay aligned.
 */
export const ABI_VERSION = 1;
export const ABI_IDENTIFIER = "audiospan-c";

export const AS_OK = 0;
export const AS_ERROR_GENERIC = 1;
export const AS_ERROR_INVALID_ARGUMENT = 2;
export const AS_ERROR_UNSUPPORTED = 3;
export const AS_ERROR_OUT_OF_MEMORY = 4;
export const AS_ERROR_BAD_STATE = 5;
export const AS_ERROR_BUFFER_TOO_SMALL = 6;
export const AS_ERROR_INVALID_FORMAT = 7;

const STATUS_NAMES: Record<number, string> = {
  0: "AS_OK",
  1: "AS_ERROR_GENERIC",
  2: "AS_ERROR_INVALID_ARGUMENT",
  3: "AS_ERROR_UNSUPPORTED",
  4: "AS_ERROR_OUT_OF_MEMORY",
  5: "AS_ERROR_BAD_STATE",
  6: "AS_ERROR_BUFFER_TOO_SMALL",
  7: "AS_ERROR_INVALID_FORMAT",
};

export function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `AS_UNKNOWN_STATUS_${status}`;
}

export const EXPORT_ABI_VERSION = "audiospan_get_abi_version";
export const EXPORT_ALLOC = "audiospan_alloc";
export const EXPORT_FREE = "audiospan_free";
export const EXPORT_CREATE = "audiospan_create";
export const EXPORT_DESTROY = "audiospan_destroy";
export const EXPORT_RESET = "audiospan_reset";
export const EXPORT_PROCESS = "audiospan_process";
export const EXPORT_SET_PARAMETER = "audiospan_set_parameter";
export const EXPORT_GET_PARAMETER = "audiospan_get_parameter";
export const EXPORT_GET_STATE_SIZE = "audiospan_get_state_size";
export const EXPORT_GET_STATE = "audiospan_get_state";
export const EXPORT_SET_STATE = "audiospan_set_state";
export const EXPORT_MEMORY = "memory";
export const EXPORT_INITIALIZE = "_initialize";

/* Optional exports (see abi.h). A module may omit them; AS_ERROR_UNSUPPORTED from them means the same. */
export const EXPORT_GET_LATENCY = "audiospan_get_latency";
export const EXPORT_GET_OUTPUT = "audiospan_get_output";
export const OPTIONAL_FUNCTION_EXPORTS: readonly string[] = Object.freeze([EXPORT_GET_LATENCY, EXPORT_GET_OUTPUT]);

/**
 * Development-only import `env.audiospan_log(level, ptr, length)`. A module
 * that imports it is rejected unless the host enables plugin logging.
 */
export const IMPORT_LOG_MODULE = "env";
export const IMPORT_LOG = "audiospan_log";
export const AS_LOG_ERROR = 0;
export const AS_LOG_WARN = 1;
export const AS_LOG_INFO = 2;
export const AS_LOG_DEBUG = 3;
/** Longest log message the host reads from plugin memory, in bytes. */
export const MAX_LOG_MESSAGE_BYTES = 1024;

export const REQUIRED_FUNCTION_EXPORTS: readonly string[] = Object.freeze([
  EXPORT_ABI_VERSION,
  EXPORT_ALLOC,
  EXPORT_FREE,
  EXPORT_CREATE,
  EXPORT_DESTROY,
  EXPORT_RESET,
  EXPORT_PROCESS,
  EXPORT_SET_PARAMETER,
  EXPORT_GET_PARAMETER,
  EXPORT_GET_STATE_SIZE,
  EXPORT_GET_STATE,
  EXPORT_SET_STATE,
]);

/**
 * Imports the runtime is willing to satisfy. Everything else is rejected so
 * a plugin can never reach host functionality it was not granted.
 *  - env.memory: the host provides the memory and enforces the maximum.
 *  - env.emscripten_notify_memory_growth: benign growth callback.
 *  - wasi_snapshot_preview1.*: stubbed to return ENOSYS; proc_exit traps.
 * `env.audiospan_log` (IMPORT_LOG) is granted separately, only when the host
 * enables plugin logging.
 */
export const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  env: ["memory", "emscripten_notify_memory_growth"],
  wasi_snapshot_preview1: [
    "proc_exit",
    "fd_write",
    "fd_read",
    "fd_close",
    "fd_seek",
    "fd_fdstat_get",
    "environ_sizes_get",
    "environ_get",
    "args_sizes_get",
    "args_get",
    "clock_time_get",
    "random_get",
  ],
});

/** wasm32 struct layouts (bytes). */
export const HOST_CONFIG_STRUCT_SIZE = 20;
export const HOST_CONFIG_OFFSET_STRUCT_SIZE = 0;
export const HOST_CONFIG_OFFSET_SAMPLE_RATE = 4;
export const HOST_CONFIG_OFFSET_MAX_FRAMES = 8;
export const HOST_CONFIG_OFFSET_MAX_INPUT_CHANNELS = 12;
export const HOST_CONFIG_OFFSET_MAX_OUTPUT_CHANNELS = 16;

export const PROCESS_STRUCT_SIZE = 24;
export const PROCESS_OFFSET_STRUCT_SIZE = 0;
export const PROCESS_OFFSET_FRAME_COUNT = 4;
export const PROCESS_OFFSET_INPUT_CHANNELS = 8;
export const PROCESS_OFFSET_OUTPUT_CHANNELS = 12;
export const PROCESS_OFFSET_INPUTS = 16;
export const PROCESS_OFFSET_OUTPUTS = 20;

export const WASM_PAGE_BYTES = 65536;
