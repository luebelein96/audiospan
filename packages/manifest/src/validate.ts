import { isSafeRelativePath } from "./paths.js";
import { normalizeOutput, normalizeParameter } from "./parameters.js";
import { isPluginId, isSemver, isShortId } from "./semver.js";
import {
  ABI_IDENTIFIER,
  DEFAULT_CAPABILITIES,
  DEFAULT_MAX_FRAMES_PER_PROCESS,
  DEFAULT_RESOURCE_LIMITS,
  MANIFEST_HARD_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  type AudioPortManifest,
  type EnumOption,
  type NormalizedOutput,
  type NormalizedParameter,
  type NormalizedPluginManifest,
  type OutputManifest,
  type ParameterDisplay,
  type ParameterDisplayFormat,
  type ParameterDisplayStyle,
  type ParameterManifest,
  type ParameterScale,
  type ParameterType,
  type PluginCapabilities,
  type PresetReference,
  type ResourceLimits,
} from "./types.js";

export interface ValidationIssue {
  /** Stable machine-readable code, e.g. `MANIFEST_ID_INVALID`. */
  code: string;
  /** JSON-pointer-like path into the manifest, e.g. `/parameters/0/min`. */
  path: string;
  message: string;
}

export interface ManifestPolicy {
  /** Reject manifests whose declared memory exceeds this (bytes). */
  maxMemoryBytes?: number;
  maxStateBytes?: number;
  maxAssetBytes?: number;
  /** Maximum channel count the host will route (default 2). */
  maxChannels?: number;
  /** Maximum frames the host will ever pass per process call. */
  maxFramesPerProcess?: number;
  /** Capabilities the host grants. Requested capabilities outside this set are errors. */
  allowedCapabilities?: Partial<PluginCapabilities>;
  /** Supported ABI identifiers (default: `audiospan-c`). */
  supportedAbis?: readonly string[];
}

export type ManifestValidationResult =
  | { ok: true; manifest: NormalizedPluginManifest; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

const PARAMETER_TYPES: readonly ParameterType[] = ["float", "integer", "boolean", "enum"];
const DISPLAY_STYLES = ["knob", "slider", "stepper", "toggle", "select"] as const;
const DISPLAY_FORMATS = ["linear", "decibel", "percent", "hertz", "milliseconds", "seconds", "integer", "semitones", "cents", "beats"] as const;
const PARAMETER_SCALES: readonly ParameterScale[] = ["linear", "logarithmic"];

/** Capabilities a v1 host can never grant: the runtime has no implementation. */
const UNSUPPORTED_CAPABILITIES: readonly (keyof PluginCapabilities)[] = ["midiInput", "sidechain", "network", "filesystem"];

class Issues {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  error(code: string, path: string, message: string): void {
    this.errors.push({ code, path, message });
  }
  warn(code: string, path: string, message: string): void {
    this.warnings.push({ code, path, message });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requireString(issues: Issues, obj: Record<string, unknown>, key: string, path: string, maxLength: number): string | undefined {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    issues.error("MANIFEST_FIELD_REQUIRED", `${path}/${key}`, `"${key}" must be a non-empty string`);
    return undefined;
  }
  if (value.length > maxLength) {
    issues.error("MANIFEST_FIELD_TOO_LONG", `${path}/${key}`, `"${key}" exceeds ${maxLength} characters`);
    return undefined;
  }
  return value;
}

function optionalString(issues: Issues, obj: Record<string, unknown>, key: string, path: string, maxLength: number): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.error("MANIFEST_FIELD_TYPE", `${path}/${key}`, `"${key}" must be a string`);
    return undefined;
  }
  if (value.length > maxLength) {
    issues.error("MANIFEST_FIELD_TOO_LONG", `${path}/${key}`, `"${key}" exceeds ${maxLength} characters`);
    return undefined;
  }
  return value;
}

