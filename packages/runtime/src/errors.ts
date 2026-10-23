export type RuntimeErrorCode =
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "PROTOCOL_MESSAGE_INVALID"
  | "PROTOCOL_CLONE_FAILED"
  | "RUNTIME_NOT_INITIALIZED"
  | "RUNTIME_ALREADY_INITIALIZED"
  | "RUNTIME_DISPOSED"
  | "MODULE_INVALID"
  | "MODULE_IMPORT_UNSUPPORTED"
  | "MODULE_EXPORT_MISSING"
  | "MODULE_MEMORY_INVALID"
  | "MODULE_MEMORY_LIMIT"
  | "ABI_VERSION_MISMATCH"
  | "ABI_CALL_FAILED"
  | "ABI_TRAP"
  | "PLUGIN_NOT_LOADED"
  | "PLUGIN_ALREADY_LOADED"
  | "PLUGIN_IN_USE"
  | "INSTANCE_NOT_FOUND"
  | "INSTANCE_ALREADY_EXISTS"
  | "INSTANCE_LIMIT"
  | "INSTANCE_CREATE_FAILED"
  | "INSTANCE_ERRORED"
  | "CHANNELS_UNSUPPORTED"
  | "FRAMES_UNSUPPORTED"
  | "PARAMETER_INDEX_INVALID"
  | "STATE_TOO_LARGE"
  | "STATE_REJECTED";

export class RuntimeError extends Error {
  override readonly name = "AudiospanRuntimeError";
  readonly code: RuntimeErrorCode;
  readonly status: number | undefined;

  constructor(code: RuntimeErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
