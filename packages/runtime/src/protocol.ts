import type { NormalizedPluginManifest } from "@audiospan/manifest";
import type { RuntimeErrorCode } from "./errors.js";
import type { WasmMemoryInfo } from "./wasm/inspect.js";

/** Bumped whenever the wire format changes; INIT fails clearly when the SDK and worklet disagree. */
export const PROTOCOL_VERSION = 3 as const;
export const PROCESSOR_NAME = "audiospan-processor";

export interface RuntimeConfig {
  sampleRate: number;
  /** Channel count of the worklet node's output and of every plugin instance. */
  maxChannels: number;
  /** Largest frame count the host will deliver per process call. */
  maxFrames: number;
  maxPlugins: number;
  diagnostics: boolean;
  /** Consecutive process failures before an instance stays bypassed (default 3). */
  processErrorBypassThreshold: number;
  /** Zero non-finite output samples and report them (default = diagnostics). */
  scanNonFinite: boolean;
  /** Maximum diagnostics posted per second from the audio thread (default 20). */
  diagnosticsPerSecond: number;
  /**
   * Grant the development-only `env.audiospan_log` import and forward plugin
   * log lines as LOG messages (default false: modules importing it are rejected).
   */
  pluginLogging: boolean;
  /** How often read-only output values (manifest `outputs`) are posted, per second (default 30; 0 disables). */
  outputsPerSecond: number;
}

export const DEFAULT_RUNTIME_CONFIG: Readonly<Omit<RuntimeConfig, "sampleRate">> = Object.freeze({
  maxChannels: 2,
  maxFrames: 128,
  maxPlugins: 8,
  diagnostics: false,
  processErrorBypassThreshold: 3,
  scanNonFinite: false,
  diagnosticsPerSecond: 20,
  pluginLogging: false,
  outputsPerSecond: 30,
});

export type MainToWorkletMessage =
  | { type: "INIT"; protocolVersion: typeof PROTOCOL_VERSION; requestId: number; config: RuntimeConfig }
  | {
      type: "LOAD_PLUGIN";
      requestId: number;
      pluginId: string;
      /** Precompiled module (preferred) or a copy of the module bytes. */
      module: WebAssembly.Module | ArrayBuffer;
      /** Memory limits parsed from the bytes; required if the module imports its memory. */
      memoryInfo?: WasmMemoryInfo;
      manifest: NormalizedPluginManifest;
    }
  | { type: "UNLOAD_PLUGIN"; requestId: number; pluginId: string }
  | { type: "CREATE_INSTANCE"; requestId: number; pluginId: string; instanceId: string; initialParameters?: number[] }
  | { type: "DESTROY_INSTANCE"; requestId: number; instanceId: string }
  | { type: "SET_PARAMETER"; instanceId: string; parameterIndex: number; value: number; sequence: number }
  | { type: "SET_BYPASS"; instanceId: string; bypassed: boolean; sequence: number }
  | { type: "REPLACE_CHAIN"; requestId: number; instanceIds: string[] }
  | { type: "RESET"; requestId: number; instanceId: string }
  | { type: "GET_PARAMETER"; requestId: number; instanceId: string; parameterIndex: number }
  | { type: "GET_STATE"; requestId: number; instanceId: string }
  | { type: "SET_STATE"; requestId: number; instanceId: string; parameters: [index: number, value: number][]; opaque?: ArrayBuffer }
  | { type: "PING"; requestId: number }
  | { type: "DISPOSE"; requestId: number };

