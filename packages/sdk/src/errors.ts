import type { ValidationIssue } from "@audiospan/manifest";
import type { RuntimeErrorCode } from "@audiospan/runtime";

export type AudiospanErrorCode =
  | "WORKLET_INIT_FAILED"
  | "WORKLET_PROCESSOR_ERROR"
  | "MANIFEST_FETCH_FAILED"
  | "MANIFEST_INVALID"
  | "MODULE_FETCH_FAILED"
  | "MODULE_INVALID"
  | "POLICY_VIOLATION"
  | "PLUGIN_NOT_FOUND"
  | "PLUGIN_ALREADY_LOADED"
  | "PLUGIN_IN_USE"
  | "INSTANCE_LIMIT"
  | "INSTANCE_CREATE_FAILED"
  | "INSTANCE_ERRORED"
  | "INVALID_PARAMETER"
  | "INVALID_STATE"
  | "PRESET_NOT_FOUND"
  | "CHAIN_ERROR"
  | "RUNTIME_ERROR"
  | "REQUEST_TIMEOUT"
  | "ABORTED"
  | "DISPOSED"
  | "NOT_SUPPORTED";

export interface AudiospanErrorOptions {
  cause?: unknown;
  issues?: readonly ValidationIssue[];
  runtimeCode?: RuntimeErrorCode;
  pluginId?: string;
  instanceId?: string;
}

/** Every error surfaced by the SDK. `code` is stable; `message` is for humans. */
export class AudiospanError extends Error {
  override readonly name = "AudiospanError";
  readonly code: AudiospanErrorCode;
  /** Validation issues, when the error came from manifest/state validation. */
  readonly issues: readonly ValidationIssue[];
  /** The underlying runtime error code, when the error came from the worklet. */
  readonly runtimeCode: RuntimeErrorCode | undefined;
  readonly pluginId: string | undefined;
  readonly instanceId: string | undefined;

  constructor(code: AudiospanErrorCode, message: string, options: AudiospanErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    this.issues = options.issues ?? [];
    this.runtimeCode = options.runtimeCode;
    this.pluginId = options.pluginId;
    this.instanceId = options.instanceId;
  }

  static is(value: unknown, code?: AudiospanErrorCode): value is AudiospanError {
    return value instanceof AudiospanError && (code === undefined || value.code === code);
  }
}

/** Map a runtime (worklet) error code to the SDK code a host application sees. */
export function mapRuntimeErrorCode(code: RuntimeErrorCode): AudiospanErrorCode {
  switch (code) {
    case "MODULE_INVALID":
    case "MODULE_IMPORT_UNSUPPORTED":
    case "MODULE_EXPORT_MISSING":
    case "MODULE_MEMORY_INVALID":
    case "MODULE_MEMORY_LIMIT":
    case "ABI_VERSION_MISMATCH":
      return "MODULE_INVALID";
    case "PLUGIN_NOT_LOADED":
      return "PLUGIN_NOT_FOUND";
    case "PLUGIN_ALREADY_LOADED":
      return "PLUGIN_ALREADY_LOADED";
    case "PLUGIN_IN_USE":
      return "PLUGIN_IN_USE";
    case "INSTANCE_LIMIT":
      return "INSTANCE_LIMIT";
    case "INSTANCE_CREATE_FAILED":
    case "INSTANCE_ALREADY_EXISTS":
    case "CHANNELS_UNSUPPORTED":
    case "FRAMES_UNSUPPORTED":
      return "INSTANCE_CREATE_FAILED";
    case "INSTANCE_ERRORED":
      return "INSTANCE_ERRORED";
    case "PARAMETER_INDEX_INVALID":
      return "INVALID_PARAMETER";
    case "STATE_TOO_LARGE":
    case "STATE_REJECTED":
      return "INVALID_STATE";
    case "RUNTIME_DISPOSED":
      return "DISPOSED";
    default:
      return "RUNTIME_ERROR";
  }
}