function validatePort(issues: Issues, value: unknown, path: string, maxChannels: number): AudioPortManifest | undefined {
  if (!isRecord(value)) {
    issues.error("MANIFEST_PORT_INVALID", path, "port must be an object");
    return undefined;
  }
  const id = requireString(issues, value, "id", path, MANIFEST_HARD_LIMITS.maxIdLength);
  const name = requireString(issues, value, "name", path, MANIFEST_HARD_LIMITS.maxNameLength);
  if (id !== undefined && !isShortId(id)) {
    issues.error("MANIFEST_PORT_ID_INVALID", `${path}/id`, `port id ${JSON.stringify(id)} must match [A-Za-z][A-Za-z0-9_-]*`);
  }
  const channels = value["channels"];
  if (!isRecord(channels) || !isPositiveInteger(channels["min"]) || !isPositiveInteger(channels["max"])) {
    issues.error("MANIFEST_PORT_CHANNELS_INVALID", `${path}/channels`, "channels must be { min: >=1, max: >=1 } integers");
    return undefined;
  }
  const min = channels["min"];
  const max = channels["max"];
  if (min > max) {
    issues.error("MANIFEST_PORT_CHANNELS_INVALID", `${path}/channels`, "channels.min must be <= channels.max");
    return undefined;
  }
  if (max > MANIFEST_HARD_LIMITS.maxChannelsPerPort) {
    issues.error("MANIFEST_PORT_CHANNELS_INVALID", `${path}/channels/max`, `channels.max exceeds hard limit ${MANIFEST_HARD_LIMITS.maxChannelsPerPort}`);
    return undefined;
  }
  if (min > maxChannels) {
    issues.error(
      "MANIFEST_PORT_CHANNELS_UNSUPPORTED",
      `${path}/channels/min`,
      `port requires at least ${min} channels but the host supports at most ${maxChannels}`,
    );
  }
  if (id === undefined || name === undefined) return undefined;
  return { id, name, channels: { min, max } };
}

function validateDisplay(issues: Issues, value: unknown, path: string): ParameterDisplay | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.error("MANIFEST_PARAM_DISPLAY_INVALID", path, "display must be an object");
    return undefined;
  }
  const display: ParameterDisplay = {};
  if (value["style"] !== undefined) {
    if (!(DISPLAY_STYLES as readonly unknown[]).includes(value["style"])) {
      issues.error("MANIFEST_PARAM_DISPLAY_INVALID", `${path}/style`, `display.style must be one of ${DISPLAY_STYLES.join(", ")}`);
    } else {
      display.style = value["style"] as ParameterDisplayStyle;
    }
  }
  if (value["format"] !== undefined) {
    if (!(DISPLAY_FORMATS as readonly unknown[]).includes(value["format"])) {
      issues.error("MANIFEST_PARAM_DISPLAY_INVALID", `${path}/format`, `display.format must be one of ${DISPLAY_FORMATS.join(", ")}`);
    } else {
      display.format = value["format"] as ParameterDisplayFormat;
    }
  }
  if (value["precision"] !== undefined) {
    if (!isNonNegativeInteger(value["precision"]) || value["precision"] > 10) {
      issues.error("MANIFEST_PARAM_DISPLAY_INVALID", `${path}/precision`, "display.precision must be an integer 0..10");
    } else {
      display.precision = value["precision"];
    }
  }
  if (value["bipolar"] !== undefined) {
    if (typeof value["bipolar"] !== "boolean") {
      issues.error("MANIFEST_PARAM_DISPLAY_INVALID", `${path}/bipolar`, "display.bipolar must be a boolean");
    } else {
      display.bipolar = value["bipolar"];
    }
  }
  return display;
}

