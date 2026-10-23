import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AS_ERROR_INVALID_ARGUMENT, AS_OK, WasmPluginInstance, RuntimeError, inspectWasmModule, validateWasmModuleInfo } from "../src/index.js";
import { ABI_EXPORT_NAMES, buildAbiStubModule, buildFeatureModule, buildStubModule } from "../../../tests/fixtures/wasm-builder.js";

const wasmPath = fileURLToPath(new URL("../../../plugins/gain-cpp/dist/module.wasm", import.meta.url));
const available = existsSync(wasmPath);

describe.skipIf(!available)("WasmPluginInstance (gain-cpp)", () => {
  let bytes: Uint8Array;
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(wasmPath));
  });

  const baseOptions = { sampleRate: 48000, maxFrames: 256, channels: 2, maxMemoryBytes: 16 * 1024 * 1024, maxStateBytes: 1024 * 1024 };

  it("inspects the binary", () => {
    const info = inspectWasmModule(bytes);
    expect(info.memory).toBeDefined();
    expect(info.memory!.imported).toBe(false);
    expect(info.memory!.maximumPages).toBe(256);
    expect(validateWasmModuleInfo(info, { maxMemoryBytes: 16 * 1024 * 1024 })).toEqual([]);
    expect(validateWasmModuleInfo(info, { maxMemoryBytes: 1024 * 1024 }).map((i) => i.code)).toEqual(["MODULE_MEMORY_LIMIT"]);
  });

  it("creates, processes a known buffer, and destroys", async () => {
    const plugin = await WasmPluginInstance.instantiate(bytes, baseOptions);
    expect(plugin.rawHandle).toBeGreaterThan(0);
    const frames = 128;
    const input = [new Float32Array(frames), new Float32Array(frames)];
    const output = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i++) {
      input[0]![i] = Math.sin(i / 10);
      input[1]![i] = -input[0]![i]!;
    }
    expect(plugin.setParameter(0, 0.5)).toBe(AS_OK);
    expect(plugin.getParameter(0)).toBe(0.5);
    expect(plugin.process(input, 2, output, frames)).toBe(AS_OK);
    for (let i = 0; i < frames; i++) {
      expect(output[0]![i]).toBeCloseTo(input[0]![i]! * 0.5, 6);
      expect(output[1]![i]).toBeCloseTo(input[1]![i]! * 0.5, 6);
    }
    plugin.destroy();
    expect(plugin.isDestroyed).toBe(true);
    expect(() => plugin.setParameter(0, 1)).toThrow(RuntimeError);
  });

  it("maps mono input to all channels and silences missing channels", async () => {
    const plugin = await WasmPluginInstance.instantiate(bytes, baseOptions);
    const frames = 64;
    const mono = [new Float32Array(frames).fill(0.25)];
    const output = [new Float32Array(frames), new Float32Array(frames)];
    expect(plugin.process(mono, 1, output, frames)).toBe(AS_OK);
    expect(output[0]!.every((v) => v === 0.25)).toBe(true);
    expect(output[1]!.every((v) => v === 0.25)).toBe(true);
    expect(plugin.process([], 0, output, frames)).toBe(AS_OK);
    expect(output[0]!.every((v) => v === 0)).toBe(true);
    plugin.destroy();
  });

  it("handles varying frame counts and rejects frames above the maximum", async () => {
    const plugin = await WasmPluginInstance.instantiate(bytes, baseOptions);
    for (const frames of [128, 32, 256, 1]) {
      const input = [new Float32Array(frames).fill(1), new Float32Array(frames).fill(1)];
      const output = [new Float32Array(frames), new Float32Array(frames)];
      expect(plugin.process(input, 2, output, frames)).toBe(AS_OK);
      expect(output[1]!.every((v) => v === 1)).toBe(true);
    }
    expect(() => plugin.process([new Float32Array(512), new Float32Array(512)], 2, [new Float32Array(512), new Float32Array(512)], 512)).toThrow(/exceeds/);
    plugin.destroy();
  });

  it("rejects invalid parameter indices and NaN", async () => {
    const plugin = await WasmPluginInstance.instantiate(bytes, baseOptions);
    expect(plugin.setParameter(7, 1)).toBe(AS_ERROR_INVALID_ARGUMENT);
    expect(plugin.setParameter(0, Number.NaN)).toBe(AS_ERROR_INVALID_ARGUMENT);
    expect(() => plugin.getParameter(9)).toThrow(RuntimeError);
    plugin.destroy();
  });

  it("exposes the optional latency and output exports of the reference plugin", async () => {
    const plugin = await WasmPluginInstance.instantiate(bytes, { ...baseOptions, outputCount: 1 });
    expect(plugin.supportsLatency).toBe(true);
    expect(plugin.getLatency()).toBe(0);
    expect(plugin.supportsOutputs).toBe(true);
    expect(plugin.getOutput(0)).toBe(0);
    plugin.setParameter(0, 2);
    const frames = 64;
    const input = [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.5)];
    const output = [new Float32Array(frames), new Float32Array(frames)];
    expect(plugin.process(input, 2, output, frames)).toBe(AS_OK);
    expect(plugin.getOutput(0)).toBeCloseTo(1, 6); // peak |−0.5 × 2|
    expect(() => plugin.getOutput(3)).toThrow(/get_output\(3\)/);
    plugin.destroy();
  });

  it("round-trips state", async () => {
    const a = await WasmPluginInstance.instantiate(bytes, baseOptions);
    const b = await WasmPluginInstance.instantiate(bytes, baseOptions);
    a.setParameter(0, 1.75);
    const state = a.getState();
    expect(state.length).toBe(12);
    expect(b.setState(state)).toBe(AS_OK);
    expect(b.getParameter(0)).toBeCloseTo(1.75, 6);
    expect(b.setState(new Uint8Array([1, 2, 3]))).not.toBe(AS_OK);
    expect(b.getParameter(0)).toBeCloseTo(1.75, 6);
    a.destroy();
    b.destroy();
  });

  it("supports repeated create/destroy cycles in one module", async () => {
    const module = await WebAssembly.compile(bytes);
    const info = inspectWasmModule(bytes);
    for (let i = 0; i < 40; i++) {
      const plugin = await WasmPluginInstance.instantiate(module, { ...baseOptions, memoryInfo: info.memory });
      expect(plugin.reset()).toBe(AS_OK);
      plugin.destroy();
    }
  });

  it("rejects modules with missing exports, bad ABI version, unsupported imports, or unbounded memory", async () => {
    const missing = buildStubModule({ exports: { audiospan_get_abi_version: 1 } });
    await expect(WasmPluginInstance.instantiate(missing, baseOptions)).rejects.toMatchObject({ code: "MODULE_EXPORT_MISSING" });

    const wrongVersion = buildAbiStubModule({ audiospan_get_abi_version: 2 });
    await expect(WasmPluginInstance.instantiate(wrongVersion, baseOptions)).rejects.toMatchObject({ code: "ABI_VERSION_MISMATCH" });

    const badImport = buildStubModule({ exports: Object.fromEntries(ABI_EXPORT_NAMES.map((n) => [n, n === "audiospan_get_abi_version" ? 1 : 0])), imports: [{ module: "env", name: "fetch" }] });
    await expect(WasmPluginInstance.instantiate(badImport, baseOptions)).rejects.toMatchObject({ code: "MODULE_IMPORT_UNSUPPORTED" });

    const unbounded = buildAbiStubModule({}, { min: 1 });
    await expect(WasmPluginInstance.instantiate(unbounded, baseOptions)).rejects.toMatchObject({ code: "MODULE_MEMORY_LIMIT" });

    const noMemory = buildAbiStubModule({}, null);
    await expect(WasmPluginInstance.instantiate(noMemory, baseOptions)).rejects.toMatchObject({ code: "MODULE_MEMORY_INVALID" });

    // alloc returning null must fail cleanly, not crash.
    const nullAlloc = buildAbiStubModule({ audiospan_alloc: 0 });
    await expect(WasmPluginInstance.instantiate(nullAlloc, baseOptions)).rejects.toMatchObject({ code: "ABI_CALL_FAILED" });

    // create returning an error status.
    const createFails = buildAbiStubModule({ audiospan_create: 4 });
    await expect(WasmPluginInstance.instantiate(createFails, baseOptions)).rejects.toMatchObject({ code: "INSTANCE_CREATE_FAILED", status: 4 });
  });

  it("provides host-owned memory when the module imports env.memory and enforces the cap", async () => {
    const imported = buildAbiStubModule({}, { min: 1, imported: true });
    const plugin = await WasmPluginInstance.instantiate(imported, { ...baseOptions, maxMemoryBytes: 65536 * 4 });
    expect(plugin.memoryBytes).toBe(65536);
    plugin.destroy();
    const tooBig = buildAbiStubModule({}, { min: 8, imported: true });
    await expect(WasmPluginInstance.instantiate(tooBig, { ...baseOptions, maxMemoryBytes: 65536 * 4 })).rejects.toMatchObject({ code: "MODULE_MEMORY_LIMIT" });
    const moduleOnly = await WebAssembly.compile(imported);
    await expect(WasmPluginInstance.instantiate(moduleOnly, { ...baseOptions, maxMemoryBytes: 65536 * 4 })).rejects.toMatchObject({ code: "MODULE_MEMORY_INVALID" });
  });

  it("rejects garbage bytes", async () => {
    await expect(WasmPluginInstance.instantiate(new Uint8Array([1, 2, 3, 4]), baseOptions)).rejects.toMatchObject({ code: "MODULE_INVALID" });
  });
});

