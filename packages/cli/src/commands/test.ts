import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertManifest, type NormalizedPluginManifest } from "@audiospan/manifest";
import { AS_ERROR_BUFFER_TOO_SMALL, AS_ERROR_INVALID_ARGUMENT, AS_OK, WasmPluginInstance } from "@audiospan/runtime";
import { CliError } from "../errors.js";

export interface VectorCase {
  name: string;
  parameters?: Record<string, number>;
  /** "silence" | "impulse" | "ramp" | "constant:<v>" | "sine" | number[] */
  input: string | number[];
  /** "silence" | "input*<factor>" | "input" | number[]. Omit it and `audiospan test --update` records the current output here. */
  expect?: string | number[];
  frames?: number;
  channels?: number;
  tolerance?: number;
}

export interface VectorFile {
  tolerance?: number;
  cases: VectorCase[];
}

export interface TestResultEntry {
  name: string;
  ok: boolean;
  message?: string;
}

export interface TestRunResult {
  ok: boolean;
  results: TestResultEntry[];
  /** Names of cases whose expectation was recorded by `--update`. */
  recorded: string[];
}

export interface TestOptions {
  /** Record the current output as the expectation of every case that has none, and rewrite the vector file. */
  update?: boolean;
}

export function generateInput(spec: string | number[], frames: number): Float32Array {
  if (Array.isArray(spec)) return Float32Array.from(spec);
  if (spec === "silence") return new Float32Array(frames);
  if (spec === "impulse") {
    const out = new Float32Array(frames);
    out[0] = 1;
    return out;
  }
  if (spec === "ramp") return Float32Array.from({ length: frames }, (_, i) => (i / frames) * 2 - 1);
  if (spec === "sine") return Float32Array.from({ length: frames }, (_, i) => Math.sin((2 * Math.PI * i * 4) / frames));
  const constant = /^constant:(-?[0-9.]+)$/.exec(spec);
  if (constant) return new Float32Array(frames).fill(Number(constant[1]));
  throw new CliError(`unknown input spec ${JSON.stringify(spec)}`, 2);
}

export function expectedOutput(spec: string | number[], input: Float32Array): Float32Array {
  if (Array.isArray(spec)) return Float32Array.from(spec);
  if (spec === "silence") return new Float32Array(input.length);
  if (spec === "input") return input.slice();
  const scaled = /^input\*(-?[0-9.]+)$/.exec(spec);
  if (scaled) {
    const factor = Number(scaled[1]);
    return input.map((v) => v * factor);
  }
  throw new CliError(`unknown expect spec ${JSON.stringify(spec)}`, 2);
}

/** Instance options for test runs: development builds (log import) are accepted and their lines discarded. */
function instanceOptions(manifest: NormalizedPluginManifest, maxFrames: number, channels: number) {
  return {
    sampleRate: 48000,
    maxFrames,
    channels,
    maxMemoryBytes: manifest.resources.maxMemoryBytes,
    maxStateBytes: manifest.resources.maxStateBytes,
    allowLogging: true,
    onLog: () => {},
    outputCount: manifest.outputs.length,
  };
}