export type RuntimeDiagnostic =
  | { kind: "worklet-initialized"; sampleRate: number; maxChannels: number; maxFrames: number }
  | { kind: "plugin-load-start"; pluginId: string }
  | { kind: "plugin-load-success"; pluginId: string }
  | { kind: "plugin-load-failure"; pluginId: string; message: string }
  | { kind: "plugin-instance-created"; instanceId: string; pluginId: string; channels: number; memoryBytes: number }
  | { kind: "plugin-instance-disposed"; instanceId: string; pluginId: string }
  | { kind: "parameter-update"; instanceId: string; parameterId: string; value: number; clamped: boolean }
  | { kind: "state-restore"; instanceId: string; warnings: number }
  | { kind: "audio-processing-error"; instanceId: string; message: string; status: number | undefined; consecutiveErrors: number; bypassed: boolean }
  | { kind: "processing-over-budget"; durationMs: number; budgetMs: number }
  | { kind: "processing-stats"; blocks: number; medianMs: number; p95Ms: number; p99Ms: number; maxMs: number; budgetMs: number; activePlugins: number }
  | { kind: "non-finite-output"; instanceId: string; count: number }
  | { kind: "memory-growth"; instanceId: string; memoryBytes: number }
  | { kind: "chain-replaced"; instanceIds: string[] }
  | { kind: "frames-unsupported"; frames: number; maxFrames: number }
  | { kind: "diagnostics-dropped"; count: number };

export type WorkletToMainMessage =
  | { type: "READY"; protocolVersion: typeof PROTOCOL_VERSION; requestId: number }
  | { type: "ACK"; requestId: number }
  | { type: "PLUGIN_READY"; requestId: number; pluginId: string }
  | { type: "INSTANCE_READY"; requestId: number; instanceId: string; channels: number; latencyFrames: number }
  | { type: "PARAMETER_VALUE"; requestId: number; instanceId: string; value: number }
  | { type: "STATE"; requestId: number; instanceId: string; opaque: ArrayBuffer }
  /** Reply to SET_STATE: every parameter value as the plugin now reports it (an opaque blob may have changed parameters the request did not list). */
  | { type: "STATE_APPLIED"; requestId: number; instanceId: string; parameters: number[] }
  | { type: "ERROR"; requestId?: number; code: RuntimeErrorCode; message: string; instanceId?: string; pluginId?: string }
  | { type: "DIAGNOSTIC"; event: RuntimeDiagnostic }
  /** The plugin's reported latency changed (optional `audiospan_get_latency`). Never rate limited. */
  | { type: "LATENCY_CHANGED"; instanceId: string; latencyFrames: number }
  /** Read-only output values (manifest `outputs`) for every instance that has them, posted `outputsPerSecond` times per second. */
  | { type: "OUTPUT_VALUES"; values: [instanceId: string, values: number[]][] }
  /**
   * A log line from a development build (`env.audiospan_log`). `bytes` is the
   * raw UTF-8 copied out of plugin memory (at most MAX_LOG_MESSAGE_BYTES); the
   * host decodes it, since AudioWorkletGlobalScope has no TextDecoder.
   * `dropped` counts rate-limited lines since the previous delivered one.
   */
  | { type: "LOG"; pluginId: string; instanceId?: string; level: number; bytes: Uint8Array; dropped: number };

export type MainMessageType = MainToWorkletMessage["type"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 65536;
}

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function validateRuntimeConfig(value: unknown): RuntimeConfig | string {
  if (!isRecord(value)) return "config must be an object";
  if (!isPositiveInt(value["sampleRate"], 1_000_000)) return "config.sampleRate must be a positive integer";
  if (!isPositiveInt(value["maxChannels"], 32)) return "config.maxChannels must be 1..32";
  if (!isPositiveInt(value["maxFrames"], 65536)) return "config.maxFrames must be 1..65536";
  if (!isPositiveInt(value["maxPlugins"], 256)) return "config.maxPlugins must be 1..256";
  if (typeof value["diagnostics"] !== "boolean") return "config.diagnostics must be a boolean";
  if (!isPositiveInt(value["processErrorBypassThreshold"], 1_000_000)) return "config.processErrorBypassThreshold must be a positive integer";
  if (typeof value["scanNonFinite"] !== "boolean") return "config.scanNonFinite must be a boolean";
  if (!isPositiveInt(value["diagnosticsPerSecond"], 10_000)) return "config.diagnosticsPerSecond must be 1..10000";
  if (typeof value["pluginLogging"] !== "boolean") return "config.pluginLogging must be a boolean";
  if (!isIntInRange(value["outputsPerSecond"], 0, 120)) return "config.outputsPerSecond must be 0..120";
  return {
    sampleRate: value["sampleRate"],
    maxChannels: value["maxChannels"],
    maxFrames: value["maxFrames"],
    maxPlugins: value["maxPlugins"],
    diagnostics: value["diagnostics"],
    processErrorBypassThreshold: value["processErrorBypassThreshold"],
    scanNonFinite: value["scanNonFinite"],
    diagnosticsPerSecond: value["diagnosticsPerSecond"],
    pluginLogging: value["pluginLogging"],
    outputsPerSecond: value["outputsPerSecond"],
  };
}