describe("optional ABI features", () => {
  const baseOptions = { sampleRate: 48000, maxFrames: 128, channels: 2, maxMemoryBytes: 16 * 1024 * 1024, maxStateBytes: 1024 * 1024 };

  it("treats missing optional exports as unsupported, and requires get_output when the manifest declares outputs", async () => {
    const required = Object.fromEntries(ABI_EXPORT_NAMES.map((n) => [n, n === "audiospan_get_abi_version" ? 1 : n === "audiospan_alloc" ? 1024 : 0]));
    const bare = buildStubModule({ exports: required });
    const plugin = await WasmPluginInstance.instantiate(bare, baseOptions);
    expect(plugin.supportsLatency).toBe(false);
    expect(plugin.getLatency()).toBeUndefined();
    expect(plugin.supportsOutputs).toBe(false);
    expect(() => plugin.getOutput(0)).toThrow(RuntimeError);
    plugin.destroy();
    await expect(WasmPluginInstance.instantiate(bare, { ...baseOptions, outputCount: 1 })).rejects.toMatchObject({ code: "MODULE_EXPORT_MISSING" });
    const compiled = await WebAssembly.compile(bare);
    await expect(WasmPluginInstance.instantiate(compiled, { ...baseOptions, outputCount: 1 })).rejects.toMatchObject({ code: "MODULE_EXPORT_MISSING" });
    // AS_ERROR_UNSUPPORTED from an exported get_latency also means "none reported".
    const unsupported = buildAbiStubModule({ audiospan_get_latency: 3 });
    const p2 = await WasmPluginInstance.instantiate(unsupported, baseOptions);
    expect(p2.supportsLatency).toBe(true);
    expect(p2.getLatency()).toBeUndefined();
    p2.destroy();
  });

  it("reads latency and output values that the plugin writes", async () => {
    const plugin = await WasmPluginInstance.instantiate(buildFeatureModule({ outputValue: 0.25 }), { ...baseOptions, outputCount: 1 });
    expect(plugin.getLatency()).toBe(0);
    expect(plugin.setParameter(0, 64)).toBe(AS_OK);
    expect(plugin.getLatency()).toBe(64);
    expect(plugin.getOutput(0)).toBe(0.25);
    plugin.destroy();
  });

  it("grants env.audiospan_log only when allowed and delivers decoded messages", async () => {
    const logging = buildFeatureModule({ log: true });
    const info = inspectWasmModule(logging);
    expect(validateWasmModuleInfo(info, { maxMemoryBytes: 2 ** 24 }).map((i) => i.code)).toEqual(["MODULE_IMPORT_UNSUPPORTED"]);
    expect(validateWasmModuleInfo(info, { maxMemoryBytes: 2 ** 24, allowLogging: true })).toEqual([]);
    await expect(WasmPluginInstance.instantiate(logging, baseOptions)).rejects.toMatchObject({ code: "MODULE_IMPORT_UNSUPPORTED" });
    await expect(WasmPluginInstance.instantiate(await WebAssembly.compile(logging), baseOptions)).rejects.toMatchObject({ code: "MODULE_IMPORT_UNSUPPORTED" });
    const lines: [number, string][] = [];
    const plugin = await WasmPluginInstance.instantiate(logging, { ...baseOptions, allowLogging: true, onLog: (level, bytes) => lines.push([level, new TextDecoder().decode(bytes)]) });
    expect(lines).toEqual([[2, "hello"]]); // logged from audiospan_create; delivered as raw bytes
    plugin.destroy();
    // A throwing listener must not trap the plugin.
    const throwing = await WasmPluginInstance.instantiate(logging, { ...baseOptions, allowLogging: true, onLog: () => { throw new Error("listener"); } });
    throwing.destroy();
  });
});