/** Generic ABI checks every plugin must pass, independent of its DSP. */
export async function runGenericChecks(bytes: Uint8Array, manifest: NormalizedPluginManifest): Promise<TestResultEntry[]> {
  const results: TestResultEntry[] = [];
  const check = (name: string, fn: () => void) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, message: (error as Error).message });
    }
  };
  const options = instanceOptions(manifest, 256, Math.min(2, manifest.audio.outputs[0]?.channels.max ?? 1));
  let plugin: WasmPluginInstance;
  try {
    plugin = await WasmPluginInstance.instantiate(bytes, options);
  } catch (error) {
    return [{ name: "instantiate module and create instance", ok: false, message: (error as Error).message }];
  }
  results.push({ name: "instantiate module and create instance", ok: true });
  check("parameters accept their defaults and read back", () => {
    manifest.parameters.forEach((p, i) => {
      const status = plugin.setParameter(i, p.default);
      if (status !== AS_OK) throw new Error(`set_parameter(${i}) returned ${status}`);
      const value = plugin.getParameter(i);
      if (Math.abs(value - p.default) > 1e-6) throw new Error(`parameter ${p.id} read back ${value}, expected ${p.default}`);
    });
  });
  check("out-of-range parameter index is rejected", () => {
    if (plugin.setParameter(manifest.parameters.length + 7, 0) !== AS_ERROR_INVALID_ARGUMENT) throw new Error("expected AS_ERROR_INVALID_ARGUMENT");
  });
  check("processing silence yields finite output", () => {
    const frames = 128;
    const silence = Array.from({ length: options.channels }, () => new Float32Array(frames));
    const out = Array.from({ length: options.channels }, () => new Float32Array(frames).fill(Number.NaN));
    if (plugin.process(silence, options.channels, out, frames) !== AS_OK) throw new Error("process returned an error");
    for (const ch of out) for (const v of ch) if (!Number.isFinite(v)) throw new Error("non-finite output sample");
  });
  check("varying frame counts are accepted", () => {
    for (const frames of [1, 7, 64, 256]) {
      const input = Array.from({ length: options.channels }, () => new Float32Array(frames).fill(0.1));
      const out = Array.from({ length: options.channels }, () => new Float32Array(frames));
      if (plugin.process(input, options.channels, out, frames) !== AS_OK) throw new Error(`process failed for ${frames} frames`);
    }
  });
  if (manifest.capabilities.state) {
    check("state round-trips and rejects garbage", () => {
      const state = plugin.getState();
      if (plugin.setState(state) !== AS_OK) throw new Error("set_state rejected its own state");
      if (plugin.setState(new Uint8Array([0xff, 0xfe, 0xfd])) === AS_OK) throw new Error("set_state accepted garbage");
    });
  }
  check("reset succeeds", () => {
    if (plugin.reset() !== AS_OK) throw new Error("reset returned an error");
  });
  check("latency export, when present, reports a frame count or AS_ERROR_UNSUPPORTED", () => {
    if (!plugin.supportsLatency) return;
    const latency = plugin.getLatency();
    if (latency !== undefined && !(Number.isInteger(latency) && latency >= 0)) throw new Error(`get_latency returned ${latency}`);
  });
  if (manifest.outputs.length > 0) {
    check("outputs read back finite values and reject an out-of-range index", () => {
      manifest.outputs.forEach((o, i) => {
        const value = plugin.getOutput(i);
        if (!Number.isFinite(value)) throw new Error(`output ${o.id} read back ${value}`);
      });
      let rejected = false;
      try {
        plugin.getOutput(manifest.outputs.length + 3);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("expected get_output to reject an out-of-range index");
    });
  }
  check("repeated create/destroy works", () => {
    plugin.destroy();
  });
  try {
    for (let i = 0; i < 5; i++) {
      const p = await WasmPluginInstance.instantiate(bytes, options);
      p.destroy();
    }
    results.push({ name: "five instantiate/destroy cycles", ok: true });
  } catch (error) {
    results.push({ name: "five instantiate/destroy cycles", ok: false, message: (error as Error).message });
  }
  void AS_ERROR_BUFFER_TOO_SMALL;
  return results;
}

/** Run one case and return its planar output channels. */
async function renderCase(bytes: Uint8Array, manifest: NormalizedPluginManifest, c: VectorCase): Promise<{ input: Float32Array; outputs: Float32Array[]; channels: number }> {
  const frames = c.frames ?? 128;
  const channels = c.channels ?? Math.min(2, manifest.audio.outputs[0]?.channels.max ?? 1);
  const plugin = await WasmPluginInstance.instantiate(bytes, instanceOptions(manifest, Math.max(frames, 128), channels));
  try {
    for (const [id, value] of Object.entries(c.parameters ?? {})) {
      const p = manifest.parameters.find((x) => x.id === id);
      if (!p) throw new Error(`unknown parameter ${JSON.stringify(id)}`);
      const status = plugin.setParameter(p.index, value);
      if (status !== AS_OK) throw new Error(`set_parameter(${p.id}) returned ${status}`);
    }
    const input = generateInput(c.input, frames);
    const inputs = Array.from({ length: channels }, () => input.slice());
    const outputs = Array.from({ length: channels }, () => new Float32Array(input.length).fill(Number.NaN));
    const status = plugin.process(inputs, channels, outputs, input.length);
    if (status !== AS_OK) throw new Error(`process returned ${status}`);
    return { input, outputs, channels };
  } finally {
    plugin.destroy();
  }
}

