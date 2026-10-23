import { base64ByteLength, base64ToBytes } from "./base64.js";
import { clampParameterValue } from "./parameters.js";
import type { NormalizedPluginManifest, PluginState, PresetDescriptor } from "./types.js";
import type { ValidationIssue } from "./validate.js";
import { isSemver, isShortId } from "./semver.js";

export interface StateValidationOptions {
  /** Reject unknown parameter ids instead of ignoring them (default false). */
  strict?: boolean;
  /** Reject when the plugin version differs (default false; a warning is emitted). */
  requireSameVersion?: boolean;
}

export interface ValidatedState {
  /** Parameter values keyed by id, clamped to manifest ranges. Only known ids. */
  parameters: Record<string, number>;
  /** Decoded opaque bytes, if any. */
  opaqueBytes: Uint8Array | undefined;
}

export type StateValidationResult =
  | { ok: true; state: ValidatedState; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a `PluginState` document against a plugin manifest.
 *
 * Default behaviour (forward compatible): unknown parameter ids are ignored
 * with a warning; out-of-range values are clamped with a warning. In strict
 * mode both are errors. Non-finite values and oversized opaque state are
 * always errors.
 */
export function validatePluginState(
  input: unknown,
  manifest: NormalizedPluginManifest,
  options: StateValidationOptions = {},
): StateValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  if (!isRecord(input)) {
    errors.push({ code: "STATE_NOT_OBJECT", path: "", message: "state must be a JSON object" });
    return { ok: false, errors, warnings };
  }
  if (input["schemaVersion"] !== 1) {
    errors.push({ code: "STATE_SCHEMA_VERSION_UNSUPPORTED", path: "/schemaVersion", message: `state schemaVersion must be 1 (got ${JSON.stringify(input["schemaVersion"])})` });
    return { ok: false, errors, warnings };
  }
  if (input["pluginId"] !== manifest.id) {
    errors.push({ code: "STATE_PLUGIN_MISMATCH", path: "/pluginId", message: `state is for plugin ${JSON.stringify(input["pluginId"])} but this plugin is ${JSON.stringify(manifest.id)}` });
  }
  if (!isSemver(input["pluginVersion"])) {
    errors.push({ code: "STATE_VERSION_INVALID", path: "/pluginVersion", message: "pluginVersion must be a semantic version" });
  } else if (input["pluginVersion"] !== manifest.version) {
    const issue = { code: "STATE_VERSION_MISMATCH", path: "/pluginVersion", message: `state was saved by version ${input["pluginVersion"]}; plugin is ${manifest.version}` };
    if (options.requireSameVersion) errors.push(issue);
    else warnings.push(issue);
  }

  const parameters: Record<string, number> = {};
  const rawParams = input["parameters"];
  if (!isRecord(rawParams)) {
    errors.push({ code: "STATE_PARAMETERS_INVALID", path: "/parameters", message: "parameters must be an object" });
  } else {
    for (const [id, raw] of Object.entries(rawParams)) {
      const param = manifest.parameters.find((p) => p.id === id);
      if (!param) {
        const issue = { code: "STATE_PARAMETER_UNKNOWN", path: `/parameters/${id}`, message: `unknown parameter ${JSON.stringify(id)}` };
        if (options.strict) errors.push(issue);
        else warnings.push(issue);
        continue;
      }
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        errors.push({ code: "STATE_PARAMETER_VALUE_INVALID", path: `/parameters/${id}`, message: `parameter ${JSON.stringify(id)} must be a finite number` });
        continue;
      }
      const { value, clamped } = clampParameterValue(param, raw);
      if (clamped) {
        const issue = { code: "STATE_PARAMETER_CLAMPED", path: `/parameters/${id}`, message: `parameter ${JSON.stringify(id)} value ${raw} adjusted to ${value}` };
        if (options.strict) errors.push(issue);
        else warnings.push(issue);
      }
      parameters[id] = value;
    }
  }

  let opaqueBytes: Uint8Array | undefined;
  const opaque = input["opaqueState"];
  if (opaque !== undefined) {
    if (typeof opaque !== "string") {
      errors.push({ code: "STATE_OPAQUE_INVALID", path: "/opaqueState", message: "opaqueState must be a base64 string" });
    } else {
      const length = base64ByteLength(opaque);
      if (length < 0) {
        errors.push({ code: "STATE_OPAQUE_INVALID", path: "/opaqueState", message: "opaqueState is not valid base64" });
      } else if (length > manifest.resources.maxStateBytes) {
        errors.push({ code: "STATE_OPAQUE_TOO_LARGE", path: "/opaqueState", message: `opaqueState is ${length} bytes; plugin limit is ${manifest.resources.maxStateBytes}` });
      } else {
        try {
          opaqueBytes = base64ToBytes(opaque);
        } catch {
          errors.push({ code: "STATE_OPAQUE_INVALID", path: "/opaqueState", message: "opaqueState is not valid base64" });
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, state: { parameters, opaqueBytes }, warnings };
}

export type PresetValidationResult =
  | { ok: true; preset: PresetDescriptor; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

/** Validate a preset JSON document (shape + embedded state). */
export function validatePreset(input: unknown, manifest: NormalizedPluginManifest, options: StateValidationOptions = {}): PresetValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: [{ code: "PRESET_NOT_OBJECT", path: "", message: "preset must be a JSON object" }], warnings: [] };
  }
  if (!isShortId(input["id"])) errors.push({ code: "PRESET_ID_INVALID", path: "/id", message: "preset id must match [A-Za-z][A-Za-z0-9_-]*" });
  if (typeof input["name"] !== "string" || input["name"].length === 0 || input["name"].length > 256) {
    errors.push({ code: "PRESET_NAME_INVALID", path: "/name", message: "preset name must be a non-empty string" });
  }
  if (input["description"] !== undefined && typeof input["description"] !== "string") {
    errors.push({ code: "PRESET_DESCRIPTION_INVALID", path: "/description", message: "preset description must be a string" });
  }
  const stateResult = validatePluginState(input["state"], manifest, options);
  if (!stateResult.ok) {
    errors.push(...stateResult.errors.map((e) => ({ ...e, path: `/state${e.path}` })));
  }
  const warnings = stateResult.warnings.map((w) => ({ ...w, path: `/state${w.path}` }));
  if (errors.length > 0 || !stateResult.ok) return { ok: false, errors, warnings };
  const state = input["state"] as PluginState;
  const preset: PresetDescriptor = {
    id: input["id"] as string,
    name: input["name"] as string,
    state: {
      schemaVersion: 1,
      pluginId: state.pluginId,
      pluginVersion: state.pluginVersion,
      parameters: stateResult.state.parameters,
      ...(state.opaqueState !== undefined ? { opaqueState: state.opaqueState } : {}),
    },
  };
  if (typeof input["description"] === "string") preset.description = input["description"];
  return { ok: true, preset, warnings };
}

/** Build a state document holding the manifest defaults. */
export function defaultPluginState(manifest: NormalizedPluginManifest): PluginState {
  const parameters: Record<string, number> = {};
  for (const p of manifest.parameters) parameters[p.id] = p.default;
  return { schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters };
}
