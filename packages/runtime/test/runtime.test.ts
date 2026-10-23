import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertManifest, type NormalizedPluginManifest } from "@audiospan/manifest";
import { AudiospanRuntime, DEFAULT_RUNTIME_CONFIG, PROTOCOL_VERSION, copyChannels, inspectWasmModule, type WorkletToMainMessage } from "../src/index.js";
import { buildAbiStubModule, buildFeatureModule } from "../../../tests/fixtures/wasm-builder.js";

const pluginDir = fileURLToPath(new URL("../../../plugins/gain-cpp/", import.meta.url));
const wasmPath = `${pluginDir}dist/module.wasm`;
const available = existsSync(wasmPath);

interface Harness {
  runtime: AudiospanRuntime;
  messages: WorkletToMainMessage[];
  send(message: Record<string, unknown>): void;
  /** Wait until a message satisfying the predicate arrives. */
  waitFor<T extends WorkletToMainMessage>(predicate: (m: WorkletToMainMessage) => m is T, timeoutMs?: number): Promise<T>;
  take(): WorkletToMainMessage[];
}

function createHarness(): Harness {
  const messages: WorkletToMainMessage[] = [];
  const waiters: { predicate: (m: WorkletToMainMessage) => boolean; resolve: (m: WorkletToMainMessage) => void }[] = [];
  const runtime = new AudiospanRuntime((message) => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(message)) {
        const w = waiters.splice(i, 1)[0]!;
        w.resolve(message);
      }
    }
  });
  return {
    runtime,
    messages,
    send: (message) => runtime.handleMessage(message),
    waitFor<T extends WorkletToMainMessage>(predicate: (m: WorkletToMainMessage) => m is T, timeoutMs = 5000): Promise<T> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for message; got ${JSON.stringify(messages)}`)), timeoutMs);
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m as T);
          },
        });
      });
    },
    take: () => messages.splice(0, messages.length),
  };
}

const isType =
  <K extends WorkletToMainMessage["type"]>(type: K, requestId?: number) =>
  (m: WorkletToMainMessage): m is Extract<WorkletToMainMessage, { type: K }> =>
    m.type === type && (requestId === undefined || ("requestId" in m && m.requestId === requestId));

const isError = (requestId?: number) => isType("ERROR", requestId);

let manifest: NormalizedPluginManifest;
let bytes: ArrayBuffer;

async function initialized(options: Partial<typeof DEFAULT_RUNTIME_CONFIG> = {}): Promise<Harness> {
  const h = createHarness();
  h.send({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000, ...options } });
  await h.waitFor(isType("READY"));
  return h;
}

async function withGain(h: Harness, instanceIds: string[], pluginId = manifest.id): Promise<void> {
  h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId, module: bytes.slice(0), manifest: { ...manifest, id: pluginId }, memoryInfo: inspectWasmModule(new Uint8Array(bytes)).memory });
  await h.waitFor(isType("PLUGIN_READY", 10));
  let rid = 100;
  for (const id of instanceIds) {
    h.send({ type: "CREATE_INSTANCE", requestId: ++rid, pluginId, instanceId: id });
    await h.waitFor(isType("INSTANCE_READY", rid));
  }
  h.send({ type: "REPLACE_CHAIN", requestId: 50, instanceIds });
  await h.waitFor(isType("ACK", 50));
}

function block(frames: number, channels: number, fill: (i: number, c: number) => number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => fill(i, c)));
}

describe("copyChannels", () => {
  it("maps mono to all, 1:1 otherwise, and silences the rest", () => {
    const out = block(4, 2, () => 9);
    copyChannels(block(4, 1, (i) => i), 1, out, 2, 4);
    expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
    expect(Array.from(out[1]!)).toEqual([0, 1, 2, 3]);
    copyChannels([], 0, out, 2, 4);
    expect(Array.from(out[1]!)).toEqual([0, 0, 0, 0]);
    const three = block(4, 2, () => 9);
    copyChannels(block(4, 3, (i, c) => c * 10 + i), 3, three, 2, 4);
    expect(Array.from(three[1]!)).toEqual([10, 11, 12, 13]);
  });
});

describe("AudiospanRuntime protocol", () => {
  it("requires INIT before anything else and rejects a second INIT", async () => {
    const h = createHarness();
    h.send({ type: "PING", requestId: 5 });
    const err = await h.waitFor(isError(5));
    expect(err.code).toBe("RUNTIME_NOT_INITIALIZED");
    h.send({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000 } });
    await h.waitFor(isType("READY"));
    h.send({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 2, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000 } });
    expect((await h.waitFor(isError(2))).code).toBe("RUNTIME_ALREADY_INITIALIZED");
  });

  it("rejects unsupported protocol versions and malformed messages", async () => {
    const h = createHarness();
    h.send({ type: "INIT", protocolVersion: 99, requestId: 1, config: {} });
    expect((await h.waitFor(isError(1))).code).toBe("PROTOCOL_MESSAGE_INVALID");
    h.send({ type: "NOPE" });
    expect(h.messages.filter((m) => m.type === "ERROR")).toHaveLength(2);
  });

  it("passes audio through untouched when the chain is empty", async () => {
    const h = await initialized();
    const input = block(128, 2, (i, c) => (c === 0 ? i / 128 : -i / 128));
    const output = block(128, 2, () => 7);
    expect(h.runtime.process(input, output)).toBe(true);
    expect(Array.from(output[0]!)).toEqual(Array.from(input[0]!));
    expect(Array.from(output[1]!)).toEqual(Array.from(input[1]!));
    const silent = block(128, 2, () => 7);
    h.runtime.process([], silent);
    expect(silent[0]!.every((v) => v === 0)).toBe(true);
  });

  it("stops after DISPOSE and refuses further messages", async () => {
    const h = await initialized();
    h.send({ type: "DISPOSE", requestId: 3 });
    await h.waitFor(isType("ACK", 3));
    expect(h.runtime.process([], block(128, 2, () => 0))).toBe(false);
    h.send({ type: "PING", requestId: 4 });
    expect((await h.waitFor(isError(4))).code).toBe("RUNTIME_DISPOSED");
  });
});

describe.skipIf(!available)("AudiospanRuntime with gain-cpp", () => {
  beforeAll(() => {
    manifest = assertManifest(JSON.parse(readFileSync(`${pluginDir}plugin.json`, "utf8")));
    const buf = readFileSync(wasmPath);
    bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  it("loads, creates, processes and reports errors for bad ids", async () => {
    const h = await initialized({ diagnostics: true });
    await withGain(h, ["g1"]);
    h.send({ type: "SET_PARAMETER", instanceId: "g1", parameterIndex: 0, value: 0.5, sequence: 1 });
    const input = block(128, 2, (i) => Math.sin(i * 0.1));
    const output = block(128, 2, () => 0);
    h.runtime.process(input, output);
    for (let i = 0; i < 128; i++) expect(output[1]![i]).toBeCloseTo(input[1]![i]! * 0.5, 6);

    h.send({ type: "GET_PARAMETER", requestId: 60, instanceId: "g1", parameterIndex: 0 });
    expect((await h.waitFor(isType("PARAMETER_VALUE", 60))).value).toBe(0.5);

    h.send({ type: "CREATE_INSTANCE", requestId: 61, pluginId: "nope", instanceId: "x" });
    expect((await h.waitFor(isError(61))).code).toBe("PLUGIN_NOT_LOADED");
    h.send({ type: "RESET", requestId: 62, instanceId: "missing" });
    expect((await h.waitFor(isError(62))).code).toBe("INSTANCE_NOT_FOUND");
    h.send({ type: "GET_PARAMETER", requestId: 63, instanceId: "g1", parameterIndex: 5 });
    expect((await h.waitFor(isError(63))).code).toBe("PARAMETER_INDEX_INVALID");
    h.send({ type: "REPLACE_CHAIN", requestId: 64, instanceIds: ["g1", "g1"] });
    expect((await h.waitFor(isError(64))).code).toBe("PROTOCOL_MESSAGE_INVALID");
    expect(h.messages.some((m) => m.type === "DIAGNOSTIC" && m.event.kind === "plugin-instance-created")).toBe(true);
  });

  it("chains plugins in order, applies bypass, and keeps processing after destroy", async () => {
    const h = await initialized();
    await withGain(h, ["a", "b", "c"]);
    h.send({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 2, sequence: 1 });
    h.send({ type: "SET_PARAMETER", instanceId: "b", parameterIndex: 0, value: 2, sequence: 1 });
    h.send({ type: "SET_PARAMETER", instanceId: "c", parameterIndex: 0, value: 0.25, sequence: 1 });
    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    h.runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5 * 2 * 2 * 0.25, 6);

    h.send({ type: "SET_BYPASS", instanceId: "c", bypassed: true, sequence: 1 });
    h.runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(2, 6);

    // Stale bypass update is ignored.
    h.send({ type: "SET_BYPASS", instanceId: "c", bypassed: false, sequence: 0 });
    h.runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(2, 6);

    h.send({ type: "REPLACE_CHAIN", requestId: 70, instanceIds: ["c", "a"] });
    await h.waitFor(isType("ACK", 70));
    h.runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5 * 2, 6); // c bypassed, a doubles

    h.send({ type: "DESTROY_INSTANCE", requestId: 71, instanceId: "a" });
    await h.waitFor(isType("ACK", 71));
    expect(h.runtime.activePluginCount).toBe(1);
    h.runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.5, 6);

    h.send({ type: "UNLOAD_PLUGIN", requestId: 72, pluginId: manifest.id });
    expect((await h.waitFor(isError(72))).code).toBe("PLUGIN_IN_USE");
  });

  it("enforces the instance limit", async () => {
    const h = await initialized({ maxPlugins: 2 });
    await withGain(h, ["a", "b"]);
    h.send({ type: "CREATE_INSTANCE", requestId: 80, pluginId: manifest.id, instanceId: "c" });
    expect((await h.waitFor(isError(80))).code).toBe("INSTANCE_LIMIT");
  });

  it("round-trips state through GET_STATE / SET_STATE and rejects bad state", async () => {
    const h = await initialized();
    await withGain(h, ["a", "b"]);
    h.send({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 1.5, sequence: 1 });
    h.send({ type: "GET_STATE", requestId: 90, instanceId: "a" });
    const state = await h.waitFor(isType("STATE", 90));
    expect(state.opaque.byteLength).toBe(12);
    h.send({ type: "SET_STATE", requestId: 91, instanceId: "b", parameters: [], opaque: state.opaque });
    // The reply reports every parameter as the plugin now holds it, including ones only the blob set.
    const applied = await h.waitFor(isType("STATE_APPLIED", 91));
    expect(applied.instanceId).toBe("b");
    expect(applied.parameters).toHaveLength(1);
    expect(applied.parameters[0]).toBeCloseTo(1.5, 6);
    h.send({ type: "GET_PARAMETER", requestId: 92, instanceId: "b", parameterIndex: 0 });
    expect((await h.waitFor(isType("PARAMETER_VALUE", 92))).value).toBeCloseTo(1.5, 6);

    // Parameters in SET_STATE win over the opaque blob.
    h.send({ type: "SET_STATE", requestId: 93, instanceId: "b", parameters: [[0, 0.25]], opaque: state.opaque.slice(0) });
    expect((await h.waitFor(isType("STATE_APPLIED", 93))).parameters[0]).toBeCloseTo(0.25, 6);
    h.send({ type: "GET_PARAMETER", requestId: 94, instanceId: "b", parameterIndex: 0 });
    expect((await h.waitFor(isType("PARAMETER_VALUE", 94))).value).toBeCloseTo(0.25, 6);

    h.send({ type: "SET_STATE", requestId: 95, instanceId: "b", parameters: [], opaque: new Uint8Array([1, 2, 3]).buffer });
    expect((await h.waitFor(isError(95))).code).toBe("STATE_REJECTED");
    h.send({ type: "GET_PARAMETER", requestId: 97, instanceId: "b", parameterIndex: 0 });
    expect((await h.waitFor(isType("PARAMETER_VALUE", 97))).value).toBeCloseTo(0.25, 6); // rejected state leaves the instance untouched
    h.send({ type: "SET_STATE", requestId: 96, instanceId: "b", parameters: [[9, 1]] });
    expect((await h.waitFor(isError(96))).code).toBe("PARAMETER_INDEX_INVALID");
  });

  it("restores the previous values when a parameter inside SET_STATE is refused", async () => {
    const h = await initialized();
    // A stub whose set_parameter always fails; create it without initial parameters so creation succeeds.
    const stub = buildAbiStubModule({ audiospan_set_parameter: 2 });
    const stubManifest = { ...manifest, id: "dev.audiospan.stub", presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: "dev.audiospan.stub", module: stub.buffer.slice(stub.byteOffset, stub.byteOffset + stub.byteLength), manifest: stubManifest });
    await h.waitFor(isType("PLUGIN_READY", 10));
    h.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.stub", instanceId: "s", initialParameters: [] });
    await h.waitFor(isType("INSTANCE_READY", 11));
    h.send({ type: "SET_STATE", requestId: 12, instanceId: "s", parameters: [[0, 1]], opaque: new ArrayBuffer(4) });
    const err = await h.waitFor(isError(12));
    expect(err.code).toBe("ABI_CALL_FAILED");
    // The rollback path ran without masking the error and the instance is still usable.
    h.send({ type: "GET_PARAMETER", requestId: 13, instanceId: "s", parameterIndex: 0 });
    await h.waitFor(isType("PARAMETER_VALUE", 13));
  });

  it("re-checks the instance limit after asynchronous instantiation", async () => {
    const h = await initialized({ maxPlugins: 1 });
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: manifest.id, module: bytes.slice(0), manifest, memoryInfo: inspectWasmModule(new Uint8Array(bytes)).memory });
    await h.waitFor(isType("PLUGIN_READY", 10));
    // Both requests pass the pre-await check; only one may survive.
    h.send({ type: "CREATE_INSTANCE", requestId: 101, pluginId: manifest.id, instanceId: "a" });
    h.send({ type: "CREATE_INSTANCE", requestId: 102, pluginId: manifest.id, instanceId: "b" });
    await Promise.all([h.waitFor(isType("INSTANCE_READY")), h.waitFor(isError())]);
    expect(h.messages.filter((m) => m.type === "INSTANCE_READY")).toHaveLength(1);
    expect(h.messages.filter((m) => m.type === "ERROR").map((m) => m.code)).toEqual(["INSTANCE_LIMIT"]);
  });

  it("feeds each stage from the previous plugin's output and passes bypassed or failing stages through", async () => {
    const h = await initialized({ processErrorBypassThreshold: 1_000_000 });
    await withGain(h, ["a", "b", "c"]);
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const stubManifest = { ...manifest, id: "dev.audiospan.stub", parameters: [], presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 20, pluginId: "dev.audiospan.stub", module: stub.buffer.slice(stub.byteOffset, stub.byteOffset + stub.byteLength), manifest: stubManifest });
    await h.waitFor(isType("PLUGIN_READY", 20));
    h.send({ type: "CREATE_INSTANCE", requestId: 21, pluginId: "dev.audiospan.stub", instanceId: "s" });
    await h.waitFor(isType("INSTANCE_READY", 21));
    h.send({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 2, sequence: 1 });
    h.send({ type: "SET_PARAMETER", instanceId: "b", parameterIndex: 0, value: 0.25, sequence: 1 });
    h.send({ type: "SET_PARAMETER", instanceId: "c", parameterIndex: 0, value: 8, sequence: 1 }); // bypassed below: must not apply
    h.send({ type: "SET_BYPASS", instanceId: "c", bypassed: true, sequence: 1 });
    // gain ×2 → failing stub (pass-through) → bypassed gain (pass-through) → gain ×0.25
    h.send({ type: "REPLACE_CHAIN", requestId: 22, instanceIds: ["a", "s", "c", "b"] });
    await h.waitFor(isType("ACK", 22));
    const input = block(128, 2, (i, ch) => (ch === 0 ? 0.5 : -0.5));
    const output = block(128, 2, () => 0);
    h.runtime.process(input, output);
    for (let i = 0; i < 128; i++) {
      expect(output[0]![i]).toBeCloseTo(0.5 * 2 * 0.25, 6);
      expect(output[1]![i]).toBeCloseTo(-0.5 * 2 * 0.25, 6);
    }
  });

  it("posts INSTANCE_ERRORED even when diagnostics have exhausted the token bucket", async () => {
    const h = await initialized({ diagnostics: true, diagnosticsPerSecond: 1, processErrorBypassThreshold: 3 });
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const stubManifest = { ...manifest, id: "dev.audiospan.stub", parameters: [], presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: "dev.audiospan.stub", module: stub.buffer.slice(stub.byteOffset, stub.byteOffset + stub.byteLength), manifest: stubManifest });
    await h.waitFor(isType("PLUGIN_READY", 10));
    h.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.stub", instanceId: "s" });
    await h.waitFor(isType("INSTANCE_READY", 11));
    h.send({ type: "REPLACE_CHAIN", requestId: 12, instanceIds: ["s"] });
    await h.waitFor(isType("ACK", 12));
    // The single diagnostics token went to worklet-initialized; every later diagnostic is dropped.
    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    for (let i = 0; i < 5; i++) h.runtime.process(input, output);
    expect(h.messages.filter((m) => m.type === "DIAGNOSTIC").map((m) => m.event.kind)).toEqual(["worklet-initialized"]);
    expect(h.messages.filter((m) => m.type === "ERROR").map((m) => m.code)).toEqual(["INSTANCE_ERRORED"]);
  });

  it("rejects a plugin whose manifest needs more frames or channels than configured", async () => {
    const h = await initialized({ maxFrames: 8192 });
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: manifest.id, module: bytes.slice(0), manifest });
    expect((await h.waitFor(isError(10))).code).toBe("FRAMES_UNSUPPORTED");

    const h2 = await initialized({ maxChannels: 1 });
    const needsStereo = { ...manifest, audio: { ...manifest.audio, outputs: [{ id: "out", name: "Out", channels: { min: 2, max: 2 } }] } };
    h2.send({ type: "LOAD_PLUGIN", requestId: 11, pluginId: manifest.id, module: bytes.slice(0), manifest: needsStereo });
    expect((await h2.waitFor(isError(11))).code).toBe("CHANNELS_UNSUPPORTED");
  });

  it("passes through when frames exceed the configured maximum", async () => {
    const h = await initialized({ maxFrames: 128, diagnostics: true });
    await withGain(h, ["a"]);
    h.send({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 0, sequence: 1 });
    const input = block(256, 2, () => 0.5);
    const output = block(256, 2, () => 0);
    h.runtime.process(input, output);
    expect(output[0]![0]).toBe(0.5);
    expect(h.messages.some((m) => m.type === "DIAGNOSTIC" && m.event.kind === "frames-unsupported")).toBe(true);
  });

  it("bypasses a failing plugin after repeated errors and recovers on RESET", async () => {
    const h = await initialized({ diagnostics: true, processErrorBypassThreshold: 2 });
    // A stub module whose process export always returns AS_ERROR_GENERIC.
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const stubManifest = { ...manifest, id: "dev.audiospan.stub", parameters: [], presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: "dev.audiospan.stub", module: stub.buffer.slice(stub.byteOffset, stub.byteOffset + stub.byteLength), manifest: stubManifest });
    await h.waitFor(isType("PLUGIN_READY", 10));
    h.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.stub", instanceId: "s" });
    await h.waitFor(isType("INSTANCE_READY", 11));
    h.send({ type: "REPLACE_CHAIN", requestId: 12, instanceIds: ["s"] });
    await h.waitFor(isType("ACK", 12));

    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    h.runtime.process(input, output);
    expect(output[0]![0]).toBe(0.5); // pass-through fallback for the failed block
    h.runtime.process(input, output);
    const errored = h.messages.find((m) => m.type === "ERROR" && m.code === "INSTANCE_ERRORED");
    expect(errored).toBeDefined();
    const diag = h.messages.filter((m) => m.type === "DIAGNOSTIC" && m.event.kind === "audio-processing-error");
    expect(diag.length).toBeGreaterThanOrEqual(2);

    h.take();
    h.runtime.process(input, output); // errored => bypassed, no further diagnostics
    expect(h.messages.filter((m) => m.type === "DIAGNOSTIC" && m.event.kind === "audio-processing-error")).toHaveLength(0);

    h.send({ type: "RESET", requestId: 13, instanceId: "s" });
    await h.waitFor(isType("ACK", 13));
    h.runtime.process(input, output);
    expect(h.messages.filter((m) => m.type === "DIAGNOSTIC" && m.event.kind === "audio-processing-error")).toHaveLength(1);
  });

  it("rate-limits unsolicited diagnostics", async () => {
    const h = await initialized({ diagnostics: true, diagnosticsPerSecond: 5, processErrorBypassThreshold: 1_000_000 });
    const stub = buildAbiStubModule({ audiospan_process: 1 });
    const stubManifest = { ...manifest, id: "dev.audiospan.stub", parameters: [], presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: "dev.audiospan.stub", module: stub.buffer.slice(stub.byteOffset, stub.byteOffset + stub.byteLength), manifest: stubManifest });
    await h.waitFor(isType("PLUGIN_READY", 10));
    h.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.stub", instanceId: "s" });
    await h.waitFor(isType("INSTANCE_READY", 11));
    h.send({ type: "REPLACE_CHAIN", requestId: 12, instanceIds: ["s"] });
    await h.waitFor(isType("ACK", 12));
    h.take();
    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    for (let i = 0; i < 1000; i++) h.runtime.process(input, output);
    const posted = h.messages.filter((m) => m.type === "DIAGNOSTIC").length;
    expect(posted).toBeLessThanOrEqual(6);
  });

  it("reports the initial latency and polls output values at the configured rate", async () => {
    const h = await initialized({ outputsPerSecond: 30 });
    await withGain(h, ["a"]);
    const ready = h.messages.find((m): m is Extract<WorkletToMainMessage, { type: "INSTANCE_READY" }> => m.type === "INSTANCE_READY");
    expect(ready?.latencyFrames).toBe(0);
    expect(manifest.outputs.map((o) => o.id)).toEqual(["level"]);
    h.send({ type: "SET_PARAMETER", instanceId: "a", parameterIndex: 0, value: 2, sequence: 1 });
    const input = block(128, 2, () => 0.25);
    const output = block(128, 2, () => 0);
    // 48000 / 128 / 30 ≈ 12.5 blocks between polls → one OUTPUT_VALUES per 13 blocks.
    for (let i = 0; i < 12; i++) h.runtime.process(input, output);
    expect(h.messages.filter((m) => m.type === "OUTPUT_VALUES")).toHaveLength(0);
    h.runtime.process(input, output);
    const values = h.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "OUTPUT_VALUES" }> => m.type === "OUTPUT_VALUES");
    expect(values).toHaveLength(1);
    expect(values[0]!.values).toHaveLength(1);
    expect(values[0]!.values[0]![0]).toBe("a");
    expect(values[0]!.values[0]![1][0]).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 13; i++) h.runtime.process(input, output);
    expect(h.messages.filter((m) => m.type === "OUTPUT_VALUES")).toHaveLength(2);
    // outputsPerSecond: 0 disables polling.
    const off = await initialized({ outputsPerSecond: 0 });
    await withGain(off, ["a"]);
    for (let i = 0; i < 50; i++) off.runtime.process(input, output);
    expect(off.messages.filter((m) => m.type === "OUTPUT_VALUES")).toHaveLength(0);
  });

  it("posts LATENCY_CHANGED when a parameter change moves the reported latency, and stops polling failing outputs", async () => {
    const h = await initialized({ outputsPerSecond: 120 });
    const feature = buildFeatureModule({ outputValue: 0.75 });
    const featureManifest = { ...manifest, id: "dev.audiospan.feature", presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 10, pluginId: "dev.audiospan.feature", module: feature.buffer.slice(feature.byteOffset, feature.byteOffset + feature.byteLength), manifest: featureManifest });
    await h.waitFor(isType("PLUGIN_READY", 10));
    h.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.feature", instanceId: "f", initialParameters: [] });
    const ready = await h.waitFor(isType("INSTANCE_READY", 11));
    expect(ready.latencyFrames).toBe(0);
    h.send({ type: "SET_PARAMETER", instanceId: "f", parameterIndex: 0, value: 64, sequence: 1 });
    const changed = h.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "LATENCY_CHANGED" }> => m.type === "LATENCY_CHANGED");
    expect(changed).toEqual([{ type: "LATENCY_CHANGED", instanceId: "f", latencyFrames: 64 }]);
    h.send({ type: "SET_PARAMETER", instanceId: "f", parameterIndex: 0, value: 64.9, sequence: 2 }); // same latency (truncated): no second message
    expect(h.messages.filter((m) => m.type === "LATENCY_CHANGED")).toHaveLength(1);
    h.send({ type: "REPLACE_CHAIN", requestId: 12, instanceIds: ["f"] });
    await h.waitFor(isType("ACK", 12));
    const input = block(128, 2, () => 0.25);
    const output = block(128, 2, () => 0);
    for (let i = 0; i < 4; i++) h.runtime.process(input, output);
    const values = h.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "OUTPUT_VALUES" }> => m.type === "OUTPUT_VALUES");
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]!.values).toEqual([["f", [0.75]]]);

    // A module whose get_output fails is reported once and no longer polled.
    const broken = buildAbiStubModule({ audiospan_get_output: 2 });
    const brokenManifest = { ...manifest, id: "dev.audiospan.broken", presets: [] };
    h.send({ type: "LOAD_PLUGIN", requestId: 20, pluginId: "dev.audiospan.broken", module: broken.buffer.slice(broken.byteOffset, broken.byteOffset + broken.byteLength), manifest: brokenManifest });
    await h.waitFor(isType("PLUGIN_READY", 20));
    h.send({ type: "CREATE_INSTANCE", requestId: 21, pluginId: "dev.audiospan.broken", instanceId: "b", initialParameters: [] });
    await h.waitFor(isType("INSTANCE_READY", 21));
    h.take();
    for (let i = 0; i < 8; i++) h.runtime.process(input, output);
    const errors = h.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "ERROR" }> => m.type === "ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "ABI_CALL_FAILED", instanceId: "b" });
    expect(h.messages.filter((m) => m.type === "OUTPUT_VALUES").every((m) => m.type === "OUTPUT_VALUES" && m.values.every(([id]) => id !== "b"))).toBe(true);
  });

  it("forwards development-build log lines only when pluginLogging is on, rate limited", async () => {
    const logging = buildFeatureModule({ log: true });
    const logManifest = { ...manifest, id: "dev.audiospan.logging", presets: [] };
    const load = (h: Harness, requestId: number) =>
      h.send({ type: "LOAD_PLUGIN", requestId, pluginId: "dev.audiospan.logging", module: logging.buffer.slice(logging.byteOffset, logging.byteOffset + logging.byteLength), manifest: logManifest });

    const off = await initialized();
    load(off, 10);
    const refused = await off.waitFor(isError(10));
    expect(refused.code).toBe("MODULE_IMPORT_UNSUPPORTED");
    expect(refused.message).toContain("audiospan_log");

    const on = await initialized({ pluginLogging: true });
    load(on, 10);
    await on.waitFor(isType("PLUGIN_READY", 10));
    const probeLog = on.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "LOG" }> => m.type === "LOG");
    expect(probeLog).toHaveLength(1);
    expect(probeLog[0]).toMatchObject({ type: "LOG", pluginId: "dev.audiospan.logging", level: 2, dropped: 0 });
    expect(probeLog[0]!.instanceId).toBeUndefined();
    expect(new TextDecoder().decode(probeLog[0]!.bytes)).toBe("hello"); // raw UTF-8: the worklet scope cannot decode
    on.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.logging", instanceId: "l", initialParameters: [] });
    await on.waitFor(isType("INSTANCE_READY", 11));
    const logs = on.messages.filter((m): m is Extract<WorkletToMainMessage, { type: "LOG" }> => m.type === "LOG");
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ instanceId: "l" });
    expect(new TextDecoder().decode(logs[1]!.bytes)).toBe("hello");

    // With one token per second, the probe's line uses the token and the instance's line is dropped.
    const limited = await initialized({ pluginLogging: true, diagnosticsPerSecond: 1 });
    load(limited, 10);
    await limited.waitFor(isType("PLUGIN_READY", 10));
    limited.send({ type: "CREATE_INSTANCE", requestId: 11, pluginId: "dev.audiospan.logging", instanceId: "l", initialParameters: [] });
    await limited.waitFor(isType("INSTANCE_READY", 11));
    expect(limited.messages.filter((m) => m.type === "LOG")).toHaveLength(1);
  });

  it("does not allocate typed arrays in the steady-state hot path", async () => {
    const h = await initialized();
    await withGain(h, ["a", "b"]);
    const input = block(128, 2, () => 0.5);
    const output = block(128, 2, () => 0);
    h.runtime.process(input, output); // warm up views
    const original = globalThis.Float32Array;
    let constructed = 0;
    const Spy = new Proxy(original, {
      construct(target, args, newTarget) {
        constructed++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    globalThis.Float32Array = Spy as unknown as Float32ArrayConstructor;
    try {
      for (let i = 0; i < 100; i++) h.runtime.process(input, output);
    } finally {
      globalThis.Float32Array = original;
    }
    expect(constructed).toBe(0);
  });
});
