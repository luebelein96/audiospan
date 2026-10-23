import type {
  AudioPortManifest,
  NormalizedOutput,
  NormalizedParameter,
  NormalizedPluginManifest,
  PluginCapabilities,
  PluginState,
  PresetDescriptor,
  ResourceLimits,
  ValidationIssue,
} from "@audiospan/manifest";
import type { RuntimeDiagnostic } from "@audiospan/runtime";
import type { AudiospanError } from "./errors.js";
import type { Unsubscribe } from "./events.js";

export type ParameterDescriptor = NormalizedParameter;
export type OutputDescriptor = NormalizedOutput;
export type AudioPortDescriptor = AudioPortManifest;

/** Everything a host application needs to know about a loaded plugin. */
export interface PluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly vendor: string | undefined;
  readonly description: string | undefined;
  readonly category: string | undefined;
  readonly license: string | undefined;
  readonly parameters: readonly ParameterDescriptor[];
  /** Read-only values the plugin computes (meters, gain reduction); see `PluginInstance.getOutput`. */
  readonly outputs: readonly OutputDescriptor[];
  readonly audioInputs: readonly AudioPortDescriptor[];
  readonly audioOutputs: readonly AudioPortDescriptor[];
  readonly capabilities: Readonly<PluginCapabilities>;
  readonly resources: Readonly<ResourceLimits>;
  readonly latencyFrames: number;
  readonly maxFramesPerProcess: number;
  readonly presets: readonly PresetDescriptor[];
  /** URL of plugin.json, or a synthetic identifier for inline sources. */
  readonly sourceUrl: string;
  readonly moduleByteLength: number;
  /** Warnings produced while loading (manifest, presets). */
  readonly warnings: readonly ValidationIssue[];
  readonly manifest: NormalizedPluginManifest;
}

export type PluginInstanceStatus = "created" | "ready" | "error" | "disposed";

export type ParameterChangeSource = "api" | "state" | "preset" | "reset";

export interface ParameterChangeEvent {
  readonly instanceId: string;
  readonly parameterId: string;
  readonly value: number;
  readonly normalized: number;
  /** True when the requested value was adjusted to fit the parameter's range/step. */
  readonly clamped: boolean;
  readonly source: ParameterChangeSource;
}

export interface BypassChangeEvent {
  readonly instanceId: string;
  readonly bypassed: boolean;
}

export interface PluginStateEvent {
  readonly instanceId: string;
  readonly reason: "restore" | "preset" | "reset";
  readonly presetId?: string;
  readonly warnings: readonly ValidationIssue[];
}

export interface PluginStatusEvent {
  readonly instanceId: string;
  readonly status: PluginInstanceStatus;
}

export interface PluginErrorEvent {
  readonly instanceId: string;
  readonly error: AudiospanError;
}

/** A batch of read-only output values, delivered `outputsPerSecond` times per second while audio runs. */
export interface OutputValuesEvent {
  readonly instanceId: string;
  /** Output id → latest value. */
  readonly values: Readonly<Record<string, number>>;
}

/** The plugin reported a different latency (optional `audiospan_get_latency`). The host does not compensate it. */
export interface LatencyChangeEvent {
  readonly instanceId: string;
  readonly latencyFrames: number;
}

export type PluginLogLevel = "error" | "warn" | "info" | "debug";

/** A log line from a plugin built with logging enabled (`audiospan build --dev`); requires `pluginLogging: true` on the host. */
export interface PluginLogEvent {
  readonly pluginId: string;
  /** Undefined for lines emitted while the runtime probe-instantiates a module during load. */
  readonly instanceId: string | undefined;
  readonly level: PluginLogLevel;
  readonly message: string;
  /** Lines the runtime rate-limited away since the previous delivered one. */
  readonly dropped: number;
}

export interface PluginInstanceEvents extends Record<string, unknown> {
  parameterchange: ParameterChangeEvent;
  bypasschange: BypassChangeEvent;
  statechange: PluginStateEvent;
  statuschange: PluginStatusEvent;
  error: PluginErrorEvent;
  outputs: OutputValuesEvent;
  latencychange: LatencyChangeEvent;
  log: PluginLogEvent;
}

export interface SetStateOptions {
  /** Reject unknown parameters and out-of-range values instead of ignoring/clamping. */
  strict?: boolean;
}

