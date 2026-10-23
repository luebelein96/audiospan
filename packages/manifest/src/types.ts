/**
 * Audiospan plugin manifest types (schema version 1).
 *
 * `PluginManifest` is the shape authors write in `plugin.json`.
 * `NormalizedPluginManifest` is what the SDK and runtime consume: every
 * optional field has been resolved to its documented default.
 */

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const ABI_IDENTIFIER = "audiospan-c" as const;

export type ParameterType = "float" | "integer" | "boolean" | "enum";

export type ParameterDisplayStyle = "knob" | "slider" | "stepper" | "toggle" | "select";

export type ParameterDisplayFormat =
  | "linear"
  | "decibel"
  | "percent"
  | "hertz"
  | "milliseconds"
  | "seconds"
  | "integer"
  | "semitones"
  | "cents"
  | "beats";

/** How a parameter's real value maps to the normalized [0, 1] control position. */
export type ParameterScale = "linear" | "logarithmic";

export interface ParameterDisplay {
  style?: ParameterDisplayStyle;
  format?: ParameterDisplayFormat;
  precision?: number;
  /** The control's rest position is zero (or the centre when zero is out of range): pan, a ±dB trim. */
  bipolar?: boolean;
}

export interface OutputDisplay {
  format?: ParameterDisplayFormat;
  precision?: number;
}

export interface EnumOption {
  value: number;
  label: string;
}

export interface ParameterManifest {
  /** Stable, machine-readable identifier. Unique within the plugin. */
  id: string;
  /** Human-readable label. May be localized separately. */
  name: string;
  type: ParameterType;
  unit?: string;
  description?: string;
  min?: number;
  max?: number;
  default: number;
  step?: number;
  options?: EnumOption[];
  /** Mapping between real values and the normalized control position (default "linear"). "logarithmic" requires min > 0. */
  scale?: ParameterScale;
  /** Power-curve skew of the normalized position (default 1 = none). Below 1 gives more resolution near min. Only with the linear scale. */
  skew?: number;
  /** Whether hosts may automate this parameter (default true). Set false for parameters that reconfigure DSP or change latency. */
  automatable?: boolean;
  display?: ParameterDisplay;
}

/** A read-only value the plugin computes for display: a meter, gain reduction, a readout. */
export interface OutputManifest {
  /** Stable identifier. Unique among outputs. */
  id: string;
  name: string;
  unit?: string;
  description?: string;
  /** Expected range, used to scale meters (default 0..1). */
  min?: number;
  max?: number;
  display?: OutputDisplay;
}

export interface ChannelRange {
  min: number;
  max: number;
}

export interface AudioPortManifest {
  id: string;
  name: string;
  channels: ChannelRange;
}

export interface AudioManifest {
  inputs: AudioPortManifest[];
  outputs: AudioPortManifest[];
  maxFramesPerProcess?: number;
  latencyFrames?: number;
}

export interface PluginCapabilities {
  state: boolean;
  presets: boolean;
  customUI: boolean;
  midiInput: boolean;
  sidechain: boolean;
  network: boolean;
  filesystem: boolean;
}

export interface ResourceLimits {
  maxMemoryBytes: number;
  maxStateBytes: number;
  maxAssetBytes: number;
}

export interface PresetReference {
  id: string;
  name: string;
  path: string;
  description?: string;
}

export interface ManifestEntry {
  wasm: string;
  abi: typeof ABI_IDENTIFIER;
}

export interface PluginUiManifest {
  /** Relative path to the isolated UI entry HTML. Only used when customUI is granted. */
  entry: string;
}

/** The authored `plugin.json` shape. */
export interface PluginManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  vendor?: string;
  description?: string;
  category?: string;
  license?: string;
  entry: ManifestEntry;
  audio: AudioManifest;
  parameters: ParameterManifest[];
  /** Read-only values the plugin exposes through `audiospan_get_output`. Order defines ABI output indices. */
  outputs?: OutputManifest[];
  capabilities?: Partial<PluginCapabilities>;
  resources?: Partial<ResourceLimits>;
  presets?: PresetReference[];
  ui?: PluginUiManifest;
}

/** A parameter with every optional numeric field resolved. */
export interface NormalizedParameter {
  id: string;
  name: string;
  type: ParameterType;
  unit: string | undefined;
  description: string | undefined;
  min: number;
  max: number;
  default: number;
  step: number | undefined;
  options: readonly EnumOption[];
  scale: ParameterScale;
  skew: number;
  automatable: boolean;
  display: Required<ParameterDisplay>;
  /** ABI parameter index: the position in the manifest's parameter array. */
  index: number;
}

/** An output with every optional field resolved. */
export interface NormalizedOutput {
  id: string;
  name: string;
  unit: string | undefined;
  description: string | undefined;
  min: number;
  max: number;
  display: Required<OutputDisplay>;
  /** ABI output index: the position in the manifest's outputs array. */
  index: number;
}

export interface NormalizedAudioManifest {
  inputs: readonly AudioPortManifest[];
  outputs: readonly AudioPortManifest[];
  maxFramesPerProcess: number;
  latencyFrames: number;
}

export interface NormalizedPluginManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  vendor: string | undefined;
  description: string | undefined;
  category: string | undefined;
  license: string | undefined;
  entry: ManifestEntry;
  audio: NormalizedAudioManifest;
  parameters: readonly NormalizedParameter[];
  outputs: readonly NormalizedOutput[];
  capabilities: Readonly<PluginCapabilities>;
  resources: Readonly<ResourceLimits>;
  presets: readonly PresetReference[];
  ui: PluginUiManifest | undefined;
}

/** Serializable plugin state (schema version 1). */
export interface PluginState {
  schemaVersion: 1;
  pluginId: string;
  pluginVersion: string;
  parameters: Record<string, number>;
  /** Base64-encoded opaque plugin bytes. Size-limited by `resources.maxStateBytes`. */
  opaqueState?: string;
}

export interface PresetDescriptor {
  id: string;
  name: string;
  description?: string;
  state: PluginState;
}

export const DEFAULT_CAPABILITIES: Readonly<PluginCapabilities> = Object.freeze({
  state: true,
  presets: false,
  customUI: false,
  midiInput: false,
  sidechain: false,
  network: false,
  filesystem: false,
});

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxMemoryBytes: 16 * 1024 * 1024,
  maxStateBytes: 1024 * 1024,
  maxAssetBytes: 1024 * 1024,
});

export const DEFAULT_MAX_FRAMES_PER_PROCESS = 4096;

/** Hard upper bounds that no manifest may exceed regardless of host policy. */
export const MANIFEST_HARD_LIMITS = Object.freeze({
  maxParameters: 512,
  maxOutputs: 128,
  maxPorts: 8,
  maxChannelsPerPort: 32,
  maxFramesPerProcess: 65536,
  maxPresets: 256,
  maxIdLength: 128,
  maxNameLength: 256,
  maxPathLength: 512,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxStateBytes: 64 * 1024 * 1024,
  maxAssetBytes: 256 * 1024 * 1024,
});
