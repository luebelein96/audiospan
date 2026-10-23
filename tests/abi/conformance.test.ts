/**
 * ABI conformance suite. Runs against every built reference plugin
 * (plugins/<name>/dist/module.wasm). C++ and Rust implementations must pass
 * identical checks and produce identical output for the shared vectors.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertManifest } from "@audiospan/manifest";
import {
  ABI_VERSION,
  AS_ERROR_BUFFER_TOO_SMALL,
  AS_ERROR_INVALID_ARGUMENT,
  AS_ERROR_INVALID_FORMAT,
  AS_OK,
  HOST_CONFIG_STRUCT_SIZE,
  PROCESS_STRUCT_SIZE,
  REQUIRED_FUNCTION_EXPORTS,
  WasmPluginInstance,
  inspectWasmModule,
} from "@audiospan/runtime";
import { runGenericChecks, runVectorCases, type VectorFile } from "@audiospan/cli";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(root, "tests/fixtures/gain-vectors.json"), "utf8")) as VectorFile;

const plugins = readdirSync(resolve(root, "plugins"))
  .map((name) => ({ name, dir: resolve(root, "plugins", name, "dist") }))
  .filter((p) => existsSync(resolve(p.dir, "module.wasm")) && existsSync(resolve(p.dir, "plugin.json")));

if (plugins.length === 0) console.warn("no built reference plugins found; run `pnpm build:wasm` first");

/** Raw access to the exports for low-level ABI checks the bridge never performs. */
async function rawInstance(bytes: Uint8Array) {
  const module = await WebAssembly.compile(bytes);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(module)) (imports[imp.module] ??= {})[imp.name] = imp.name === "proc_exit" ? () => { throw new Error("exit"); } : () => 0;
  const instance = await WebAssembly.instantiate(module, imports as WebAssembly.Imports);
  const ex = instance.exports as Record<string, CallableFunction> & { memory: WebAssembly.Memory };
  (ex["_initialize"] as (() => void) | undefined)?.();
  const alloc = (size: number, align = 8) => ex["audiospan_alloc"]!(size, align) as number;
  const u32 = () => new Uint32Array(ex.memory.buffer);
  const create = (structSize = HOST_CONFIG_STRUCT_SIZE) => {
    const cfg = alloc(32);
    u32().set([structSize, 48000, 128, 2, 2], cfg >> 2);
    const out = alloc(4);
    const status = ex["audiospan_create"]!(cfg, out) as number;
    return { status, handle: u32()[out >> 2]! };
  };
  return { ex, alloc, u32, create };
}