export interface PluginInstance {
  readonly id: string;
  readonly descriptor: PluginDescriptor;
  readonly status: PluginInstanceStatus;
  /** Channel count negotiated with the runtime for this instance. */
  readonly channels: number;
  /**
   * Latency the plugin currently reports in frames, or the manifest's
   * `audio.latencyFrames` when it reports none. Updated through `latencychange`.
   * The runtime does not compensate it; hosts that align parallel paths must.
   */
  readonly latencyFrames: number;

  /** Set a parameter by id. Values are clamped to the declared range; throws on unknown ids or non-finite values. */
  setParameter(id: string, value: number): void;
  /** The last value applied on the control plane (no round trip). */
  getParameter(id: string): number;
  /** Ask the runtime for the value the plugin currently holds (one round trip). Does not change the control-plane mirror. */
  readParameter(id: string): Promise<number>;
  setParameterNormalized(id: string, normalized: number): void;
  getParameterNormalized(id: string): number;
  /** Restore every parameter to its manifest default. */
  resetParameters(): void;

  /** Latest value of a read-only output (manifest `outputs`). Throws `INVALID_PARAMETER` for unknown ids. Refreshed while audio runs; see the `outputs` event. */
  getOutput(id: string): number;
  /** Latest values of every output, keyed by id. */
  getOutputs(): Readonly<Record<string, number>>;

  setBypassed(bypassed: boolean): void;
  isBypassed(): boolean;

  /** Clear DSP history (audiospan_reset). Parameter values are kept. Also clears an errored status. */
  reset(): Promise<void>;

  getState(): Promise<PluginState>;
  setState(state: PluginState, options?: SetStateOptions): Promise<void>;
  loadPreset(presetId: string): Promise<void>;

  on<K extends keyof PluginInstanceEvents>(event: K, listener: (event: PluginInstanceEvents[K]) => void): Unsubscribe;

  dispose(): Promise<void>;
}

/**
 * A `PluginInstance` whose parameter, output and preset ids are literal
 * types, so typos fail at compile time. `audiospan build` writes one per
 * plugin into `dist/plugin.d.ts` (for example `LowpassPlugin`); use it as the
 * type argument of `host.addPlugin<LowpassPlugin>(url)`.
 */
export interface TypedPluginInstance<P extends string = string, O extends string = string, R extends string = string>
  extends Omit<PluginInstance, "setParameter" | "getParameter" | "readParameter" | "setParameterNormalized" | "getParameterNormalized" | "getOutput" | "getOutputs" | "loadPreset"> {
  setParameter(id: P, value: number): void;
  getParameter(id: P): number;
  readParameter(id: P): Promise<number>;
  setParameterNormalized(id: P, normalized: number): void;
  getParameterNormalized(id: P): number;
  getOutput(id: O): number;
  getOutputs(): Readonly<Record<O, number>>;
  loadPreset(id: R): Promise<void>;
}

/**
 * An ordered list of plugin instances. Edits are synchronous for the caller;
 * each one is committed to the runtime in order and acknowledged
 * asynchronously (await `flush()` to wait for them). A commit the runtime
 * refuses is reported through the host's `error` event.
 */
export interface AudioChain {
  readonly id: string;
  /** Insert a plugin (at the end by default). */
  add(plugin: PluginInstance, index?: number): void;
  /** Remove a plugin by instance id. Throws CHAIN_ERROR when it is not in the chain. */
  remove(pluginId: string): void;
  move(pluginId: string, index: number): void;
  getPlugins(): readonly PluginInstance[];
  /** Resolves when all pending chain edits have been acknowledged by the runtime. Never rejects. */
  flush(): Promise<void>;
  /** Empty the chain in the runtime and detach it from the host. */
  dispose(): Promise<void>;
}

export type AudiospanDiagnostic =
  | RuntimeDiagnostic
  | { kind: "plugin-load-start"; pluginId: string; sourceUrl: string }
  | { kind: "plugin-load-success"; pluginId: string; sourceUrl: string; moduleByteLength: number; durationMs: number }
  | { kind: "plugin-load-failure"; pluginId: string; sourceUrl: string; message: string }
  | { kind: "plugin-load-warning"; pluginId: string; issues: readonly ValidationIssue[] }
  | { kind: "parameter-clamped"; instanceId: string; parameterId: string; requested: number; applied: number };

export interface HostEvents extends Record<string, unknown> {
  error: AudiospanError;
  diagnostic: AudiospanDiagnostic;
  /** Plugin log lines (development builds, `pluginLogging: true`). Also delivered to the instance's `log` event; printed to the console when nobody listens to either. */
  pluginlog: PluginLogEvent;
}

export type HostStatus = "ready" | "disposed";
