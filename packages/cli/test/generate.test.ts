import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertManifest } from "@audiospan/manifest";
import { CliError, cppConstant, generateCppHeader, generateRustModule, generateTypes, rustConstant, typePrefix } from "../src/lib.js";

const fixture = fileURLToPath(new URL("../../../tests/fixtures/manifests/valid-gain.json", import.meta.url));
const manifest = assertManifest(JSON.parse(readFileSync(fixture, "utf8")));

describe("generated bindings", () => {
  it("derives identifiers from ids", () => {
    expect(cppConstant("cutoff")).toBe("kCutoff");
    expect(cppConstant("dry-wet")).toBe("kDryWet");
    expect(cppConstant("dryWet")).toBe("kDryWet");
    expect(cppConstant("q")).toBe("kQ");
    expect(cppConstant("mode2")).toBe("kMode2");
    expect(cppConstant("level", "kOut")).toBe("kOutLevel");
    expect(rustConstant("cutoff")).toBe("CUTOFF");
    expect(rustConstant("dry-wet")).toBe("DRY_WET");
    expect(rustConstant("dryWet")).toBe("DRY_WET");
    expect(rustConstant("level", "OUT_")).toBe("OUT_LEVEL");
    expect(typePrefix(manifest)).toBe("Gain");
    expect(typePrefix({ ...manifest, id: "com.example.my_filter" })).toBe("MyFilter");
  });

  it("emits a C++ header with an index enum, the spec table and output indices", () => {
    const header = generateCppHeader(manifest);
    expect(header).toContain("#pragma once");
    expect(header).toContain('#include "audiospan/effect.hpp"');
    expect(header).toContain("namespace plugin {");
    expect(header).toContain("kGain = 0,");
    expect(header).toContain("kMode = 1,");
    expect(header).toContain("kStages = 2,");
    expect(header).toContain("kEnabled = 3,");
    expect(header).toContain("kParamCount = 4");
    expect(header).toContain('{"gain", audiospan::ParameterKind::Float, 0.0, 2.0, 1.0, 0.01},');
    expect(header).toContain('{"mode", audiospan::ParameterKind::Enum, 0.0, 1.0, 0.0, 0.0},');
    expect(header).toContain('{"stages", audiospan::ParameterKind::Integer, 1.0, 4.0, 1.0, 1.0},');
    expect(header).toContain('{"enabled", audiospan::ParameterKind::Boolean, 0.0, 1.0, 1.0, 1.0},');
    expect(header).toContain("using Parameters = audiospan::Parameters<kParamCount>;");
    expect(header).toContain("kOutLevel = 0,");
    expect(header).toContain("kOutputCount = 1");
    expect(header).toContain('constexpr const char* kId = "com.example.gain";');
  });

  it("emits a Rust module with constants and a PARAMETERS table", () => {
    const module = generateRustModule(manifest);
    expect(module).toContain("use crate::abi::{ParameterKind, ParameterSpec};");
    expect(module).toContain("pub const GAIN: u32 = 0;");
    expect(module).toContain("pub const ENABLED: u32 = 3;");
    expect(module).toContain("pub const PARAMETER_COUNT: u32 = 4;");
    expect(module).toContain("pub static PARAMETERS: [ParameterSpec; 4] = [");
    expect(module).toContain('ParameterSpec { id: "gain", kind: ParameterKind::Float, min: 0.0, max: 2.0, default: 1.0, step: 0.01 },');
    expect(module).toContain("pub const OUT_LEVEL: u32 = 0;");
    expect(module).toContain("pub const OUTPUT_COUNT: u32 = 1;");
  });

  it("emits TypeScript declarations with typed ids", () => {
    const types = generateTypes(manifest);
    expect(types).toContain('import type { TypedPluginInstance } from "@audiospan/sdk";');
    expect(types).toContain('export type GainPluginId = "com.example.gain";');
    expect(types).toContain('export type GainParameterId = "gain" | "mode" | "stages" | "enabled";');
    expect(types).toContain('export type GainOutputId = "level";');
    expect(types).toContain('export type GainPresetId = "default";');
    expect(types).toContain("export type GainPlugin = TypedPluginInstance<GainParameterId, GainOutputId, GainPresetId>;");
  });

  it("handles manifests without parameters, outputs or presets", () => {
    const bare = { ...manifest, parameters: [], outputs: [], presets: [] };
    const header = generateCppHeader(bare);
    expect(header).toContain("kParamCount = 0");
    expect(header).not.toContain("kParameters[");
    expect(header).toContain("kOutputCount = 0");
    expect(generateRustModule(bare)).toContain("pub static PARAMETERS: [ParameterSpec; 0] = [");
    const types = generateTypes(bare);
    expect(types).toContain("export type GainParameterId = never;");
    expect(types).toContain("export type GainPresetId = never;");
  });

  it("refuses ids that collide after conversion", () => {
    const first = manifest.parameters[0]!;
    const clash = { ...manifest, parameters: [{ ...first, id: "dry-wet", index: 0 }, { ...first, id: "dry_wet", index: 1 }] };
    expect(() => generateCppHeader(clash)).toThrow(CliError);
    expect(() => generateRustModule(clash)).toThrow(/dry-wet.*dry_wet.*DRY_WET/);
  });
});
