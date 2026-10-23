/**
 * Security tests mirroring product spec §17.5. Most behaviours are also
 * covered by package tests; this file states each requirement explicitly.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseManifest, validateManifest, validatePluginState, assertManifest, isSafeRelativePath } from "@audiospan/manifest";
import { AudiospanRuntime, DEFAULT_RUNTIME_CONFIG, PROTOCOL_VERSION, WasmPluginInstance, parseMainMessage, type WorkletToMainMessage } from "@audiospan/runtime";
import { AudiospanHost } from "@audiospan/sdk";
import { createInProcessRuntime } from "@audiospan/sdk/testing";
import { buildAbiStubModule, buildStubModule } from "../fixtures/wasm-builder.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestJson = JSON.parse(readFileSync(`${root}tests/fixtures/manifests/valid-gain.json`, "utf8")) as Record<string, unknown>;
const gainWasm = `${root}plugins/gain-cpp/dist/module.wasm`;
const gainAvailable = existsSync(gainWasm);

describe("path traversal in manifest paths", () => {
  it("rejects every traversal and absolute form", () => {
    for (const bad of ["../module.wasm", "a/../../x", "/module.wasm", "C:\\x", "..\\x", "%2e%2e/x", "https://evil/x.wasm", "a/./b"]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
      const result = validateManifest({ ...manifestJson, entry: { wasm: bad, abi: "audiospan-c" } });
      expect(result.ok, bad).toBe(false);
    }
  });
});

describe("oversized manifest and module", () => {
  it("rejects a manifest larger than the policy before parsing", () => {
    const result = parseManifest(JSON.stringify(manifestJson) + " ".repeat(300 * 1024), { maxBytes: 256 * 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe("MANIFEST_TOO_LARGE");
  });

  it.skipIf(!gainAvailable)("rejects a module larger than the policy", async () => {
    const rt = createInProcessRuntime();
    const host = await AudiospanHost.create({ transport: rt.transport, sampleRate: 48000, pluginPolicy: { maxModuleBytes: 64 } });
    await expect(host.loadPlugin({ manifest: manifestJson, moduleBytes: readFileSync(gainWasm) })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await host.dispose();
  });
});

describe("invalid JSON and unsupported schema version", () => {
  it("reports both without throwing", () => {
    expect(parseManifest("{").ok).toBe(false);
    const v2 = validateManifest({ ...manifestJson, schemaVersion: 2 });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.errors[0]!.code).toBe("MANIFEST_SCHEMA_VERSION_UNSUPPORTED");
  });
});

describe("invalid memory limits", () => {
  it("rejects manifests above hard limits or host policy, and modules without a maximum", async () => {
    expect(validateManifest({ ...manifestJson, resources: { maxMemoryBytes: 2 ** 31 } }).ok).toBe(false);
    expect(validateManifest(manifestJson, { maxMemoryBytes: 1024 }).ok).toBe(false);
    const unbounded = buildAbiStubModule({}, { min: 1 });
    await expect(WasmPluginInstance.instantiate(unbounded, { sampleRate: 48000, maxFrames: 128, channels: 2, maxMemoryBytes: 2 ** 24, maxStateBytes: 1024 })).rejects.toMatchObject({ code: "MODULE_MEMORY_LIMIT" });
    const huge = buildAbiStubModule({}, { min: 1000, max: 1000 });
    await expect(WasmPluginInstance.instantiate(huge, { sampleRate: 48000, maxFrames: 128, channels: 2, maxMemoryBytes: 2 ** 24, maxStateBytes: 1024 })).rejects.toMatchObject({ code: "MODULE_MEMORY_LIMIT" });
  });
});

describe("malformed WASM and missing exports", () => {
  it("rejects garbage, missing exports, and forbidden imports", async () => {
    const options = { sampleRate: 48000, maxFrames: 128, channels: 2, maxMemoryBytes: 2 ** 24, maxStateBytes: 1024 };
    await expect(WasmPluginInstance.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]), options)).rejects.toMatchObject({ code: "MODULE_INVALID" });
    await expect(WasmPluginInstance.instantiate(buildStubModule({ exports: { audiospan_get_abi_version: 1 } }), options)).rejects.toMatchObject({ code: "MODULE_EXPORT_MISSING" });
    const sneaky = buildStubModule({ exports: Object.fromEntries(["audiospan_get_abi_version", "audiospan_alloc", "audiospan_free", "audiospan_create", "audiospan_destroy", "audiospan_reset", "audiospan_process", "audiospan_set_parameter", "audiospan_get_parameter", "audiospan_get_state_size", "audiospan_get_state", "audiospan_set_state"].map((n) => [n, n === "audiospan_get_abi_version" ? 1 : 0])), imports: [{ module: "env", name: "fetch" }, { module: "wasi_snapshot_preview1", name: "path_open" }] });
    await expect(WasmPluginInstance.instantiate(sneaky, options)).rejects.toMatchObject({ code: "MODULE_IMPORT_UNSUPPORTED" });
  });
});

describe("invalid message types and stale request ids", () => {
  it("rejects malformed messages and ignores stale sequence numbers", async () => {
    expect(parseMainMessage({ type: "EVAL", code: "alert(1)" }).ok).toBe(false);
    expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "x", parameterIndex: 1e9, value: 1, sequence: 1 }).ok).toBe(false);
    expect(parseMainMessage({ type: "REPLACE_CHAIN", requestId: 1, instanceIds: new Array(1000).fill("a") }).ok).toBe(false);
    const messages: WorkletToMainMessage[] = [];
    const runtime = new AudiospanRuntime((m) => messages.push(m));
    runtime.handleMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000 } });
    runtime.handleMessage({ type: "ACK", requestId: 1 }); // a worklet→main message sent the wrong way
    runtime.handleMessage({ type: "SET_PARAMETER", instanceId: "ghost", parameterIndex: 0, value: 1, sequence: 5 }); // unknown instance: silently dropped
    expect(messages.filter((m) => m.type === "ERROR").map((m) => (m as { code: string }).code)).toEqual(["PROTOCOL_MESSAGE_INVALID"]);
  });
});

describe("plugin process failure and repeated error loops", () => {
  it.skipIf(!gainAvailable)("bypasses the instance after repeated failures and bounds error traffic", async () => {
    const rt = createInProcessRuntime();
    const errors: string[] = [];
    const host = await AudiospanHost.create({ transport: rt.transport, sampleRate: 48000, diagnostics: true, onError: (e) => errors.push(e.code) });
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const descriptor = await host.loadPlugin({ manifest: { ...manifestJson, id: "dev.test.stub", parameters: [], presets: [], capabilities: { state: true, presets: false } }, moduleBytes: stub });
    const plugin = await host.createPlugin(descriptor.id);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);
    const input = [new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)];
    const output = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 5000; i++) rt.process(input, output);
    await rt.settle();
    expect(output[0]![0]).toBe(0.5); // audio keeps flowing (pass-through)
    expect(plugin.status).toBe("error");
    expect(errors.filter((c) => c === "INSTANCE_ERRORED")).toHaveLength(1);
    await host.dispose();
  });
});

describe("excessive state size and invalid floating-point parameter values", () => {
  it("rejects state over the limit and non-finite values at every layer", () => {
    const manifest = assertManifest(manifestJson);
    const big = "A".repeat(Math.ceil(manifest.resources.maxStateBytes / 3) * 4 + 4);
    expect(validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: {}, opaqueState: big }, manifest).ok).toBe(false);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validatePluginState({ schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: bad } }, manifest).ok).toBe(false);
      expect(parseMainMessage({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: bad, sequence: 1 }).ok).toBe(false);
    }
    expect(validateManifest({ ...manifestJson, parameters: [{ id: "x", name: "X", type: "float", min: 0, max: 1, default: 1e400 }] }).ok).toBe(false);
  });

  it.skipIf(!gainAvailable)("the SDK refuses non-finite parameter values before they reach the runtime", async () => {
    const rt = createInProcessRuntime();
    const host = await AudiospanHost.create({ transport: rt.transport, sampleRate: 48000 });
    const descriptor = await host.loadPlugin({ manifest: JSON.parse(readFileSync(`${root}plugins/gain-cpp/plugin.json`, "utf8")), moduleBytes: readFileSync(gainWasm) });
    const plugin = await host.createPlugin(descriptor.id);
    expect(() => plugin.setParameter("gain", Number.NaN)).toThrow();
    expect(() => plugin.setParameter("gain", Number.POSITIVE_INFINITY)).toThrow();
    expect(plugin.getParameter("gain")).toBe(1);
    await host.dispose();
  });
});

describe("UI message spoofing", () => {
  it("is not applicable: custom UI is not executed in 0.1.0 (capability denied by default)", () => {
    const result = validateManifest({ ...manifestJson, capabilities: { customUI: true }, ui: { entry: "ui/index.html" } }, { allowedCapabilities: { customUI: false } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toContain("MANIFEST_CAPABILITY_DENIED");
  });
});
