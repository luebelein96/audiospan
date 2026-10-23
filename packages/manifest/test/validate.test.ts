import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseManifest, validateManifest, type PluginManifest } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("../../../tests/fixtures/manifests/", import.meta.url));
const validText = readFileSync(`${fixturesDir}valid-gain.json`, "utf8");
const valid = JSON.parse(validText) as PluginManifest;
const invalidCases = JSON.parse(readFileSync(`${fixturesDir}invalid-cases.json`, "utf8")) as { name: string; code: string; patch: Record<string, unknown> }[];

function withPatch(patch: Record<string, unknown>): unknown {
  return { ...structuredClone(valid), ...patch };
}

describe("validateManifest", () => {
  it("accepts the reference manifest and normalizes it", () => {
    const result = validateManifest(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
    const m = result.manifest;
    expect(m.id).toBe("com.example.gain");
    expect(m.parameters).toHaveLength(4);
    expect(m.parameters[0]).toMatchObject({ id: "gain", index: 0, min: 0, max: 2, default: 1, step: 0.01 });
    expect(m.parameters[0]!.display).toEqual({ style: "knob", format: "linear", precision: 2, bipolar: false });
    expect(m.parameters[0]).toMatchObject({ scale: "linear", skew: 1, automatable: true });
    expect(m.outputs).toHaveLength(1);
    expect(m.outputs[0]).toMatchObject({ id: "level", index: 0, min: 0, max: 2, display: { format: "linear", precision: 2 } });
    expect(m.parameters[1]).toMatchObject({ id: "mode", type: "enum", min: 0, max: 1, index: 1 });
    expect(m.parameters[1]!.display.style).toBe("select");
    expect(m.parameters[2]).toMatchObject({ id: "stages", type: "integer", step: 1 });
    expect(m.parameters[3]).toMatchObject({ id: "enabled", type: "boolean", min: 0, max: 1, step: 1 });
    expect(m.capabilities.presets).toBe(true);
    expect(m.resources.maxMemoryBytes).toBe(16777216);
    expect(m.audio.maxFramesPerProcess).toBe(2048);
    expect(m.presets).toHaveLength(1);
  });

  it("fills defaults for omitted optional sections", () => {
    const minimal = {
      schemaVersion: 1,
      id: "com.example.min",
      name: "Min",
      version: "1.0.0",
      entry: { wasm: "m.wasm", abi: "audiospan-c" },
      audio: { inputs: [{ id: "in", name: "In", channels: { min: 1, max: 1 } }], outputs: [{ id: "out", name: "Out", channels: { min: 1, max: 1 } }] },
      parameters: [],
    };
    const result = validateManifest(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities).toEqual({ state: true, presets: false, customUI: false, midiInput: false, sidechain: false, network: false, filesystem: false });
    expect(result.manifest.resources).toEqual({ maxMemoryBytes: 16777216, maxStateBytes: 1048576, maxAssetBytes: 1048576 });
    expect(result.manifest.audio.maxFramesPerProcess).toBe(4096);
    expect(result.manifest.audio.latencyFrames).toBe(0);
    expect(result.manifest.presets).toEqual([]);
  });

  for (const c of invalidCases) {
    it(`rejects: ${c.name}`, () => {
      const result = validateManifest(withPatch(c.patch));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((e) => e.code)).toContain(c.code);
    });
  }

  it("accepts scale, skew, automatable and bipolar and rejects their misuse", () => {
    const freq = { id: "freq", name: "Freq", type: "float", min: 20, max: 20000, default: 1000, scale: "logarithmic", display: { format: "hertz" } };
    const pan = { id: "pan", name: "Pan", type: "float", min: -1, max: 1, default: 0, skew: 0.5, automatable: false, display: { bipolar: true } };
    const ok = validateManifest(withPatch({ parameters: [freq, pan] }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.manifest.parameters[0]).toMatchObject({ scale: "logarithmic", skew: 1, automatable: true });
    expect(ok.manifest.parameters[1]).toMatchObject({ scale: "linear", skew: 0.5, automatable: false, display: { bipolar: true } });

    const codes = (patch: Record<string, unknown>) => {
      const r = validateManifest(withPatch(patch));
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes({ parameters: [{ ...freq, min: 0 }] })).toContain("MANIFEST_PARAM_SCALE_INVALID");
    expect(codes({ parameters: [{ ...freq, scale: "exponential" }] })).toContain("MANIFEST_PARAM_SCALE_INVALID");
    expect(codes({ parameters: [{ ...freq, skew: 0.5 }] })).toContain("MANIFEST_PARAM_SKEW_INVALID");
    expect(codes({ parameters: [{ ...pan, skew: 0 }] })).toContain("MANIFEST_PARAM_SKEW_INVALID");
    expect(codes({ parameters: [{ ...pan, skew: 101 }] })).toContain("MANIFEST_PARAM_SKEW_INVALID");
    expect(codes({ parameters: [{ ...pan, automatable: "no" }] })).toContain("MANIFEST_PARAM_AUTOMATABLE_INVALID");
    expect(codes({ parameters: [{ ...pan, display: { bipolar: 1 } }] })).toContain("MANIFEST_PARAM_DISPLAY_INVALID");
    expect(codes({ parameters: [{ id: "on", name: "On", type: "boolean", default: 1, scale: "linear" }] })).toContain("MANIFEST_PARAM_SCALE_INVALID");
    expect(codes({ parameters: [{ id: "m", name: "M", type: "enum", default: 0, options: [{ value: 0, label: "A" }], skew: 2 }] })).toContain("MANIFEST_PARAM_SCALE_INVALID");
    expect(codes({ parameters: [{ ...pan, display: { format: "furlongs" } }] })).toContain("MANIFEST_PARAM_DISPLAY_INVALID");
    expect(validateManifest(withPatch({ parameters: [{ ...pan, display: { format: "semitones" } }] })).ok).toBe(true);
  });

  it("validates outputs", () => {
    const codes = (patch: Record<string, unknown>) => {
      const r = validateManifest(withPatch(patch));
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    const minimal = validateManifest(withPatch({ outputs: [{ id: "gr", name: "Gain reduction" }] }));
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.manifest.outputs[0]).toEqual({ id: "gr", name: "Gain reduction", unit: undefined, description: undefined, min: 0, max: 1, display: { format: "linear", precision: 2 }, index: 0 });
    const none = validateManifest(withPatch({ outputs: undefined }));
    expect(none.ok && none.manifest.outputs).toEqual([]);
    expect(codes({ outputs: "meter" })).toContain("MANIFEST_OUTPUTS_INVALID");
    expect(codes({ outputs: [{ id: "a", name: "A" }, { id: "a", name: "B" }] })).toContain("MANIFEST_OUTPUT_ID_DUPLICATE");
    expect(codes({ outputs: [{ id: "bad id", name: "A" }] })).toContain("MANIFEST_OUTPUT_ID_INVALID");
    expect(codes({ outputs: [{ id: "a", name: "A", min: 1, max: 1 }] })).toContain("MANIFEST_OUTPUT_RANGE_INVALID");
    expect(codes({ outputs: [{ id: "a", name: "A", max: "loud" }] })).toContain("MANIFEST_OUTPUT_RANGE_INVALID");
    expect(codes({ outputs: [{ id: "a", name: "A", display: { format: "parsecs" } }] })).toContain("MANIFEST_PARAM_DISPLAY_INVALID");
    expect(codes({ outputs: [{ id: "a" }] })).toContain("MANIFEST_FIELD_REQUIRED");
    expect(codes({ outputs: Array.from({ length: 129 }, (_, i) => ({ id: `o${i}`, name: "O" })) })).toContain("MANIFEST_OUTPUTS_INVALID");
  });

  it("rejects duplicate parameter ids", () => {
    const m = structuredClone(valid);
    m.parameters.push({ ...m.parameters[0]! });
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PARAM_ID_DUPLICATE");
  });

  it("rejects non-finite and out-of-order parameter ranges", () => {
    const m = structuredClone(valid);
    m.parameters[0]!.min = 1.5;
    m.parameters[0]!.default = 1.0;
    let result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PARAM_DEFAULT_OUT_OF_RANGE");

    const text = validText.replace('"max": 2.0', '"max": 1e999');
    result = parseManifest(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PARAM_RANGE_INVALID");
  });

  it("rejects non-positive step", () => {
    const m = structuredClone(valid);
    m.parameters[0]!.step = 0;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PARAM_STEP_INVALID");
  });

  it("rejects enum default not among options", () => {
    const m = structuredClone(valid);
    m.parameters[1]!.default = 7;
    const result = validateManifest(m);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PARAM_DEFAULT_OUT_OF_RANGE");
  });

  it("enforces host policy limits", () => {
    const result = validateManifest(valid, { maxMemoryBytes: 1024 * 1024, maxChannels: 1, maxFramesPerProcess: 4096 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("MANIFEST_POLICY_MEMORY");
    expect(codes).toContain("MANIFEST_POLICY_FRAMES");
  });

  it("rejects ports that need more channels than the host supports", () => {
    const m = structuredClone(valid);
    m.audio.inputs[0]!.channels = { min: 4, max: 8 };
    const result = validateManifest(m, { maxChannels: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_PORT_CHANNELS_UNSUPPORTED");
  });

  it("denies capabilities outside host policy", () => {
    const m = structuredClone(valid);
    m.capabilities = { ...m.capabilities, customUI: true };
    const result = validateManifest(m, { allowedCapabilities: { customUI: false } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_CAPABILITY_DENIED");
  });

  it("warns on unknown fields and uncompensated latency", () => {
    const m = { ...structuredClone(valid), future: true } as unknown as PluginManifest;
    m.audio.latencyFrames = 64;
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("MANIFEST_FIELD_UNKNOWN");
    expect(codes).toContain("MANIFEST_LATENCY_UNCOMPENSATED");
  });
});

describe("parseManifest", () => {
  it("reports JSON syntax errors", () => {
    const result = parseManifest("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("MANIFEST_JSON_INVALID");
  });

  it("rejects oversized manifests before parsing", () => {
    const result = parseManifest("x".repeat(1024), { maxBytes: 512 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("MANIFEST_TOO_LARGE");
  });

  it("rejects non-object JSON", () => {
    const result = parseManifest("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("MANIFEST_NOT_OBJECT");
  });
});
