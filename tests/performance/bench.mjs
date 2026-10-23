#!/usr/bin/env node
// Audiospan runtime benchmark (Node). Measures per-block processing time of
// the serial chain with the real compiled gain plugin, outside a browser, so
// results are deterministic enough to compare across commits.
//
//   node tests/performance/bench.mjs [--blocks 20000] [--json out.json] [--plugin plugins/gain-cpp/dist]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { AudiospanRuntime, DEFAULT_RUNTIME_CONFIG, PROTOCOL_VERSION, inspectWasmModule } = await import(resolve(root, "packages/runtime/dist/index.js"));
const { assertManifest } = await import(resolve(root, "packages/manifest/dist/index.js"));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BLOCKS = Number(flag("blocks", 20000));
const WARMUP = 2000;
const pluginDir = resolve(root, flag("plugin", "plugins/gain-cpp/dist"));
const manifest = assertManifest(JSON.parse(readFileSync(resolve(pluginDir, "plugin.json"), "utf8")));
const wasmBuffer = readFileSync(resolve(pluginDir, "module.wasm"));
const bytes = wasmBuffer.buffer.slice(wasmBuffer.byteOffset, wasmBuffer.byteOffset + wasmBuffer.byteLength);

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

async function makeRuntime(config) {
  const messages = [];
  const runtime = new AudiospanRuntime((m) => messages.push(m));
  const waitFor = (pred) =>
    new Promise((resolveWait, reject) => {
      const start = Date.now();
      const tick = () => {
        const m = messages.find(pred);
        if (m) return resolveWait(m);
        if (Date.now() - start > 5000) return reject(new Error(`timeout; messages=${JSON.stringify(messages)}`));
        setTimeout(tick, 1);
      };
      tick();
    });
  runtime.handleMessage({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: 1, config: { ...DEFAULT_RUNTIME_CONFIG, ...config } });
  await waitFor((m) => m.type === "READY");
  return { runtime, messages, waitFor };
}

async function scenario({ plugins, sampleRate, channels, frames, diagnostics }) {
  const { runtime, waitFor, messages } = await makeRuntime({ sampleRate, maxChannels: channels, maxFrames: frames, maxPlugins: Math.max(8, plugins), diagnostics, scanNonFinite: diagnostics });
  const loadStart = performance.now();
  runtime.handleMessage({ type: "LOAD_PLUGIN", requestId: 2, pluginId: manifest.id, module: bytes.slice(0), manifest, memoryInfo: inspectWasmModule(new Uint8Array(bytes)).memory });
  await waitFor((m) => m.type === "PLUGIN_READY");
  const loadMs = performance.now() - loadStart;
  const ids = [];
  for (let i = 0; i < plugins; i++) {
    const id = `g${i}`;
    runtime.handleMessage({ type: "CREATE_INSTANCE", requestId: 10 + i, pluginId: manifest.id, instanceId: id });
    await waitFor((m) => m.type === "INSTANCE_READY" && m.instanceId === id);
    runtime.handleMessage({ type: "SET_PARAMETER", instanceId: id, parameterIndex: 0, value: 0.99, sequence: i });
    ids.push(id);
  }
  runtime.handleMessage({ type: "REPLACE_CHAIN", requestId: 100, instanceIds: ids });
  await waitFor((m) => m.type === "ACK" && m.requestId === 100);

  const input = Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => Math.sin((i + c) * 0.05)));
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < WARMUP; i++) runtime.process(input, output);
  const durations = new Float64Array(BLOCKS);
  const memBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < BLOCKS; i++) {
    const t0 = performance.now();
    runtime.process(input, output);
    durations[i] = performance.now() - t0;
  }
  const memAfter = process.memoryUsage().heapUsed;
  let stateMs = 0;
  if (plugins > 0) {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      runtime.handleMessage({ type: "GET_STATE", requestId: 1000 + i, instanceId: ids[0] });
      await waitFor((m) => m.type === "STATE" && m.requestId === 1000 + i);
    }
    stateMs = (performance.now() - t0) / 100;
  }
  const sorted = Array.from(durations).sort((a, b) => a - b);
  const budgetMs = (frames / sampleRate) * 1000;
  const median = percentile(sorted, 0.5);
  runtime.dispose();
  return {
    plugins, sampleRate, channels, frames, diagnostics,
    medianMs: median, p95Ms: percentile(sorted, 0.95), p99Ms: percentile(sorted, 0.99), maxMs: sorted[sorted.length - 1],
    budgetMs, budgetPctMedian: (median / budgetMs) * 100, budgetPctP99: (percentile(sorted, 0.99) / budgetMs) * 100,
    loadMs, stateMs, heapDeltaBytes: memAfter - memBefore,
    diagnosticsPosted: messages.filter((m) => m.type === "DIAGNOSTIC").length,
  };
}

const scenarios = [];
for (const sampleRate of [44100, 48000]) {
  for (const channels of [1, 2]) {
    for (const plugins of [0, 1, 4, 8]) scenarios.push({ plugins, sampleRate, channels, frames: 128, diagnostics: false });
  }
}
scenarios.push({ plugins: 8, sampleRate: 48000, channels: 2, frames: 128, diagnostics: true });
scenarios.push({ plugins: 8, sampleRate: 48000, channels: 2, frames: 1024, diagnostics: false });

const results = [];
console.log(`Audiospan benchmark: ${BLOCKS} blocks per scenario after ${WARMUP} warm-up blocks`);
console.log(`node ${process.version} ${platform()} ${release()} ${arch()} ${cpus()[0]?.model ?? "unknown cpu"}\n`);
console.log("plugins  rate   ch  frames diag  median(ms)  p95(ms)   p99(ms)   max(ms)   budget%med  budget%p99  load(ms)  state(ms)");
for (const s of scenarios) {
  const r = await scenario(s);
  results.push(r);
  console.log(
    `${String(r.plugins).padStart(7)}  ${r.sampleRate}  ${String(r.channels).padStart(2)}  ${String(r.frames).padStart(6)} ${r.diagnostics ? "on " : "off"}  ` +
      `${r.medianMs.toFixed(4).padStart(10)}  ${r.p95Ms.toFixed(4).padStart(8)}  ${r.p99Ms.toFixed(4).padStart(8)}  ${r.maxMs.toFixed(4).padStart(8)}  ` +
      `${r.budgetPctMedian.toFixed(2).padStart(10)}  ${r.budgetPctP99.toFixed(2).padStart(10)}  ${r.loadMs.toFixed(2).padStart(8)}  ${r.stateMs.toFixed(3).padStart(9)}`,
  );
}
const out = flag("json", undefined);
if (out) {
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, blocks: BLOCKS, warmup: WARMUP, results }, null, 2));
  console.log(`\nwrote ${out}`);
}