/**
 * Fill in `expect` for every case that lacks one with the output the plugin
 * produces now (channel 0, rounded to 9 significant digits), so regressions
 * are caught without computing references by hand. Returns the case names recorded.
 */
export async function recordVectorExpectations(bytes: Uint8Array, manifest: NormalizedPluginManifest, vectors: VectorFile): Promise<string[]> {
  const recorded: string[] = [];
  for (const c of vectors.cases) {
    if (c.expect !== undefined) continue;
    const { outputs } = await renderCase(bytes, manifest, c);
    c.expect = Array.from(outputs[0]!, (v) => Number(v.toPrecision(9)));
    recorded.push(c.name);
  }
  return recorded;
}

export async function runVectorCases(bytes: Uint8Array, manifest: NormalizedPluginManifest, vectors: VectorFile): Promise<TestResultEntry[]> {
  const results: TestResultEntry[] = [];
  const baseTolerance = vectors.tolerance ?? 1e-6;
  for (const c of vectors.cases) {
    const tolerance = c.tolerance ?? baseTolerance;
    if (c.expect === undefined) {
      results.push({ name: c.name, ok: false, message: "no expectation; run `audiospan test --update` to record the current output as the reference" });
      continue;
    }
    try {
      const { input, outputs, channels } = await renderCase(bytes, manifest, c);
      const expected = expectedOutput(c.expect, input);
      {
        for (let ch = 0; ch < channels; ch++) {
          for (let i = 0; i < expected.length; i++) {
            const got = outputs[ch]![i]!;
            const want = expected[i]!;
            if (!(Math.abs(got - want) <= tolerance)) throw new Error(`channel ${ch} sample ${i}: got ${got}, expected ${want} (tolerance ${tolerance})`);
          }
        }
        results.push({ name: c.name, ok: true });
      }
    } catch (error) {
      results.push({ name: c.name, ok: false, message: (error as Error).message });
    }
  }
  return results;
}

/** Run generic ABI checks plus the project's test/vectors.json against a built artifact. */
export async function testArtifact(artifactDir: string, vectorsPath: string | undefined, options: TestOptions = {}): Promise<TestRunResult> {
  const manifestText = await readFile(resolve(artifactDir, "plugin.json"), "utf8").catch(() => {
    throw new CliError(`${artifactDir}/plugin.json not found; run \`audiospan build\` first`, 2);
  });
  const manifest = assertManifest(JSON.parse(manifestText));
  const bytes = new Uint8Array(await readFile(resolve(artifactDir, manifest.entry.wasm)).catch(() => {
    throw new CliError(`${artifactDir}/${manifest.entry.wasm} not found; run \`audiospan build\` first`, 2);
  }));
  const results = await runGenericChecks(bytes, manifest);
  const recorded: string[] = [];
  if (vectorsPath) {
    const vectors = JSON.parse(await readFile(vectorsPath, "utf8")) as VectorFile;
    if (!Array.isArray(vectors.cases)) throw new CliError(`${vectorsPath} must contain a "cases" array`, 2);
    if (options.update) {
      recorded.push(...(await recordVectorExpectations(bytes, manifest, vectors)));
      if (recorded.length > 0) await writeFile(vectorsPath, `${JSON.stringify(vectors, null, 2)}\n`);
    }
    results.push(...(await runVectorCases(bytes, manifest, vectors)));
  }
  return { ok: results.every((r) => r.ok), results, recorded };
}