function validateParameter(issues: Issues, value: unknown, index: number, seenIds: Set<string>): NormalizedParameter | undefined {
  const path = `/parameters/${index}`;
  if (!isRecord(value)) {
    issues.error("MANIFEST_PARAM_INVALID", path, "parameter must be an object");
    return undefined;
  }
  const errorsBefore = issues.errors.length;
  const id = requireString(issues, value, "id", path, MANIFEST_HARD_LIMITS.maxIdLength);
  const name = requireString(issues, value, "name", path, MANIFEST_HARD_LIMITS.maxNameLength);
  if (id !== undefined) {
    if (!isShortId(id)) {
      issues.error("MANIFEST_PARAM_ID_INVALID", `${path}/id`, `parameter id ${JSON.stringify(id)} must match [A-Za-z][A-Za-z0-9_-]*`);
    } else if (seenIds.has(id)) {
      issues.error("MANIFEST_PARAM_ID_DUPLICATE", `${path}/id`, `duplicate parameter id ${JSON.stringify(id)}`);
    } else {
      seenIds.add(id);
    }
  }
  const type = value["type"];
  if (!PARAMETER_TYPES.includes(type as ParameterType)) {
    issues.error("MANIFEST_PARAM_TYPE_INVALID", `${path}/type`, `type must be one of ${PARAMETER_TYPES.join(", ")}`);
    return undefined;
  }
  const unit = optionalString(issues, value, "unit", path, 32);
  const description = optionalString(issues, value, "description", path, 1024);
  const display = validateDisplay(issues, value["display"], `${path}/display`);
  let scale: ParameterScale | undefined;
  if (value["scale"] !== undefined) {
    if (!PARAMETER_SCALES.includes(value["scale"] as ParameterScale)) {
      issues.error("MANIFEST_PARAM_SCALE_INVALID", `${path}/scale`, `scale must be one of ${PARAMETER_SCALES.join(", ")}`);
    } else {
      scale = value["scale"] as ParameterScale;
    }
  }
  let skew: number | undefined;
  if (value["skew"] !== undefined) {
    if (!isFiniteNumber(value["skew"]) || value["skew"] <= 0 || value["skew"] > 100) {
      issues.error("MANIFEST_PARAM_SKEW_INVALID", `${path}/skew`, "skew must be a number greater than 0 and at most 100");
    } else {
      skew = value["skew"];
    }
  }
  let automatable: boolean | undefined;
  if (value["automatable"] !== undefined) {
    if (typeof value["automatable"] !== "boolean") {
      issues.error("MANIFEST_PARAM_AUTOMATABLE_INVALID", `${path}/automatable`, "automatable must be a boolean");
    } else {
      automatable = value["automatable"];
    }
  }

  const def = value["default"];
  if (!isFiniteNumber(def)) {
    issues.error("MANIFEST_PARAM_DEFAULT_INVALID", `${path}/default`, "default must be a finite number");
    return undefined;
  }
  let min: number | undefined;
  let max: number | undefined;
  let step: number | undefined;
  let options: EnumOption[] | undefined;

  if (value["min"] !== undefined) {
    if (!isFiniteNumber(value["min"])) issues.error("MANIFEST_PARAM_RANGE_INVALID", `${path}/min`, "min must be a finite number");
    else min = value["min"];
  }
  if (value["max"] !== undefined) {
    if (!isFiniteNumber(value["max"])) issues.error("MANIFEST_PARAM_RANGE_INVALID", `${path}/max`, "max must be a finite number");
    else max = value["max"];
  }
  if (value["step"] !== undefined) {
    if (!isFiniteNumber(value["step"]) || value["step"] <= 0) {
      issues.error("MANIFEST_PARAM_STEP_INVALID", `${path}/step`, "step must be a positive finite number");
    } else {
      step = value["step"];
    }
  }

  switch (type as ParameterType) {
    case "float":
    case "integer": {
      if (min === undefined || max === undefined) {
        issues.error("MANIFEST_PARAM_RANGE_REQUIRED", path, `${type} parameters require min and max`);
      } else {
        if (min > max) issues.error("MANIFEST_PARAM_RANGE_INVALID", path, "min must be <= max");
        if (def < min || def > max) issues.error("MANIFEST_PARAM_DEFAULT_OUT_OF_RANGE", `${path}/default`, "default must satisfy min <= default <= max");
      }
      if (type === "integer") {
        if (!Number.isInteger(def)) issues.error("MANIFEST_PARAM_DEFAULT_INVALID", `${path}/default`, "integer default must be an integer");
        if (min !== undefined && !Number.isInteger(min)) issues.error("MANIFEST_PARAM_RANGE_INVALID", `${path}/min`, "integer min must be an integer");
        if (max !== undefined && !Number.isInteger(max)) issues.error("MANIFEST_PARAM_RANGE_INVALID", `${path}/max`, "integer max must be an integer");
        if (step !== undefined && !Number.isInteger(step)) issues.error("MANIFEST_PARAM_STEP_INVALID", `${path}/step`, "integer step must be an integer");
      }
      if (scale === "logarithmic") {
        if (min !== undefined && min <= 0) issues.error("MANIFEST_PARAM_SCALE_INVALID", `${path}/scale`, "logarithmic scale requires min > 0");
        if (skew !== undefined && skew !== 1) issues.error("MANIFEST_PARAM_SKEW_INVALID", `${path}/skew`, "skew cannot be combined with the logarithmic scale");
      }
      if (value["options"] !== undefined) issues.error("MANIFEST_PARAM_OPTIONS_INVALID", `${path}/options`, `options are only valid for enum parameters`);
      break;
    }
    case "boolean": {
      if (def !== 0 && def !== 1) issues.error("MANIFEST_PARAM_DEFAULT_INVALID", `${path}/default`, "boolean default must be 0 or 1");
      if (value["options"] !== undefined) issues.error("MANIFEST_PARAM_OPTIONS_INVALID", `${path}/options`, `options are only valid for enum parameters`);
      if (scale !== undefined || skew !== undefined) issues.error("MANIFEST_PARAM_SCALE_INVALID", path, "scale and skew are only valid for float and integer parameters");
      break;
    }
    case "enum": {
      if (scale !== undefined || skew !== undefined) issues.error("MANIFEST_PARAM_SCALE_INVALID", path, "scale and skew are only valid for float and integer parameters");
      const raw = value["options"];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 1024) {
        issues.error("MANIFEST_PARAM_OPTIONS_INVALID", `${path}/options`, "enum parameters require a non-empty options array");
        break;
      }
      options = [];
      const seenValues = new Set<number>();
      raw.forEach((option, i) => {
        if (!isRecord(option) || !isFiniteNumber(option["value"]) || typeof option["label"] !== "string" || option["label"].length === 0) {
          issues.error("MANIFEST_PARAM_OPTIONS_INVALID", `${path}/options/${i}`, "option must be { value: number, label: string }");
          return;
        }
        if (seenValues.has(option["value"])) {
          issues.error("MANIFEST_PARAM_OPTIONS_INVALID", `${path}/options/${i}/value`, `duplicate option value ${option["value"]}`);
          return;
        }
        seenValues.add(option["value"]);
        options!.push({ value: option["value"], label: option["label"] });
      });
      if (!seenValues.has(def)) {
        issues.error("MANIFEST_PARAM_DEFAULT_OUT_OF_RANGE", `${path}/default`, "enum default must be one of the option values");
      }
      break;
    }
  }

  if (issues.errors.length !== errorsBefore || id === undefined || name === undefined) return undefined;
  const manifest: ParameterManifest = { id, name, type: type as ParameterType, default: def };
  if (unit !== undefined) manifest.unit = unit;
  if (description !== undefined) manifest.description = description;
  if (min !== undefined) manifest.min = min;
  if (max !== undefined) manifest.max = max;
  if (step !== undefined) manifest.step = step;
  if (options !== undefined) manifest.options = options;
  if (scale !== undefined) manifest.scale = scale;
  if (skew !== undefined) manifest.skew = skew;
  if (automatable !== undefined) manifest.automatable = automatable;
  if (display !== undefined) manifest.display = display;
  return normalizeParameter(manifest, index);
}

