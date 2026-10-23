import { describe, expect, it, vi } from "vitest";
import { AudiospanError, AudiospanHost, type PluginInstance } from "../src/index.js";
import { createInProcessRuntime } from "../src/testing.js";
import { buildAbiStubModule, buildFeatureModule } from "../../../tests/fixtures/wasm-builder.js";
import { block, createTestHost, fakeFetch, gainAvailable, gainSource } from "./helpers.js";

describe("AudiospanHost.create", () => {
  it("rejects when the runtime never becomes ready", async () => {
    await expect(
      AudiospanHost.create({ transport: { postMessage() {}, onMessage() {}, close() {} }, sampleRate: 48000, requestTimeoutMs: 50 }),
    ).rejects.toMatchObject({ code: "WORKLET_INIT_FAILED" });
  });

  it("validates options", async () => {
    await expect(AudiospanHost.create({ transport: { postMessage() {}, onMessage() {}, close() {} } })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(AudiospanHost.create({ sampleRate: 48000 })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(AudiospanHost.create({ transport: { postMessage() {}, onMessage() {}, close() {} }, sampleRate: 48000, pluginPolicy: { maxModuleBytes: -1 } })).rejects.toThrow(TypeError);
  });

  it("becomes ready and disposes cleanly", async () => {
    const { host, runtime } = await createTestHost();
    expect(host.status).toBe("ready");
    expect(host.node).toBeNull();
    expect(() => host.connectSource({} as AudioNode)).toThrow(AudiospanError);
    await host.sync();
    await host.dispose();
    expect(host.status).toBe("disposed");
    expect(runtime.runtime.isDisposed).toBe(true);
    await expect(host.loadPlugin("x")).rejects.toMatchObject({ code: "DISPOSED" });
    await host.dispose(); // idempotent
  });
});

describe.skipIf(!gainAvailable)("AudiospanHost with gain-cpp", () => {
  it("loads an inline plugin and exposes a descriptor", async () => {
    const { host, diagnostics } = await createTestHost({ diagnostics: true });
    const descriptor = await host.loadPlugin(gainSource());
    expect(descriptor.id).toBe("dev.audiospan.gain-cpp");
    expect(descriptor.parameters.map((p) => p.id)).toEqual(["gain"]);
    expect(descriptor.presets.map((p) => p.id).sort()).toEqual(["boost", "default", "half"]);
    expect(descriptor.sourceUrl).toBe("test:gain-cpp");
    expect(descriptor.moduleByteLength).toBeGreaterThan(1000);
    expect(host.listPlugins()).toHaveLength(1);
    expect(host.getPlugin(descriptor.id)).toBe(descriptor);
    await expect(host.loadPlugin(gainSource())).rejects.toMatchObject({ code: "PLUGIN_ALREADY_LOADED" });
    const kinds = diagnostics.map((d) => (d as { kind: string }).kind);
    expect(kinds).toContain("plugin-load-start");
    expect(kinds).toContain("plugin-load-success");
    await host.unloadPlugin(descriptor.id);
    expect(host.listPlugins()).toHaveLength(0);
    await host.dispose();
  });

  it("loads a plugin over fetch, resolving module and presets relative to the manifest", async () => {
    const { host } = await createTestHost({ fetch: fakeFetch(), pluginPolicy: { allowedPluginOrigins: ["https://plugins.test"] } });
    const descriptor = await host.loadPlugin("https://plugins.test/gain/plugin.json");
    expect(descriptor.sourceUrl).toBe("https://plugins.test/gain/plugin.json");
    expect(descriptor.presets).toHaveLength(3);
    expect(descriptor.warnings).toEqual([]);
    await host.dispose();
  });

  it("enforces origin, size, and allowlist policies", async () => {
    const { host } = await createTestHost({ fetch: fakeFetch(), pluginPolicy: { allowedPluginOrigins: ["https://other.test"] } });
    await expect(host.loadPlugin("https://plugins.test/gain/plugin.json")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await host.dispose();

    const small = await createTestHost({ fetch: fakeFetch(), pluginPolicy: { allowRemotePlugins: true, maxModuleBytes: 100 } });
    await expect(small.host.loadPlugin("https://plugins.test/gain/plugin.json")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await small.host.dispose();

    const blocked = await createTestHost({ pluginPolicy: { allowPlugin: (m) => (m.id.includes("gain") ? "gain plugins are blocked" : true) } });
    await expect(blocked.host.loadPlugin(gainSource())).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await blocked.host.dispose();

    const lowMemory = await createTestHost({ pluginPolicy: { maxMemoryBytes: 1024 * 1024 } });
    await expect(lowMemory.host.loadPlugin(gainSource())).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await lowMemory.host.dispose();
  });

  it("reports fetch failures and invalid manifests clearly", async () => {
    const { host } = await createTestHost({ fetch: fakeFetch(), pluginPolicy: { allowRemotePlugins: true } });
    await expect(host.loadPlugin("https://plugins.test/missing/plugin.json")).rejects.toMatchObject({ code: "MANIFEST_FETCH_FAILED" });
    const badManifest = fakeFetch("https://plugins.test/gain/", { "https://plugins.test/gain/plugin.json": () => new Response("{ nope", { status: 200 }) });
    const h2 = await createTestHost({ fetch: badManifest, pluginPolicy: { allowRemotePlugins: true } });
    await expect(h2.host.loadPlugin("https://plugins.test/gain/plugin.json")).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    const badModule = fakeFetch("https://plugins.test/gain/", { "https://plugins.test/gain/module.wasm": () => new Response("<html>404</html>", { status: 200 }) });
    const h3 = await createTestHost({ fetch: badModule, pluginPolicy: { allowRemotePlugins: true } });
    await expect(h3.host.loadPlugin("https://plugins.test/gain/plugin.json")).rejects.toMatchObject({ code: "MODULE_INVALID" });
    const source = gainSource();
    const h4 = await createTestHost();
    await expect(h4.host.loadPlugin({ ...source, manifest: { ...source.manifest, id: "bad id" } })).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
    await expect(h4.host.loadPlugin({ ...source, moduleBytes: new Uint8Array([0, 1, 2]) })).rejects.toMatchObject({ code: "MODULE_INVALID" });
    for (const h of [host, h2.host, h3.host, h4.host]) await h.dispose();
  });

  it("creates instances, applies parameters to audio, and clamps", async () => {
    const { host, runtime, diagnostics } = await createTestHost({ diagnostics: true });
    const descriptor = await host.loadPlugin(gainSource());
    const plugin = await host.createPlugin(descriptor.id);
    expect(plugin.status).toBe("ready");
    expect(plugin.channels).toBe(2);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);

    const changes: number[] = [];
    plugin.on("parameterchange", (e) => changes.push(e.value));
    plugin.setParameter("gain", 0.5);
    plugin.setParameter("gain", 5); // clamped to 2
    expect(plugin.getParameter("gain")).toBe(2);
    expect(changes).toEqual([0.5, 2]);
    expect(() => plugin.setParameter("nope", 1)).toThrow(AudiospanError);
    expect(() => plugin.setParameter("gain", Number.NaN)).toThrow(AudiospanError);
    expect(diagnostics.some((d) => (d as { kind: string }).kind === "parameter-clamped")).toBe(true);

    await host.sync();
    const input = block(128, 2, () => 0.25);
    const output = block(128, 2, () => 0);
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5, 6);

    plugin.setParameterNormalized("gain", 0.25);
    expect(plugin.getParameter("gain")).toBe(0.5);
    expect(plugin.getParameterNormalized("gain")).toBe(0.25);
    await host.sync();
    runtime.process(input, output);
    expect(output[1]![5]).toBeCloseTo(0.125, 6);
    await host.dispose();
  });

  it("orders, bypasses, moves and removes plugins in a chain", async () => {
    const { host, runtime } = await createTestHost();
    const descriptor = await host.loadPlugin(gainSource());
    const a = await host.createPlugin(descriptor.id, { instanceId: "a" });
    const b = await host.createPlugin(descriptor.id, { instanceId: "b" });
    const c = await host.createPlugin(descriptor.id, { instanceId: "c" });
    a.setParameter("gain", 2);
    b.setParameter("gain", 2);
    c.setParameter("gain", 0.25);
    const chain = host.createChain();
    chain.add(a);
    chain.add(c);
    chain.add(b, 1);
    expect(chain.getPlugins().map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(() => chain.add(a)).toThrow(AudiospanError);
    await host.connectChain(chain);

    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5 * 2 * 2 * 0.25, 6);

    c.setBypassed(true);
    expect(c.isBypassed()).toBe(true);
    await host.sync();
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(2, 6);

    chain.move("c", 0);
    await chain.flush();
    expect(chain.getPlugins().map((p) => p.id)).toEqual(["c", "a", "b"]);
    chain.remove("a");
    expect(chain.getPlugins().map((p) => p.id)).toEqual(["c", "b"]);
    expect(() => chain.remove("zzz")).toThrow(AudiospanError);
    await host.sync();
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(1, 6);

    // Disposing an instance removes it from the chain automatically.
    await b.dispose();
    expect(b.status).toBe("disposed");
    expect(chain.getPlugins().map((p) => p.id)).toEqual(["c"]);
    await host.sync();
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5, 6);

    await chain.dispose();
    await host.sync();
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5, 6); // empty chain: pass-through
    expect(() => chain.add(c)).toThrow(AudiospanError);
    expect(host.getActiveChain()).toBeNull(); // a disposed chain is no longer the active one
    const replacement = host.createChain();
    replacement.add(c);
    c.setBypassed(false);
    await host.connectChain(replacement);
    expect(host.getActiveChain()).toBe(replacement);
    await host.sync();
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5 * 0.25, 6); // the replacement chain is live
    await host.dispose();
  });

  it("keeps the parameter mirror truthful when an opaque blob changes parameters the state did not list", async () => {
    const { host, runtime } = await createTestHost();
    const descriptor = await host.loadPlugin(gainSource());
    const plugin = await host.createPlugin(descriptor.id);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);
    plugin.setParameter("gain", 1.5);
    const saved = await plugin.getState();
    plugin.setParameter("gain", 0.2);

    const changes: { value: number; source: string }[] = [];
    plugin.on("parameterchange", (e) => changes.push({ value: e.value, source: e.source }));
    await plugin.setState({ ...saved, parameters: {} }); // only the blob carries the gain
    expect(plugin.getParameter("gain")).toBe(1.5);
    expect(changes).toEqual([{ value: 1.5, source: "state" }]);
    expect(await plugin.readParameter("gain")).toBeCloseTo(1.5, 6);
    await host.sync();
    const output = block(128, 2, () => 0);
    runtime.process(block(128, 2, () => 1), output);
    expect(output[0]![0]).toBeCloseTo(plugin.getParameter("gain"), 6);

    // Same for an opaque-only initial state at creation.
    const second = await host.createPlugin(descriptor.id, { initialState: { ...saved, parameters: {} } });
    expect(second.getParameter("gain")).toBe(1.5);
    expect(await second.readParameter("gain")).toBeCloseTo(1.5, 6);
    await host.dispose();
  });

  it("never exceeds maxPlugins under concurrent createPlugin calls", async () => {
    const { host } = await createTestHost({ maxPlugins: 2 });
    const descriptor = await host.loadPlugin(gainSource());
    const results = await Promise.allSettled([host.createPlugin(descriptor.id), host.createPlugin(descriptor.id), host.createPlugin(descriptor.id), host.createPlugin(descriptor.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "INSTANCE_LIMIT" });
    expect(host.listInstances()).toHaveLength(2);
    // Concurrent loads of the same plugin id are refused up front, too.
    await host.dispose();
    const again = await createTestHost();
    const outcomes = await Promise.allSettled([again.host.loadPlugin(gainSource()), again.host.loadPlugin(gainSource())]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    await again.host.dispose();
  });

  it("honours an AbortSignal while loading", async () => {
    const { host } = await createTestHost();
    await expect(host.loadPlugin(gainSource(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });

    const controller = new AbortController();
    const neverResolves: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
      });
    const slow = await createTestHost({ fetch: neverResolves, pluginPolicy: { allowRemotePlugins: true } });
    const loading = slow.host.loadPlugin("https://plugins.test/gain/plugin.json", { signal: controller.signal });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ code: "ABORTED" });
    expect(slow.host.listPlugins()).toHaveLength(0);
    await slow.host.dispose();
    await host.dispose();
  });

  it("abandons an oversize download at the limit even without a Content-Length header", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 50) controller.close();
        else controller.enqueue(new Uint8Array(100));
      },
    });
    const lying = fakeFetch("https://plugins.test/gain/", { "https://plugins.test/gain/module.wasm": () => new Response(stream, { status: 200 }) });
    const { host } = await createTestHost({ fetch: lying, pluginPolicy: { allowRemotePlugins: true, maxModuleBytes: 250 } });
    await expect(host.loadPlugin("https://plugins.test/gain/plugin.json")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(pulled).toBeLessThan(10);
    await host.dispose();
  });

  it("warns on the console when a runtime error has nobody listening", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = createInProcessRuntime();
      const host = await AudiospanHost.create({ transport: runtime.transport, sampleRate: 48000, processErrorBypassThreshold: 1 });
      const source = gainSource();
      const stub = buildAbiStubModule({ audiospan_process: 1 });
      const manifest = { ...source.manifest, id: "dev.audiospan.stub", parameters: [], presets: [], capabilities: { ...(source.manifest["capabilities"] as object), presets: false } };
      const descriptor = await host.loadPlugin({ manifest, moduleBytes: stub });
      const plugin = await host.createPlugin(descriptor.id);
      const chain = host.createChain();
      chain.add(plugin);
      await host.connectChain(chain);
      const input = block(128, 2, () => 0.5);
      const output = block(128, 2, () => 0);
      runtime.process(input, output);
      await runtime.settle();
      expect(plugin.status).toBe("error");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("INSTANCE_ERRORED");

      // An instance-level listener counts as observed: no warning the next time.
      plugin.on("error", () => {});
      await plugin.reset();
      runtime.process(input, output);
      await runtime.settle();
      expect(warn).toHaveBeenCalledTimes(1);
      await host.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("exposes the runtime safety knobs as host options and validates them", async () => {
    const { host } = await createTestHost({ scanNonFinite: true, processErrorBypassThreshold: 7, diagnosticsPerSecond: 50, outputsPerSecond: 10, pluginLogging: true });
    expect(host.config).toMatchObject({ scanNonFinite: true, processErrorBypassThreshold: 7, diagnosticsPerSecond: 50, diagnostics: false, outputsPerSecond: 10, pluginLogging: true });
    await host.dispose();
    const transport = { postMessage() {}, onMessage() {}, close() {} };
    await expect(AudiospanHost.create({ transport, sampleRate: 48000, processErrorBypassThreshold: 0 })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(AudiospanHost.create({ transport, sampleRate: 48000, diagnosticsPerSecond: 1.5 })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    await expect(AudiospanHost.create({ transport, sampleRate: 48000, outputsPerSecond: 500 })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("exposes outputs and latency on descriptors and instances, and streams output values while audio runs", async () => {
    const { host, runtime } = await createTestHost({ outputsPerSecond: 30 });
    const descriptor = await host.loadPlugin(gainSource());
    expect(descriptor.outputs.map((o) => o.id)).toEqual(["level"]);
    expect(descriptor.latencyFrames).toBe(0);
    const plugin = await host.createPlugin(descriptor.id);
    expect(plugin.latencyFrames).toBe(0);
    expect(plugin.getOutput("level")).toBe(0);
    expect(plugin.getOutputs()).toEqual({ level: 0 });
    expect(() => plugin.getOutput("nope")).toThrow(AudiospanError);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);
    plugin.setParameter("gain", 2);
    await host.sync();
    const events: Record<string, number>[] = [];
    plugin.on("outputs", (e) => events.push({ ...e.values }));
    const input = block(128, 2, () => 0.25);
    const output = block(128, 2, () => 0);
    for (let i = 0; i < 13; i++) runtime.process(input, output); // 48000 / 128 / 30 → every 13 blocks
    await runtime.settle();
    expect(events).toHaveLength(1);
    expect(events[0]!["level"]).toBeCloseTo(0.5, 6);
    expect(plugin.getOutput("level")).toBeCloseTo(0.5, 6);
    await host.dispose();
  });

  it("reports latency changes from the plugin and delivers development log lines", async () => {
    const source = gainSource();
    const featureManifest = { ...source.manifest, id: "dev.audiospan.feature", presets: [] };
    const feature = buildFeatureModule({ log: true, outputValue: 0.75 });

    // Without pluginLogging the module's log import is refused up front.
    const strict = await createTestHost();
    await expect(strict.host.loadPlugin({ manifest: featureManifest, moduleBytes: feature })).rejects.toMatchObject({ code: "MODULE_INVALID" });
    await expect(strict.host.loadPlugin({ manifest: featureManifest, moduleBytes: feature })).rejects.toThrow(/audiospan_log/);
    await strict.host.dispose();

    const { host, runtime } = await createTestHost({ pluginLogging: true });
    const hostLogs: string[] = [];
    host.on("pluginlog", (e) => hostLogs.push(`${e.level}:${e.message}:${e.instanceId ?? "-"}`));
    const descriptor = await host.loadPlugin({ manifest: featureManifest, moduleBytes: feature });
    await runtime.settle();
    expect(hostLogs).toEqual(["info:hello:-"]); // logged by the probe instance during load
    const plugin = await host.createPlugin(descriptor.id, { instanceId: "f" });
    const instanceLogs: string[] = [];
    plugin.on("log", (e) => instanceLogs.push(e.message));
    await runtime.settle();
    expect(hostLogs).toEqual(["info:hello:-", "info:hello:f"]);
    expect(instanceLogs).toEqual([]); // the instance listener was attached after creation logged

    // The module reports trunc(gain) as its latency; the default gain of 1 was applied at creation.
    const latencies: number[] = [];
    plugin.on("latencychange", (e) => latencies.push(e.latencyFrames));
    expect(plugin.latencyFrames).toBe(1);
    plugin.setParameter("gain", 2);
    await host.sync();
    expect(plugin.latencyFrames).toBe(2);
    plugin.setParameter("gain", 2); // unchanged: no event
    await host.sync();
    expect(latencies).toEqual([2]);
    await host.dispose();
  });

  it("prints plugin log lines to the console when nobody listens", async () => {
    const source = gainSource();
    const featureManifest = { ...source.manifest, id: "dev.audiospan.feature", presets: [] };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { host, runtime } = await createTestHost({ pluginLogging: true });
      await host.loadPlugin({ manifest: featureManifest, moduleBytes: buildFeatureModule({ log: true }) });
      await runtime.settle();
      expect(info).toHaveBeenCalledTimes(1);
      expect(String(info.mock.calls[0]![0])).toContain("hello");
      await host.dispose();
    } finally {
      info.mockRestore();
    }
  });

  it("saves and restores state, loads presets, and rejects invalid state", async () => {
    const { host, runtime } = await createTestHost();
    const descriptor = await host.loadPlugin(gainSource());
    const plugin = await host.createPlugin(descriptor.id);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);

    plugin.setParameter("gain", 1.5);
    const state = await plugin.getState();
    expect(state).toMatchObject({ schemaVersion: 1, pluginId: descriptor.id, pluginVersion: descriptor.version, parameters: { gain: 1.5 } });
    expect(typeof state.opaqueState).toBe("string");

    const events: string[] = [];
    plugin.on("statechange", (e) => events.push(e.reason + (e.presetId ? `:${e.presetId}` : "")));
    await plugin.loadPreset("half");
    expect(plugin.getParameter("gain")).toBe(0.5);
    await plugin.setState(state);
    expect(plugin.getParameter("gain")).toBe(1.5);
    expect(events).toEqual(["preset:half", "restore"]);
    await host.sync();
    const output = block(128, 2, () => 0);
    runtime.process(block(128, 2, () => 1), output);
    expect(output[0]![0]).toBeCloseTo(1.5, 6);

    await expect(plugin.loadPreset("nope")).rejects.toMatchObject({ code: "PRESET_NOT_FOUND" });
    await expect(plugin.setState({ ...state, pluginId: "other" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(plugin.setState({ ...state, parameters: { gain: 1, extra: 2 } }, { strict: true })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await plugin.setState({ ...state, parameters: { gain: 1, extra: 2 } }); // lenient: ignored
    expect(plugin.getParameter("gain")).toBe(1);
    await expect(plugin.setState({ ...state, opaqueState: "AAAA" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(plugin.getParameter("gain")).toBe(1); // previous state retained

    // Initial state at creation.
    const second = await host.createPlugin(descriptor.id, { initialState: { ...state, parameters: { gain: 0.75 } } });
    expect(second.getParameter("gain")).toBe(0.75);
    chain.add(second);
    await host.sync();
    runtime.process(block(128, 2, () => 1), output);
    expect(output[0]![0]).toBeCloseTo(0.75, 6);

    plugin.resetParameters();
    expect(plugin.getParameter("gain")).toBe(1);
    await plugin.reset();
    await host.dispose();
  });

  it("enforces the instance limit and cleans up listeners on dispose", async () => {
    const { host } = await createTestHost({ maxPlugins: 2 });
    const descriptor = await host.loadPlugin(gainSource());
    const a = await host.createPlugin(descriptor.id);
    const b = await host.createPlugin(descriptor.id);
    await expect(host.createPlugin(descriptor.id)).rejects.toMatchObject({ code: "INSTANCE_LIMIT" });
    await expect(host.unloadPlugin(descriptor.id)).rejects.toMatchObject({ code: "PLUGIN_IN_USE" });

    let calls = 0;
    const off = a.on("parameterchange", () => calls++);
    a.setParameter("gain", 0.1);
    off();
    a.setParameter("gain", 0.2);
    expect(calls).toBe(1);
    const statuses: string[] = [];
    b.on("statuschange", (e) => statuses.push(e.status));
    await host.dispose();
    expect(statuses).toEqual(["disposed"]);
    expect(a.status).toBe("disposed");
    expect(() => a.setParameter("gain", 1)).toThrow(AudiospanError);
    await expect(a.getState()).rejects.toMatchObject({ code: "DISPOSED" });
  });

  it("surfaces processing failures as typed errors and recovers after reset", async () => {
    const { host, runtime, errors } = await createTestHost({ diagnostics: true });
    const source = gainSource();
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const manifest = { ...source.manifest, id: "dev.audiospan.stub", parameters: [], presets: [], capabilities: { ...(source.manifest["capabilities"] as object), presets: false } };
    const descriptor = await host.loadPlugin({ manifest, moduleBytes: stub });
    const plugin = await host.createPlugin(descriptor.id);
    const chain = host.createChain();
    chain.add(plugin);
    await host.connectChain(chain);
    const pluginErrors: AudiospanError[] = [];
    plugin.on("error", (e) => pluginErrors.push(e.error));
    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    for (let i = 0; i < 4; i++) runtime.process(input, output);
    expect(output[0]![0]).toBe(0.5); // pass-through fallback
    await runtime.settle();
    expect(plugin.status).toBe("error");
    expect(pluginErrors.some((e) => e.code === "INSTANCE_ERRORED")).toBe(true);
    expect(errors.some((e) => (e as AudiospanError).code === "INSTANCE_ERRORED")).toBe(true);
    await plugin.reset();
    expect(plugin.status).toBe("ready");
    await host.dispose();
  });

  it("rejects plugins created by another host in a chain", async () => {
    const h1 = await createTestHost();
    const h2 = await createTestHost();
    const d = await h1.host.loadPlugin(gainSource());
    const p: PluginInstance = await h1.host.createPlugin(d.id);
    const chain = h2.host.createChain();
    expect(() => chain.add(p)).toThrow(AudiospanError);
    await expect(h2.host.connectChain(h1.host.createChain())).rejects.toMatchObject({ code: "CHAIN_ERROR" });
    await h1.host.dispose();
    await h2.host.dispose();
  });
});

describe.skipIf(!gainAvailable)("module transfer strategies", () => {
  it("loads via a precompiled module when the transport can clone it", async () => {
    const { host } = await createTestHost({ moduleTransfer: "module" });
    const descriptor = await host.loadPlugin(gainSource());
    expect(descriptor.id).toBe("dev.audiospan.gain-cpp");
    await host.dispose();
  });

  it("falls back to bytes when the worklet reports a clone failure", async () => {
    const { createInProcessRuntime } = await import("../src/testing.js");
    const inner = createInProcessRuntime();
    let moduleAttempts = 0;
    let handler: ((m: import("@audiospan/runtime").WorkletToMainMessage) => void) | null = null;
    inner.transport.onMessage((m) => handler?.(m));
    const transport = {
      postMessage(message: import("@audiospan/runtime").MainToWorkletMessage, transfer?: Transferable[]) {
        if (message.type === "LOAD_PLUGIN" && message.module instanceof WebAssembly.Module) {
          moduleAttempts++;
          // Simulate a browser whose AudioWorklet cannot deserialize a WebAssembly.Module.
          queueMicrotask(() => handler?.({ type: "ERROR", code: "PROTOCOL_CLONE_FAILED", message: "could not deserialize" }));
          return;
        }
        inner.transport.postMessage(message, transfer);
      },
      onMessage(fn: (m: import("@audiospan/runtime").WorkletToMainMessage) => void) {
        handler = fn;
      },
      close() {
        inner.transport.close();
      },
    };
    const errors: Error[] = [];
    const host = await AudiospanHost.create({ transport, sampleRate: 48000, moduleTransfer: "module", onError: (e) => errors.push(e) });
    const descriptor = await host.loadPlugin(gainSource());
    expect(descriptor.id).toBe("dev.audiospan.gain-cpp");
    expect(moduleAttempts).toBe(1);
    expect(errors).toEqual([]); // the clone failure was handled, not surfaced
    const plugin = await host.createPlugin(descriptor.id);
    expect(plugin.status).toBe("ready");
    await host.dispose();
  });
});
