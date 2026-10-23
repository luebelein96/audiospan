import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertManifest, bytesToBase64, defaultPluginState, validatePluginState, validatePreset } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("../../../tests/fixtures/manifests/", import.meta.url));
const manifest = assertManifest(JSON.parse(readFileSync(`${fixturesDir}valid-gain.json`, "utf8")));

describe("validatePluginState", () => {
  it("accepts a valid state and decodes opaque bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const result = validatePluginState(
      { schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: 0.5 }, opaqueState: bytesToBase64(bytes) },
      manifest,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.parameters).toEqual({ gain: 0.5 });
    expect(Array.from(result.state.opaqueBytes!)).toEqual([1, 2, 3, 4, 5]);
    expect(result.warnings).toEqual([]);
  });

  it("ignores unknown parameters by default and rejects them in strict mode", () => {
    const state = { schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: 1, nope: 3 } };
    const lenient = validatePluginState(state, manifest);
    expect(lenient.ok).toBe(true);
    if (lenient.ok) {
      expect(lenient.state.parameters).toEqual({ gain: 1 });
      expect(lenient.warnings.map((w) => w.code)).toEqual(["STATE_PARAMETER_UNKNOWN"]);
    }
    const strict = validatePluginState(state, manifest, { strict: true });
    expect(strict.ok).toBe(false);
  });

  it("clamps out-of-range values with a warning", () => {
    const result = validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: 9 } }, manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.parameters["gain"]).toBe(2);
    expect(result.warnings.map((w) => w.code)).toEqual(["STATE_PARAMETER_CLAMPED"]);
  });

  it("rejects non-finite values, wrong plugin id, and bad schema version", () => {
    const nan = validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: Number.NaN } }, manifest);
    expect(nan.ok).toBe(false);
    if (!nan.ok) expect(nan.errors[0]!.code).toBe("STATE_PARAMETER_VALUE_INVALID");
    const wrongId = validatePluginState({ schemaVersion: 1, pluginId: "other", pluginVersion: manifest.version, parameters: {} }, manifest);
    expect(wrongId.ok).toBe(false);
    if (!wrongId.ok) expect(wrongId.errors[0]!.code).toBe("STATE_PLUGIN_MISMATCH");
    const badSchema = validatePluginState({ schemaVersion: 2, pluginId: manifest.id, pluginVersion: manifest.version, parameters: {} }, manifest);
    expect(badSchema.ok).toBe(false);
  });

  it("rejects oversized or malformed opaque state", () => {
    const big = "A".repeat(Math.ceil(manifest.resources.maxStateBytes / 3) * 4 + 4);
    const result = validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: {}, opaqueState: big }, manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("STATE_OPAQUE_TOO_LARGE");
    const bad = validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: {}, opaqueState: "!!!!" }, manifest);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]!.code).toBe("STATE_OPAQUE_INVALID");
  });

  it("warns on version mismatch unless same version is required", () => {
    const state = { schemaVersion: 1, pluginId: manifest.id, pluginVersion: "0.0.1", parameters: {} };
    const lenient = validatePluginState(state, manifest);
    expect(lenient.ok).toBe(true);
    if (lenient.ok) expect(lenient.warnings.map((w) => w.code)).toEqual(["STATE_VERSION_MISMATCH"]);
    expect(validatePluginState(state, manifest, { requireSameVersion: true }).ok).toBe(false);
  });
});

describe("validatePreset / defaultPluginState", () => {
  it("validates a preset document", () => {
    const result = validatePreset({ id: "half", name: "Half", state: { ...defaultPluginState(manifest), parameters: { gain: 0.5 } } }, manifest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.state.parameters).toEqual({ gain: 0.5 });
  });
  it("rejects a preset with a bad id or state", () => {
    expect(validatePreset({ id: "bad id", name: "X", state: defaultPluginState(manifest) }, manifest).ok).toBe(false);
    expect(validatePreset({ id: "x", name: "X", state: { schemaVersion: 1 } }, manifest).ok).toBe(false);
  });
  it("builds defaults from the manifest", () => {
    expect(defaultPluginState(manifest).parameters).toEqual({ gain: 1, mode: 0, stages: 1, enabled: 1 });
  });
});