function validateOutputs(issues: Issues, value: unknown): NormalizedOutput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.error("MANIFEST_OUTPUTS_INVALID", "/outputs", "outputs must be an array");
    return [];
  }
  if (value.length > MANIFEST_HARD_LIMITS.maxOutputs) {
    issues.error("MANIFEST_OUTPUTS_INVALID", "/outputs", `too many outputs (max ${MANIFEST_HARD_LIMITS.maxOutputs})`);
    return [];
  }
  const out: NormalizedOutput[] = [];
  const seen = new Set<string>();
  value.forEach((raw, i) => {
    const path = `/outputs/${i}`;
    if (!isRecord(raw)) {
      issues.error("MANIFEST_OUTPUT_INVALID", path, "output must be an object");
      return;
    }
    const errorsBefore = issues.errors.length;
    const id = requireString(issues, raw, "id", path, MANIFEST_HARD_LIMITS.maxIdLength);
    const name = requireString(issues, raw, "name", path, MANIFEST_HARD_LIMITS.maxNameLength);
    if (id !== undefined) {
      if (!isShortId(id)) {
        issues.error("MANIFEST_OUTPUT_ID_INVALID", `${path}/id`, `output id ${JSON.stringify(id)} must match [A-Za-z][A-Za-z0-9_-]*`);
      } else if (seen.has(id)) {
        issues.error("MANIFEST_OUTPUT_ID_DUPLICATE", `${path}/id`, `duplicate output id ${JSON.stringify(id)}`);
      } else {
        seen.add(id);
      }
    }
    const unit = optionalString(issues, raw, "unit", path, 32);
    const description = optionalString(issues, raw, "description", path, 1024);
    let min = 0;
    let max = 1;
    if (raw["min"] !== undefined) {
      if (!isFiniteNumber(raw["min"])) issues.error("MANIFEST_OUTPUT_RANGE_INVALID", `${path}/min`, "min must be a finite number");
      else min = raw["min"];
    }
    if (raw["max"] !== undefined) {
      if (!isFiniteNumber(raw["max"])) issues.error("MANIFEST_OUTPUT_RANGE_INVALID", `${path}/max`, "max must be a finite number");
      else max = raw["max"];
    }
    if (min >= max) issues.error("MANIFEST_OUTPUT_RANGE_INVALID", path, "min must be < max");
    const display = validateDisplay(issues, raw["display"], `${path}/display`);
    if (issues.errors.length !== errorsBefore || id === undefined || name === undefined) return;
    const output: OutputManifest = { id, name, min, max };
    if (unit !== undefined) output.unit = unit;
    if (description !== undefined) output.description = description;
    if (display !== undefined) {
      output.display = {};
      if (display.format !== undefined) output.display.format = display.format;
      if (display.precision !== undefined) output.display.precision = display.precision;
    }
    out.push(normalizeOutput(output, i));
  });
  return out;
}