for (const plugin of plugins) {
  describe(`ABI conformance: ${plugin.name}`, () => {
    let bytes: Uint8Array;
    let manifest: ReturnType<typeof assertManifest>;
    beforeAll(() => {
      bytes = new Uint8Array(readFileSync(resolve(plugin.dir, "module.wasm")));
      manifest = assertManifest(JSON.parse(readFileSync(resolve(plugin.dir, "plugin.json"), "utf8")));
    });

    it("exports every required function and a bounded exported memory", () => {
      const info = inspectWasmModule(bytes);
      const names = new Set(info.exports.filter((e) => e.kind === "function").map((e) => e.name));
      for (const name of REQUIRED_FUNCTION_EXPORTS) expect(names.has(name), name).toBe(true);
      expect(info.memory?.imported).toBe(false);
      expect(info.memory?.maximumPages).toBeDefined();
      expect(info.memory!.maximumPages! * 65536).toBeLessThanOrEqual(manifest.resources.maxMemoryBytes);
      for (const imp of info.imports) expect(["env", "wasi_snapshot_preview1"]).toContain(imp.module);
    });

    it("reports ABI version 1 and rejects undersized structs", async () => {
      const { ex, create, alloc, u32 } = await rawInstance(bytes);
      expect(ex["audiospan_get_abi_version"]!()).toBe(ABI_VERSION);
      expect(create(HOST_CONFIG_STRUCT_SIZE - 4).status).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(create(HOST_CONFIG_STRUCT_SIZE + 8).status).toBe(AS_OK); // larger (extended) struct accepted
      const { status, handle } = create();
      expect(status).toBe(AS_OK);
      const proc = alloc(PROCESS_STRUCT_SIZE);
      u32().set([PROCESS_STRUCT_SIZE - 4, 16, 0, 0, 0, 0], proc >> 2);
      expect(ex["audiospan_process"]!(handle, proc)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_create"]!(0, 0)).toBe(AS_ERROR_INVALID_ARGUMENT);
    });

    it("rejects invalid handles, parameter indices, and null buffers", async () => {
      const { ex, create, alloc, u32 } = await rawInstance(bytes);
      const { handle } = create();
      expect(ex["audiospan_destroy"]!(0)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_destroy"]!(9999)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_reset"]!(handle + 100)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_set_parameter"]!(handle, 4242, 0.5)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_set_parameter"]!(handle, 0, Number.NaN)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_get_parameter"]!(handle, 4242, alloc(8))).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_get_parameter"]!(handle, 0, 0)).toBe(AS_ERROR_INVALID_ARGUMENT);
      const proc = alloc(PROCESS_STRUCT_SIZE);
      u32().set([PROCESS_STRUCT_SIZE, 16, 2, 2, 0, 0], proc >> 2); // channels > 0 but null tables
      expect(ex["audiospan_process"]!(handle, proc)).toBe(AS_ERROR_INVALID_ARGUMENT);
      u32().set([PROCESS_STRUCT_SIZE, 0, 0, 0, 0, 0], proc >> 2); // zero frames is a no-op
      expect(ex["audiospan_process"]!(handle, proc)).toBe(AS_OK);
      expect(ex["audiospan_process"]!(handle, 0)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_destroy"]!(handle)).toBe(AS_OK);
      expect(ex["audiospan_destroy"]!(handle)).toBe(AS_ERROR_INVALID_ARGUMENT); // double destroy
    });

    it("returns AS_ERROR_BUFFER_TOO_SMALL for undersized state buffers and AS_ERROR_INVALID_FORMAT for garbage", async () => {
      const { ex, create, alloc, u32 } = await rawInstance(bytes);
      const { handle } = create();
      const sizePtr = alloc(4);
      expect(ex["audiospan_get_state_size"]!(handle, sizePtr)).toBe(AS_OK);
      const size = u32()[sizePtr >> 2]!;
      expect(size).toBeGreaterThan(0);
      const dest = alloc(size + 16);
      const written = alloc(4);
      expect(ex["audiospan_get_state"]!(handle, dest, size - 1, written)).toBe(AS_ERROR_BUFFER_TOO_SMALL);
      expect(ex["audiospan_get_state"]!(handle, dest, size, written)).toBe(AS_OK);
      expect(u32()[written >> 2]).toBe(size);
      expect(ex["audiospan_get_state"]!(handle, dest, size + 16, written)).toBe(AS_OK); // oversized buffer is fine
      const garbage = alloc(4);
      new Uint8Array(ex.memory.buffer).set([1, 2, 3, 4], garbage);
      expect(ex["audiospan_set_state"]!(handle, garbage, 4)).toBe(AS_ERROR_INVALID_FORMAT);
      expect(ex["audiospan_set_state"]!(handle, 0, 4)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_set_state"]!(handle, dest, size)).toBe(AS_OK);
    });

    it("implements the optional latency and output exports consistently with its manifest", async () => {
      const { ex, create, alloc, u32 } = await rawInstance(bytes);
      const { handle } = create();
      const out = alloc(8);
      expect(ex["audiospan_get_latency"]!(handle, out)).toBe(AS_OK);
      expect(u32()[out >> 2]).toBe(manifest.audio.latencyFrames);
      expect(ex["audiospan_get_latency"]!(handle, 0)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_get_latency"]!(handle + 100, out)).toBe(AS_ERROR_INVALID_ARGUMENT);
      manifest.outputs.forEach((_, i) => expect(ex["audiospan_get_output"]!(handle, i, out)).toBe(AS_OK));
      expect(ex["audiospan_get_output"]!(handle, manifest.outputs.length, out)).toBe(AS_ERROR_INVALID_ARGUMENT);
      expect(ex["audiospan_get_output"]!(handle, 0, 0)).toBe(AS_ERROR_INVALID_ARGUMENT);
    });

    it("reports a level output that follows the processed audio", async () => {
      const plugin = await WasmPluginInstance.instantiate(bytes, { sampleRate: 48000, maxFrames: 128, channels: 2, maxMemoryBytes: manifest.resources.maxMemoryBytes, maxStateBytes: manifest.resources.maxStateBytes, outputCount: manifest.outputs.length });
      expect(plugin.getOutput(0)).toBe(0);
      plugin.setParameter(0, 1.5);
      const out = [new Float32Array(128), new Float32Array(128)];
      plugin.process([new Float32Array(128).fill(0.5), new Float32Array(128).fill(-0.25)], 2, out, 128);
      expect(plugin.getOutput(0)).toBeCloseTo(0.75, 6);
      expect(plugin.reset()).toBe(AS_OK);
      expect(plugin.getOutput(0)).toBe(0);
      plugin.destroy();
    });

    it("supports many create/destroy cycles and concurrent instances in one module", async () => {
      const { ex, create } = await rawInstance(bytes);
      for (let i = 0; i < 100; i++) {
        const { status, handle } = create();
        expect(status).toBe(AS_OK);
        expect(ex["audiospan_destroy"]!(handle)).toBe(AS_OK);
      }
      const handles = Array.from({ length: 8 }, () => create().handle);
      expect(new Set(handles).size).toBe(8);
      for (const h of handles) expect(ex["audiospan_destroy"]!(h)).toBe(AS_OK);
    });

    it("passes the generic runtime checks", async () => {
      const results = await runGenericChecks(bytes, manifest);
      expect(results.filter((r) => !r.ok)).toEqual([]);
    });

    it("produces the expected output for the shared gain vectors", async () => {
      const results = await runVectorCases(bytes, manifest, vectors);
      expect(results.filter((r) => !r.ok)).toEqual([]);
    });

    it("is deterministic and does not retain host buffers", async () => {
      const plugin = await WasmPluginInstance.instantiate(bytes, { sampleRate: 44100, maxFrames: 128, channels: 2, maxMemoryBytes: manifest.resources.maxMemoryBytes, maxStateBytes: manifest.resources.maxStateBytes });
      plugin.setParameter(0, 0.5);
      const input = [Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 7)), Float32Array.from({ length: 128 }, (_, i) => Math.cos(i / 5))];
      const first = [new Float32Array(128), new Float32Array(128)];
      const second = [new Float32Array(128), new Float32Array(128)];
      plugin.process(input, 2, first, 128);
      // Mutating the previous buffers must not influence the next call.
      first[0]!.fill(123);
      input[0]!.fill(0.25);
      plugin.process(input, 2, second, 128);
      expect(second[0]!.every((v) => Math.abs(v - 0.125) < 1e-6)).toBe(true);
      for (let i = 0; i < 128; i++) expect(second[1]![i]).toBeCloseTo(Math.cos(i / 5) * 0.5, 6);
      plugin.destroy();
    });
  });
}

describe("reference plugins agree", () => {
  it.skipIf(plugins.length < 2)("C++ and Rust gain produce identical samples", async () => {
    const outputs: Float32Array[] = [];
    for (const plugin of plugins) {
      const bytes = new Uint8Array(readFileSync(resolve(plugin.dir, "module.wasm")));
      const manifest = assertManifest(JSON.parse(readFileSync(resolve(plugin.dir, "plugin.json"), "utf8")));
      const p = await WasmPluginInstance.instantiate(bytes, { sampleRate: 48000, maxFrames: 128, channels: 1, maxMemoryBytes: manifest.resources.maxMemoryBytes, maxStateBytes: manifest.resources.maxStateBytes });
      p.setParameter(0, 1.3);
      const out = [new Float32Array(128)];
      p.process([Float32Array.from({ length: 128 }, (_, i) => (i % 17) / 17 - 0.5)], 1, out, 128);
      outputs.push(out[0]!);
      p.destroy();
    }
    for (let i = 1; i < outputs.length; i++) expect(Array.from(outputs[i]!)).toEqual(Array.from(outputs[0]!));
  });
});