export type ParsedMainMessage = { ok: true; message: MainToWorkletMessage } | { ok: false; error: string; requestId: number | undefined };

/**
 * Validate an untrusted message from the main thread. Shapes are checked
 * field by field; the manifest inside LOAD_PLUGIN is checked only for the
 * fields the runtime uses (the SDK validates it fully before sending).
 */
export function parseMainMessage(data: unknown): ParsedMainMessage {
  if (!isRecord(data) || typeof data["type"] !== "string") return { ok: false, error: "message must be an object with a string type", requestId: undefined };
  const requestId = isRequestId(data["requestId"]) ? data["requestId"] : undefined;
  const fail = (error: string): ParsedMainMessage => ({ ok: false, error, requestId });
  switch (data["type"]) {
    case "INIT": {
      if (data["protocolVersion"] !== PROTOCOL_VERSION) return fail(`unsupported protocol version ${JSON.stringify(data["protocolVersion"])}; expected ${PROTOCOL_VERSION}`);
      if (requestId === undefined) return fail("INIT requires requestId");
      const config = validateRuntimeConfig(data["config"]);
      if (typeof config === "string") return fail(config);
      return { ok: true, message: { type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId, config } };
    }
    case "LOAD_PLUGIN": {
      if (requestId === undefined || !isId(data["pluginId"])) return fail("LOAD_PLUGIN requires requestId and pluginId");
      const module = data["module"];
      if (!(module instanceof WebAssembly.Module) && !(module instanceof ArrayBuffer)) return fail("LOAD_PLUGIN.module must be a WebAssembly.Module or ArrayBuffer");
      const manifest = data["manifest"];
      if (!isRecord(manifest) || manifest["id"] !== data["pluginId"] || !Array.isArray(manifest["parameters"]) || !Array.isArray(manifest["outputs"]) || !isRecord(manifest["audio"]) || !isRecord(manifest["resources"])) {
        return fail("LOAD_PLUGIN.manifest is missing required fields");
      }
      const memoryInfo = data["memoryInfo"];
      if (memoryInfo !== undefined && (!isRecord(memoryInfo) || typeof memoryInfo["imported"] !== "boolean" || typeof memoryInfo["initialPages"] !== "number")) {
        return fail("LOAD_PLUGIN.memoryInfo is malformed");
      }
      return {
        ok: true,
        message: {
          type: "LOAD_PLUGIN",
          requestId,
          pluginId: data["pluginId"],
          module,
          manifest: manifest as unknown as NormalizedPluginManifest,
          ...(memoryInfo !== undefined ? { memoryInfo: memoryInfo as unknown as WasmMemoryInfo } : {}),
        },
      };
    }
    case "UNLOAD_PLUGIN":
      if (requestId === undefined || !isId(data["pluginId"])) return fail("UNLOAD_PLUGIN requires requestId and pluginId");
      return { ok: true, message: { type: "UNLOAD_PLUGIN", requestId, pluginId: data["pluginId"] } };
    case "CREATE_INSTANCE": {
      if (requestId === undefined || !isId(data["pluginId"]) || !isId(data["instanceId"])) return fail("CREATE_INSTANCE requires requestId, pluginId and instanceId");
      const initial = data["initialParameters"];
      if (initial !== undefined && (!Array.isArray(initial) || initial.length > 65536 || !initial.every((v) => typeof v === "number" && Number.isFinite(v)))) {
        return fail("CREATE_INSTANCE.initialParameters must be an array of finite numbers");
      }
      return {
        ok: true,
        message: { type: "CREATE_INSTANCE", requestId, pluginId: data["pluginId"], instanceId: data["instanceId"], ...(initial !== undefined ? { initialParameters: initial as number[] } : {}) },
      };
    }
    case "DESTROY_INSTANCE":
      if (requestId === undefined || !isId(data["instanceId"])) return fail("DESTROY_INSTANCE requires requestId and instanceId");
      return { ok: true, message: { type: "DESTROY_INSTANCE", requestId, instanceId: data["instanceId"] } };
    case "SET_PARAMETER":
      if (!isId(data["instanceId"]) || !isIndex(data["parameterIndex"]) || typeof data["value"] !== "number" || !Number.isFinite(data["value"]) || !isRequestId(data["sequence"])) {
        return fail("SET_PARAMETER requires instanceId, parameterIndex, finite value and sequence");
      }
      return { ok: true, message: { type: "SET_PARAMETER", instanceId: data["instanceId"], parameterIndex: data["parameterIndex"], value: data["value"], sequence: data["sequence"] } };
    case "SET_BYPASS":
      if (!isId(data["instanceId"]) || typeof data["bypassed"] !== "boolean" || !isRequestId(data["sequence"])) return fail("SET_BYPASS requires instanceId, bypassed and sequence");
      return { ok: true, message: { type: "SET_BYPASS", instanceId: data["instanceId"], bypassed: data["bypassed"], sequence: data["sequence"] } };
    case "REPLACE_CHAIN": {
      const ids = data["instanceIds"];
      if (requestId === undefined || !Array.isArray(ids) || ids.length > 256 || !ids.every(isId)) return fail("REPLACE_CHAIN requires requestId and an array of instance ids");
      return { ok: true, message: { type: "REPLACE_CHAIN", requestId, instanceIds: ids as string[] } };
    }
    case "RESET":
      if (requestId === undefined || !isId(data["instanceId"])) return fail("RESET requires requestId and instanceId");
      return { ok: true, message: { type: "RESET", requestId, instanceId: data["instanceId"] } };
    case "GET_PARAMETER":
      if (requestId === undefined || !isId(data["instanceId"]) || !isIndex(data["parameterIndex"])) return fail("GET_PARAMETER requires requestId, instanceId and parameterIndex");
      return { ok: true, message: { type: "GET_PARAMETER", requestId, instanceId: data["instanceId"], parameterIndex: data["parameterIndex"] } };
    case "GET_STATE":
      if (requestId === undefined || !isId(data["instanceId"])) return fail("GET_STATE requires requestId and instanceId");
      return { ok: true, message: { type: "GET_STATE", requestId, instanceId: data["instanceId"] } };
    case "SET_STATE": {
      const params = data["parameters"];
      if (requestId === undefined || !isId(data["instanceId"]) || !Array.isArray(params) || params.length > 65536) return fail("SET_STATE requires requestId, instanceId and parameters");
      for (const entry of params) {
        if (!Array.isArray(entry) || entry.length !== 2 || !isIndex(entry[0]) || typeof entry[1] !== "number" || !Number.isFinite(entry[1])) return fail("SET_STATE.parameters entries must be [index, finiteValue]");
      }
      const opaque = data["opaque"];
      if (opaque !== undefined && !(opaque instanceof ArrayBuffer)) return fail("SET_STATE.opaque must be an ArrayBuffer");
      return { ok: true, message: { type: "SET_STATE", requestId, instanceId: data["instanceId"], parameters: params as [number, number][], ...(opaque !== undefined ? { opaque } : {}) } };
    }
    case "PING":
      if (requestId === undefined) return fail("PING requires requestId");
      return { ok: true, message: { type: "PING", requestId } };
    case "DISPOSE":
      if (requestId === undefined) return fail("DISPOSE requires requestId");
      return { ok: true, message: { type: "DISPOSE", requestId } };
    default:
      return fail(`unknown message type ${JSON.stringify(data["type"])}`);
  }
}