function validateCapabilities(issues: Issues, value: unknown, policy: ManifestPolicy): PluginCapabilities {
  const result: PluginCapabilities = { ...DEFAULT_CAPABILITIES };
  if (value === undefined) return result;
  if (!isRecord(value)) {
    issues.error("MANIFEST_CAPABILITIES_INVALID", "/capabilities", "capabilities must be an object");
    return result;
  }
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULT_CAPABILITIES)) {
      issues.warn("MANIFEST_CAPABILITY_UNKNOWN", `/capabilities/${key}`, `unknown capability ${JSON.stringify(key)} ignored`);
      continue;
    }
    const v = value[key];
    if (typeof v !== "boolean") {
      issues.error("MANIFEST_CAPABILITIES_INVALID", `/capabilities/${key}`, "capability flags must be booleans");
      continue;
    }
    result[key as keyof PluginCapabilities] = v;
  }
  for (const key of UNSUPPORTED_CAPABILITIES) {
    if (result[key]) {
      issues.error("MANIFEST_CAPABILITY_UNSUPPORTED", `/capabilities/${key}`, `capability ${JSON.stringify(key)} is not supported by this runtime`);
    }
  }
  const allowed = policy.allowedCapabilities;
  if (allowed) {
    for (const key of Object.keys(result) as (keyof PluginCapabilities)[]) {
      if (result[key] && allowed[key] === false) {
        issues.error("MANIFEST_CAPABILITY_DENIED", `/capabilities/${key}`, `host policy does not grant capability ${JSON.stringify(key)}`);
      }
    }
  }
  return result;
}

function validateResources(issues: Issues, value: unknown, policy: ManifestPolicy): ResourceLimits {
  const result: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS };
  if (value !== undefined) {
    if (!isRecord(value)) {
      issues.error("MANIFEST_RESOURCES_INVALID", "/resources", "resources must be an object");
    } else {
      for (const key of ["maxMemoryBytes", "maxStateBytes", "maxAssetBytes"] as const) {
        const v = value[key];
        if (v === undefined) continue;
        if (!isPositiveInteger(v)) {
          issues.error("MANIFEST_RESOURCES_INVALID", `/resources/${key}`, `${key} must be a positive integer`);
          continue;
        }
        if (v > MANIFEST_HARD_LIMITS[key]) {
          issues.error("MANIFEST_RESOURCES_INVALID", `/resources/${key}`, `${key} exceeds hard limit ${MANIFEST_HARD_LIMITS[key]}`);
          continue;
        }
        result[key] = v;
      }
      for (const key of Object.keys(value)) {
        if (!(key in DEFAULT_RESOURCE_LIMITS)) issues.warn("MANIFEST_RESOURCE_UNKNOWN", `/resources/${key}`, `unknown resource limit ${JSON.stringify(key)} ignored`);
      }
    }
  }
  if (policy.maxMemoryBytes !== undefined && result.maxMemoryBytes > policy.maxMemoryBytes) {
    issues.error("MANIFEST_POLICY_MEMORY", "/resources/maxMemoryBytes", `plugin declares ${result.maxMemoryBytes} bytes of memory but host policy allows ${policy.maxMemoryBytes}`);
  }
  if (policy.maxStateBytes !== undefined && result.maxStateBytes > policy.maxStateBytes) {
    issues.error("MANIFEST_POLICY_STATE", "/resources/maxStateBytes", `plugin declares ${result.maxStateBytes} bytes of state but host policy allows ${policy.maxStateBytes}`);
  }
  if (policy.maxAssetBytes !== undefined && result.maxAssetBytes > policy.maxAssetBytes) {
    issues.error("MANIFEST_POLICY_ASSETS", "/resources/maxAssetBytes", `plugin declares ${result.maxAssetBytes} bytes of assets but host policy allows ${policy.maxAssetBytes}`);
  }
  return result;
}

