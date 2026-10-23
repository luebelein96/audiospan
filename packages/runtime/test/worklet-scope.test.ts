/**
 * Evaluates the real worklet bundle inside a sandbox that offers exactly what
 * Chromium's AudioWorkletGlobalScope offers: the JavaScript builtins
 * (WebAssembly included), console, registerProcessor, AudioWorkletProcessor,
 * sampleRate/currentTime/currentFrame. No TextDecoder, TextEncoder, fetch,
 * timers, performance, DOM. In a browser, a bundle that touches any of those
 * at module load makes addModule() resolve while the processor never
 * registers; this test turns that into an ordinary unit-test failure.
 */
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { assertManifest } from "@audiospan/manifest";
import { DEFAULT_RUNTIME_CONFIG, PROTOCOL_VERSION, inspectWasmModule, type WorkletToMainMessage } from "../src/index.js";
import { buildFeatureModule } from "../../../tests/fixtures/wasm-builder.js";

const entry = fileURLToPath(new URL("../src/worklet/processor.ts", import.meta.url));
const pluginDir = fileURLToPath(new URL("../../../plugins/gain-cpp/", import.meta.url));
const gainAvailable = existsSync(`${pluginDir}dist/module.wasm`);

interface Port {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

async function bundle(): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser", target: ["es2022"], logLevel: "silent" });
  return result.outputFiles[0]!.text;
}

/** Create the sandbox, evaluate the bundle in it, and return what it registered. */
async function evaluateInWorkletScope() {
  const posted: WorkletToMainMessage[] = [];
  const registered = new Map<string, new () => Processor>();
  class AudioWorkletProcessor {
    port: Port = { postMessage: (m) => posted.push(m as WorkletToMainMessage), onmessage: null, onmessageerror: null };
  }
  const scope = createContext({
    registerProcessor: (name: string, ctor: new () => Processor) => registered.set(name, ctor),
    AudioWorkletProcessor,
    console,
    sampleRate: 48000,
    currentTime: 0,
    currentFrame: 0,
  });
  runInContext(await bundle(), scope, { filename: "audiospan-worklet.js" });
  // The runtime checks `module instanceof ArrayBuffer` against the sandbox realm, so buffers must be created there.
  const toScopeBuffer = (bytes: Uint8Array): ArrayBuffer => {
    const buffer = runInContext(`new ArrayBuffer(${bytes.byteLength})`, scope) as ArrayBuffer;
    new Uint8Array(buffer).set(bytes);
    return buffer;
  };
  return { posted, registered, toScopeBuffer };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function waitFor<T extends WorkletToMainMessage>(posted: WorkletToMainMessage[], predicate: (m: WorkletToMainMessage) => m is T): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const found = posted.find(predicate);
    if (found) return found;
    await settle();
  }
  throw new Error(`message not posted; got ${JSON.stringify(posted)}`);
}
const ofType =
  <K extends WorkletToMainMessage["type"]>(type: K, requestId?: number) =>
  (m: WorkletToMainMessage): m is Extract<WorkletToMainMessage, { type: K }> =>
    m.type === type && (requestId === undefined || ("requestId" in m && m.requestId === requestId));

describe("worklet bundle inside an AudioWorkletGlobalScope-shaped sandbox", () => {
  it("registers the processor without touching APIs the scope lacks", async () => {
    const { registered } = await evaluateInWorkletScope();
    expect([...registered.keys()]).toEqual(["audiospan-processor"]);
  });

  it("initialises, loads a logging plugin and forwards its log line as raw bytes", async () => {
    const { posted, registered, toScopeBuffer } = await evaluateInWorkletScope();
    const processor = new (registered.get("audiospan-processor")!)();
    const send = (data: unknown) => processor.port.onmessage!({ data });
    send({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000, pluginLogging: true } });
    expect(posted[0]).toMatchObject({ type: "READY", requestId: 1 });
    const manifest = assertManifest(JSON.parse(readFileSync(`${pluginDir}plugin.json`, "utf8")));
    const logging = buildFeatureModule({ log: true, outputValue: 0.75 });
    send({ type: "LOAD_PLUGIN", requestId: 2, pluginId: manifest.id, module: toScopeBuffer(logging), manifest, memoryInfo: inspectWasmModule(logging).memory });
    await waitFor(posted, ofType("PLUGIN_READY", 2));
    const log = posted.find(ofType("LOG"));
    expect(log).toBeDefined();
    expect(new TextDecoder().decode(log!.bytes)).toBe("hello");
    send({ type: "CREATE_INSTANCE", requestId: 3, pluginId: manifest.id, instanceId: "f", initialParameters: [] });
    const ready = await waitFor(posted, ofType("INSTANCE_READY", 3));
    expect(ready.latencyFrames).toBe(0);
    send({ type: "REPLACE_CHAIN", requestId: 4, instanceIds: ["f"] });
    await waitFor(posted, ofType("ACK", 4));
    send({ type: "SET_PARAMETER", instanceId: "f", parameterIndex: 0, value: 32, sequence: 1 });
    expect(posted.find(ofType("LATENCY_CHANGED"))).toMatchObject({ instanceId: "f", latencyFrames: 32 });
    const input = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.25)];
    const output = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 13; i++) expect(processor.process([input], [output])).toBe(true);
    expect(posted.find(ofType("OUTPUT_VALUES"))?.values).toEqual([["f", [0.75]]]);
  });

  it.skipIf(!gainAvailable)("processes audio through the compiled gain plugin", async () => {
    const { posted, registered, toScopeBuffer } = await evaluateInWorkletScope();
    const processor = new (registered.get("audiospan-processor")!)();
    const send = (data: unknown) => processor.port.onmessage!({ data });
    send({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, sampleRate: 48000 } });
    const manifest = assertManifest(JSON.parse(readFileSync(`${pluginDir}plugin.json`, "utf8")));
    const bytes = new Uint8Array(readFileSync(`${pluginDir}dist/module.wasm`));
    send({ type: "LOAD_PLUGIN", requestId: 2, pluginId: manifest.id, module: toScopeBuffer(bytes), manifest, memoryInfo: inspectWasmModule(bytes).memory });
    await waitFor(posted, ofType("PLUGIN_READY", 2));
    send({ type: "CREATE_INSTANCE", requestId: 3, pluginId: manifest.id, instanceId: "g" });
    await waitFor(posted, ofType("INSTANCE_READY", 3));
    send({ type: "REPLACE_CHAIN", requestId: 4, instanceIds: ["g"] });
    await waitFor(posted, ofType("ACK", 4));
    send({ type: "SET_PARAMETER", instanceId: "g", parameterIndex: 0, value: 2, sequence: 1 });
    const input = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(-0.25)];
    const output = [new Float32Array(128), new Float32Array(128)];
    for (let i = 0; i < 13; i++) processor.process([input], [output]);
    expect(output[0]![7]).toBeCloseTo(0.5, 6);
    expect(output[1]![7]).toBeCloseTo(-0.5, 6);
    expect(posted.find(ofType("OUTPUT_VALUES"))?.values[0]![1][0]).toBeCloseTo(0.5, 6);
    expect(posted.filter((m) => m.type === "ERROR")).toEqual([]);
  });
});
