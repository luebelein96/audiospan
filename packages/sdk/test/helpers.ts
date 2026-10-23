import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AudiospanHost, type AudiospanHostOptions } from "../src/index.js";
import { createInProcessRuntime, type InProcessRuntime } from "../src/testing.js";

export const pluginDir = fileURLToPath(new URL("../../../plugins/gain-cpp/", import.meta.url));
export const wasmPath = `${pluginDir}dist/module.wasm`;
export const gainAvailable = existsSync(wasmPath);

export function gainSource() {
  const manifest = JSON.parse(readFileSync(`${pluginDir}plugin.json`, "utf8")) as Record<string, unknown>;
  const presets: Record<string, unknown> = {};
  for (const file of readdirSync(`${pluginDir}presets`)) presets[`presets/${file}`] = JSON.parse(readFileSync(`${pluginDir}presets/${file}`, "utf8"));
  return { manifest, moduleBytes: new Uint8Array(readFileSync(wasmPath)), presets, sourceUrl: "test:gain-cpp" };
}

/** A fetch that serves the gain-cpp artifact directory from a fake origin. */
export function fakeFetch(baseUrl = "https://plugins.test/gain/", overrides: Record<string, () => Response> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (overrides[url]) return overrides[url]!();
    if (!url.startsWith(baseUrl)) return new Response("not found", { status: 404 });
    const rel = url.slice(baseUrl.length);
    const path = `${pluginDir}${rel === "plugin.json" ? "plugin.json" : rel === "module.wasm" ? "dist/module.wasm" : rel}`;
    if (!existsSync(path)) return new Response("not found", { status: 404 });
    const body = readFileSync(path);
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.byteLength), "content-type": rel.endsWith(".wasm") ? "application/wasm" : "application/json" } });
  }) as typeof fetch;
}

export interface TestHost {
  host: AudiospanHost;
  runtime: InProcessRuntime;
  errors: Error[];
  diagnostics: unknown[];
}

export async function createTestHost(options: Partial<AudiospanHostOptions> = {}): Promise<TestHost> {
  const runtime = createInProcessRuntime();
  const errors: Error[] = [];
  const diagnostics: unknown[] = [];
  const host = await AudiospanHost.create({
    transport: runtime.transport,
    sampleRate: 48000,
    requestTimeoutMs: 5000,
    onError: (e) => errors.push(e),
    onDiagnostic: (d) => diagnostics.push(d),
    ...options,
  });
  return { host, runtime, errors, diagnostics };
}

export function block(frames: number, channels: number, fill: (i: number, c: number) => number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => fill(i, c)));
}
