export { AudiospanHost, type AddPluginOptions, type AudiospanHostOptions, type CreatePluginOptions, type LoadPluginOptions } from "./host.js";
export { AudiospanError, mapRuntimeErrorCode, type AudiospanErrorCode, type AudiospanErrorOptions } from "./errors.js";
export { DEFAULT_PLUGIN_POLICY, resolvePolicy, checkOriginPolicy, type PluginPolicy, type UiMode } from "./policy.js";
export type { WorkletTransport } from "./transport.js";
export { AudioWorkletTransport } from "./transport.js";
export type { PluginSource, PluginSourceInput } from "./loader.js";
export { wasmSimdSupported } from "./loader.js";
export { createPluginStore, type PluginSnapshot, type PluginStore, type PluginStoreStatus } from "./store.js";
export type { Unsubscribe } from "./events.js";
export type {
  AudioChain,
  AudioPortDescriptor,
  AudiospanDiagnostic,
  BypassChangeEvent,
  HostEvents,
  HostStatus,
  LatencyChangeEvent,
  OutputDescriptor,
  OutputValuesEvent,
  ParameterChangeEvent,
  ParameterChangeSource,
  ParameterDescriptor,
  PluginDescriptor,
  PluginErrorEvent,
  PluginInstance,
  PluginInstanceEvents,
  PluginInstanceStatus,
  PluginLogEvent,
  PluginLogLevel,
  PluginStateEvent,
  PluginStatusEvent,
  SetStateOptions,
  TypedPluginInstance,
} from "./types.js";
export type {
  PluginState,
  PresetDescriptor,
  NormalizedPluginManifest,
  NormalizedParameter,
  NormalizedOutput,
  PluginCapabilities,
  ResourceLimits,
  ValidationIssue,
} from "@audiospan/manifest";
export { formatParameterValue, formatOutputValue, toNormalized, fromNormalized, clampParameterValue } from "@audiospan/manifest";
export type { RuntimeDiagnostic } from "@audiospan/runtime";
export { PROCESSOR_NAME, PROTOCOL_VERSION } from "@audiospan/runtime";