function validatePresets(issues: Issues, value: unknown, presetsCapability: boolean): PresetReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.error("MANIFEST_PRESETS_INVALID", "/presets", "presets must be an array");
    return [];
  }
  if (value.length > MANIFEST_HARD_LIMITS.maxPresets) {
    issues.error("MANIFEST_PRESETS_INVALID", "/presets", `too many presets (max ${MANIFEST_HARD_LIMITS.maxPresets})`);
    return [];
  }
  if (value.length > 0 && !presetsCapability) {
    issues.warn("MANIFEST_PRESETS_WITHOUT_CAPABILITY", "/presets", "presets are listed but capabilities.presets is false; they will be ignored");
    return [];
  }
  const out: PresetReference[] = [];
  const seen = new Set<string>();
  value.forEach((preset, i) => {
    const path = `/presets/${i}`;
    if (!isRecord(preset)) {
      issues.error("MANIFEST_PRESET_INVALID", path, "preset must be an object");
      return;
    }
    const id = requireString(issues, preset, "id", path, MANIFEST_HARD_LIMITS.maxIdLength);
    const name = requireString(issues, preset, "name", path, MANIFEST_HARD_LIMITS.maxNameLength);
    const presetPath = requireString(issues, preset, "path", path, MANIFEST_HARD_LIMITS.maxPathLength);
    const description = optionalString(issues, preset, "description", path, 1024);
    if (id !== undefined && !isShortId(id)) issues.error("MANIFEST_PRESET_ID_INVALID", `${path}/id`, `preset id ${JSON.stringify(id)} must match [A-Za-z][A-Za-z0-9_-]*`);
    if (id !== undefined && seen.has(id)) issues.error("MANIFEST_PRESET_ID_DUPLICATE", `${path}/id`, `duplicate preset id ${JSON.stringify(id)}`);
    if (presetPath !== undefined && !isSafeRelativePath(presetPath)) issues.error("MANIFEST_PATH_UNSAFE", `${path}/path`, `preset path ${JSON.stringify(presetPath)} must be a safe relative path`);
    if (id === undefined || name === undefined || presetPath === undefined) return;
    seen.add(id);
    const ref: PresetReference = { id, name, path: presetPath };
    if (description !== undefined) ref.description = description;
    out.push(ref);
  });
  return out;
}

/**
 * Validate an already-parsed manifest object and normalize it.
 * Never throws; all problems are reported as issues.
 */
export function validateManifest(input: unknown, policy: ManifestPolicy = {}): ManifestValidationResult {
  const issues = new Issues();
  if (!isRecord(input)) {
    issues.error("MANIFEST_NOT_OBJECT", "", "manifest must be a JSON object");
    return { ok: false, errors: issues.errors, warnings: issues.warnings };
  }
  if (input["schemaVersion"] !== MANIFEST_SCHEMA_VERSION) {
    issues.error("MANIFEST_SCHEMA_VERSION_UNSUPPORTED", "/schemaVersion", `schemaVersion must be ${MANIFEST_SCHEMA_VERSION} (got ${JSON.stringify(input["schemaVersion"])})`);
    return { ok: false, errors: issues.errors, warnings: issues.warnings };
  }

  const id = requireString(issues, input, "id", "", MANIFEST_HARD_LIMITS.maxIdLength);
  if (id !== undefined && !isPluginId(id)) {
    issues.error("MANIFEST_ID_INVALID", "/id", `plugin id ${JSON.stringify(id)} must be a reverse-DNS style identifier like "com.example.gain"`);
  }
  const name = requireString(issues, input, "name", "", MANIFEST_HARD_LIMITS.maxNameLength);
  const version = requireString(issues, input, "version", "", 64);
  if (version !== undefined && !isSemver(version)) {
    issues.error("MANIFEST_VERSION_INVALID", "/version", `version ${JSON.stringify(version)} must be a semantic version`);
  }
  const vendor = optionalString(issues, input, "vendor", "", MANIFEST_HARD_LIMITS.maxNameLength);
  const description = optionalString(issues, input, "description", "", 2048);
  const category = optionalString(issues, input, "category", "", 64);
  const license = optionalString(issues, input, "license", "", 128);

  // entry
  let entryWasm: string | undefined;
  const entry = input["entry"];
  if (!isRecord(entry)) {
    issues.error("MANIFEST_ENTRY_INVALID", "/entry", "entry must be an object with wasm and abi");
  } else {
    entryWasm = requireString(issues, entry, "wasm", "/entry", MANIFEST_HARD_LIMITS.maxPathLength);
    if (entryWasm !== undefined && !isSafeRelativePath(entryWasm)) {
      issues.error("MANIFEST_PATH_UNSAFE", "/entry/wasm", `entry.wasm ${JSON.stringify(entryWasm)} must be a safe relative path`);
    }
    const supported = policy.supportedAbis ?? [ABI_IDENTIFIER];
    if (typeof entry["abi"] !== "string" || !supported.includes(entry["abi"])) {
      issues.error("MANIFEST_ABI_UNSUPPORTED", "/entry/abi", `entry.abi must be one of ${supported.map((s) => JSON.stringify(s)).join(", ")}`);
    }
  }

  // audio
  const maxChannels = policy.maxChannels ?? 2;
  const inputs: AudioPortManifest[] = [];
  const outputs: AudioPortManifest[] = [];
  let maxFramesPerProcess = DEFAULT_MAX_FRAMES_PER_PROCESS;
  let latencyFrames = 0;
  const audio = input["audio"];
  if (!isRecord(audio)) {
    issues.error("MANIFEST_AUDIO_INVALID", "/audio", "audio must be an object with inputs and outputs");
  } else {
    for (const kind of ["inputs", "outputs"] as const) {
      const ports = audio[kind];
      if (!Array.isArray(ports)) {
        issues.error("MANIFEST_AUDIO_INVALID", `/audio/${kind}`, `audio.${kind} must be an array`);
        continue;
      }
      if (ports.length > MANIFEST_HARD_LIMITS.maxPorts) {
        issues.error("MANIFEST_AUDIO_INVALID", `/audio/${kind}`, `too many ${kind} (max ${MANIFEST_HARD_LIMITS.maxPorts})`);
        continue;
      }
      const seen = new Set<string>();
      ports.forEach((port, i) => {
        const validated = validatePort(issues, port, `/audio/${kind}/${i}`, maxChannels);
        if (!validated) return;
        if (seen.has(validated.id)) {
          issues.error("MANIFEST_PORT_ID_DUPLICATE", `/audio/${kind}/${i}/id`, `duplicate port id ${JSON.stringify(validated.id)}`);
          return;
        }
        seen.add(validated.id);
        (kind === "inputs" ? inputs : outputs).push(validated);
      });
    }
    if (Array.isArray(audio["outputs"]) && outputs.length === 0 && audio["outputs"].length === 0) {
      issues.error("MANIFEST_AUDIO_INVALID", "/audio/outputs", "an effect must declare at least one output port");
    }
    if (inputs.length > 1 || outputs.length > 1) {
      issues.error("MANIFEST_AUDIO_UNSUPPORTED", "/audio", "runtime v1 supports exactly one input port and one output port");
    }
    if (audio["maxFramesPerProcess"] !== undefined) {
      const v = audio["maxFramesPerProcess"];
      if (!isPositiveInteger(v) || v > MANIFEST_HARD_LIMITS.maxFramesPerProcess) {
        issues.error("MANIFEST_AUDIO_INVALID", "/audio/maxFramesPerProcess", `maxFramesPerProcess must be an integer 1..${MANIFEST_HARD_LIMITS.maxFramesPerProcess}`);
      } else {
        maxFramesPerProcess = v;
      }
    }
    if (audio["latencyFrames"] !== undefined) {
      const v = audio["latencyFrames"];
      if (!isNonNegativeInteger(v)) {
        issues.error("MANIFEST_AUDIO_INVALID", "/audio/latencyFrames", "latencyFrames must be a non-negative integer");
      } else {
        latencyFrames = v;
        if (v > 0) issues.warn("MANIFEST_LATENCY_UNCOMPENSATED", "/audio/latencyFrames", "the v1 runtime does not compensate plugin latency");
      }
    }
    if (policy.maxFramesPerProcess !== undefined && maxFramesPerProcess < policy.maxFramesPerProcess) {
      issues.error("MANIFEST_POLICY_FRAMES", "/audio/maxFramesPerProcess", `plugin supports at most ${maxFramesPerProcess} frames per process but the host may deliver ${policy.maxFramesPerProcess}`);
    }
  }

  // parameters
  const parameters: NormalizedParameter[] = [];
  const rawParameters = input["parameters"];
  if (!Array.isArray(rawParameters)) {
    issues.error("MANIFEST_PARAMETERS_INVALID", "/parameters", "parameters must be an array (may be empty)");
  } else if (rawParameters.length > MANIFEST_HARD_LIMITS.maxParameters) {
    issues.error("MANIFEST_PARAMETERS_INVALID", "/parameters", `too many parameters (max ${MANIFEST_HARD_LIMITS.maxParameters})`);
  } else {
    const seen = new Set<string>();
    rawParameters.forEach((p, i) => {
      const validated = validateParameter(issues, p, i, seen);
      if (validated) parameters.push(validated);
    });
  }

  const valueOutputs = validateOutputs(issues, input["outputs"]);
  const capabilities = validateCapabilities(issues, input["capabilities"], policy);
  const resources = validateResources(issues, input["resources"], policy);
  const presets = validatePresets(issues, input["presets"], capabilities.presets);

  let ui: { entry: string } | undefined;
  if (input["ui"] !== undefined) {
    if (!isRecord(input["ui"]) || typeof input["ui"]["entry"] !== "string") {
      issues.error("MANIFEST_UI_INVALID", "/ui", "ui must be an object with an entry path");
    } else if (!isSafeRelativePath(input["ui"]["entry"])) {
      issues.error("MANIFEST_PATH_UNSAFE", "/ui/entry", "ui.entry must be a safe relative path");
    } else {
      ui = { entry: input["ui"]["entry"] };
      if (!capabilities.customUI) issues.warn("MANIFEST_UI_WITHOUT_CAPABILITY", "/ui", "ui.entry is set but capabilities.customUI is false; it will be ignored");
    }
  }

  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) issues.warn("MANIFEST_FIELD_UNKNOWN", `/${key}`, `unknown field ${JSON.stringify(key)} ignored`);
  }

  if (issues.errors.length > 0 || id === undefined || name === undefined || version === undefined || entryWasm === undefined) {
    return { ok: false, errors: issues.errors, warnings: issues.warnings };
  }

  const manifest: NormalizedPluginManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    name,
    version,
    vendor,
    description,
    category,
    license,
    entry: { wasm: entryWasm, abi: ABI_IDENTIFIER },
    audio: { inputs, outputs, maxFramesPerProcess, latencyFrames },
    parameters,
    outputs: valueOutputs,
    capabilities,
    resources,
    presets,
    ui,
  };
  return { ok: true, manifest, warnings: issues.warnings };
}

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  "schemaVersion", "id", "name", "version", "vendor", "description", "category", "license",
  "entry", "audio", "parameters", "outputs", "capabilities", "resources", "presets", "ui", "$schema",
]);

export interface ParseManifestOptions extends ManifestPolicy {
  /** Reject manifest text larger than this many UTF-16 code units (default 256 KiB). */
  maxBytes?: number;
}

export const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;

/** Parse JSON text and validate it. Never throws. */
export function parseManifest(text: string, options: ParseManifestOptions = {}): ManifestValidationResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  if (text.length > maxBytes) {
    return {
      ok: false,
      errors: [{ code: "MANIFEST_TOO_LARGE", path: "", message: `manifest is ${text.length} bytes; maximum is ${maxBytes}` }],
      warnings: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [{ code: "MANIFEST_JSON_INVALID", path: "", message: `manifest is not valid JSON: ${(error as Error).message}` }],
      warnings: [],
    };
  }
  return validateManifest(parsed, options);
}

/** Convenience: throws an Error listing all problems when validation fails. */
export function assertManifest(input: unknown, policy?: ManifestPolicy): NormalizedPluginManifest {
  const result = validateManifest(input, policy);
  if (!result.ok) throw new Error(formatIssues(result.errors));
  return result.manifest;
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`).join("\n");
}
