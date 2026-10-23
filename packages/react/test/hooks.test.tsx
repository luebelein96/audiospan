// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInProcessRuntime, type InProcessRuntime } from "@audiospan/sdk/testing";
import { Meter, ParameterControl, PluginPanel, PresetSelect, resolveAudioSource, useAudioSource, useAudiospanHost, usePlugin, type AudiospanHostHandle, type AudiospanHost, type PluginHandle } from "../src/index.js";
import { useState } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Plain paths: under happy-dom, `new URL()` yields a non-Node URL that fileURLToPath rejects.
const pluginDir = `${resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/gain-cpp")}/`;
const available = existsSync(`${pluginDir}dist/module.wasm`);

function gainSource() {
  const manifest = JSON.parse(readFileSync(`${pluginDir}plugin.json`, "utf8")) as Record<string, unknown>;
  const presets: Record<string, unknown> = {};
  for (const file of readdirSync(`${pluginDir}presets`)) presets[`presets/${file}`] = JSON.parse(readFileSync(`${pluginDir}presets/${file}`, "utf8"));
  return { manifest, moduleBytes: new Uint8Array(readFileSync(`${pluginDir}dist/module.wasm`)), presets, sourceUrl: "test:gain-cpp" };
}

interface Latest {
  host: AudiospanHostHandle;
  plugin: PluginHandle;
}

function mount(runtime: InProcessRuntime, source: ReturnType<typeof gainSource> | null, options: { strict?: boolean; controls?: boolean } = {}): { root: Root; container: HTMLElement; latest: () => Latest } {
  let latest: Latest | undefined;
  function Harness() {
    const host = useAudiospanHost({ transport: runtime.transport, sampleRate: 48000, requestTimeoutMs: 5000 });
    const plugin = usePlugin(host.host, source);
    latest = { host, plugin };
    return options.controls ? (
      <>
        <ParameterControl plugin={plugin} id="gain" />
        <Meter plugin={plugin} id="level" />
        <PresetSelect plugin={plugin} />
      </>
    ) : (
      <PluginPanel plugin={plugin.plugin} header={false} />
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(options.strict ? <StrictMode><Harness /></StrictMode> : <Harness />));
  return { root, container, latest: () => latest! };
}

async function until(runtime: InProcessRuntime, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await act(async () => {
      await runtime.settle();
    });
  }
  expect(predicate()).toBe(true);
}

describe.skipIf(!available)("@audiospan/react", () => {
  it("starts a host, loads a plugin into the chain, mirrors its values, renders the panel and tears down", async () => {
    const runtime = createInProcessRuntime();
    const { root, container, latest } = mount(runtime, gainSource());
    expect(latest().host.status).toBe("idle");
    expect(latest().plugin.status).toBe("idle");

    await act(async () => {
      await latest().host.start();
    });
    expect(latest().host.status).toBe("running");
    expect(latest().host.host).not.toBeNull();
    await until(runtime, () => latest().plugin.status === "ready");
    expect(latest().plugin.descriptor?.id).toBe("dev.audiospan.gain-cpp");
    expect(latest().plugin.values).toEqual({ gain: 1 });
    expect(latest().plugin.outputs).toEqual({ level: 0 });
    expect(container.querySelector(".as-panel")).not.toBeNull();
    expect(container.querySelector('[data-parameter="gain"] input[type="range"]')).not.toBeNull();

    // The plugin joined the active chain through addPlugin: audio flows and parameter changes reach it.
    act(() => latest().plugin.setParameter("gain", 0.5));
    await until(runtime, () => latest().plugin.values["gain"] === 0.5);
    await act(async () => {
      await latest().host.host!.sync();
    });
    const input = [new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.25)];
    const output = [new Float32Array(128), new Float32Array(128)];
    runtime.process(input, output);
    expect(output[0]![0]).toBeCloseTo(0.125, 6);
    // Output values stream into state at the configured rate.
    for (let i = 0; i < 13; i++) runtime.process(input, output);
    await until(runtime, () => (latest().plugin.outputs["level"] ?? 0) > 0);
    expect(latest().plugin.outputs["level"]).toBeCloseTo(0.125, 6);

    const host = latest().host.host!;
    const plugin = latest().plugin.plugin!;
    act(() => root.unmount());
    await act(async () => {
      await runtime.settle();
    });
    expect(plugin.status).toBe("disposed");
    expect(host.status).toBe("disposed");
    expect(container.querySelector(".as-panel")).toBeNull();
  });

  it("owns exactly one instance per mount under StrictMode's double effects", async () => {
    const runtime = createInProcessRuntime();
    const { root, latest } = mount(runtime, gainSource(), { strict: true });
    await act(async () => {
      await latest().host.start();
    });
    await until(runtime, () => latest().plugin.status === "ready");
    await act(async () => {
      await runtime.settle();
    });
    const host = latest().host.host!;
    expect(host.listInstances()).toHaveLength(1);
    expect(host.getActiveChain()?.getPlugins()).toHaveLength(1);
    expect(runtime.runtime.activePluginCount).toBe(1);
    act(() => root.unmount());
    await act(async () => {
      await runtime.settle();
    });
  });

  it("renders React controls bound to the handle", async () => {
    const runtime = createInProcessRuntime();
    const { root, container, latest } = mount(runtime, gainSource(), { controls: true });
    await act(async () => {
      await latest().host.start();
    });
    await until(runtime, () => latest().plugin.status === "ready");
    const row = container.querySelector<HTMLElement>('[data-parameter="gain"]')!;
    expect(row.querySelector(".as-control__label")?.textContent).toBe("Gain");
    expect(row.querySelector(".as-control__value")?.textContent).toBe("1.00");
    const slider = row.querySelector<HTMLInputElement>('input[type="range"]')!;
    await act(async () => {
      // React listens for `input`/`change` through its synthetic event system; set the value and dispatch like a user.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(slider, "0.25");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(runtime, () => latest().plugin.values["gain"] === 0.25);
    expect(row.querySelector(".as-control__value")?.textContent).toBe("0.25");
    const meter = container.querySelector<HTMLElement>('[data-output="level"] meter')!;
    expect(meter.getAttribute("min")).toBe("0");
    expect(meter.getAttribute("max")).toBe("2");
    expect(container.querySelectorAll(".as-panel__presets option")).toHaveLength(4); // placeholder + 3 presets
    act(() => root.unmount());
  });

  it("waits while the source is null and reports load failures", async () => {
    const runtime = createInProcessRuntime();
    const { root, latest } = mount(runtime, null);
    await act(async () => {
      await latest().host.start();
    });
    await act(async () => {
      await runtime.settle();
    });
    expect(latest().plugin.status).toBe("idle");
    act(() => root.unmount());

    // Unmounting disposed the host and its transport; a new mount needs a fresh in-process runtime.
    const runtime2 = createInProcessRuntime();
    const bad = mount(runtime2, { ...gainSource(), moduleBytes: new Uint8Array([1, 2, 3]) });
    await act(async () => {
      await bad.latest().host.start();
    });
    await until(runtime2, () => bad.latest().plugin.status === "error");
    expect(bad.latest().plugin.error?.code).toBe("MODULE_INVALID");
    act(() => bad.root.unmount());
  });

  it("start() is idempotent and stop() returns to idle", async () => {
    const runtime = createInProcessRuntime();
    const { root, latest } = mount(runtime, null);
    let first: unknown;
    let second: unknown;
    await act(async () => {
      [first, second] = await Promise.all([latest().host.start(), latest().host.start()]);
    });
    expect(first).toBe(second);
    await act(async () => {
      await latest().host.stop();
    });
    expect(latest().host.status).toBe("idle");
    expect(latest().host.host).toBeNull();
    act(() => root.unmount());
  });
});

describe("resolveAudioSource", () => {
  const node = { connect() {}, disconnect() {} } as unknown as AudioNode;
  const context = {
    createMediaStreamSource: (stream: MediaStream) => ({ kind: "stream", stream }) as unknown as AudioNode,
    createMediaElementSource: (element: HTMLMediaElement) => ({ kind: "element", element }) as unknown as AudioNode,
    createBufferSource: () => {
      const source = { buffer: null as AudioBuffer | null, loop: false, started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } };
      return source as unknown as AudioBufferSourceNode;
    },
  } as unknown as BaseAudioContext;

  it("passes nodes through, runs factories, and wraps streams", async () => {
    expect((await resolveAudioSource(context, node)).node).toBe(node);
    expect((await resolveAudioSource(context, async () => node)).node).toBe(node);
    const stream = new MediaStream();
    const resolved = await resolveAudioSource(context, stream);
    expect((resolved.node as unknown as { kind: string; stream: MediaStream }).stream).toBe(stream);
  });

  it("creates a media element source once per element", async () => {
    const element = document.createElement("audio");
    const first = await resolveAudioSource(context, element);
    const second = await resolveAudioSource(context, element);
    expect(second.node).toBe(first.node);
  });

  it("starts looping buffer sources and stops them on cleanup", async () => {
    // happy-dom has no AudioBuffer; the hook only needs the class for an instanceof check.
    class FakeAudioBuffer {}
    (globalThis as unknown as { AudioBuffer: unknown }).AudioBuffer = FakeAudioBuffer;
    const buffer = new FakeAudioBuffer() as unknown as AudioBuffer;
    const resolved = await resolveAudioSource(context, buffer);
    const source = resolved.node as unknown as { buffer: AudioBuffer | null; loop: boolean; started: boolean; stopped: boolean };
    expect(source.buffer).toBe(buffer);
    expect(source.loop).toBe(true);
    expect(source.started).toBe(true);
    resolved.cleanup();
    expect(source.stopped).toBe(true);
  });

  it("explains a missing microphone", async () => {
    await expect(resolveAudioSource(context, "microphone")).rejects.toThrow(/microphone is unavailable/);
  });
});

describe("useAudioSource", () => {
  it("connects an inline factory once and does not reconnect on re-renders, but disconnects on stop", async () => {
    const node = { connect() {}, disconnect() {} } as unknown as AudioNode;
    const connected: AudioNode[] = [];
    const disconnected: AudioNode[] = [];
    const fakeHost = { status: "ready", connectSource: (n: AudioNode) => connected.push(n), disconnectSource: (n: AudioNode) => disconnected.push(n) } as unknown as AudiospanHost;
    const fakeContext = {} as BaseAudioContext;
    let factoryCalls = 0;
    let rerender: (() => void) | undefined;
    let setRunning: ((running: boolean) => void) | undefined;
    function Harness() {
      const [tick, setTick] = useState(0);
      const [running, setRunningState] = useState(true);
      rerender = () => setTick((t) => t + 1);
      setRunning = setRunningState;
      // A fresh closure every render, as people naturally write it.
      const handle = useAudioSource({ host: running ? fakeHost : null, audioContext: running ? fakeContext : null, status: running ? "running" : "idle" }, () => {
        factoryCalls++;
        return node;
      });
      return <span data-status={handle.status} data-tick={tick} />;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<Harness />));
    await act(async () => {});
    expect(factoryCalls).toBe(1);
    expect(connected).toEqual([node]);
    expect(container.querySelector("span")?.dataset["status"]).toBe("connected");
    for (let i = 0; i < 5; i++) await act(async () => rerender!());
    expect(factoryCalls).toBe(1);
    expect(connected).toHaveLength(1);
    expect(disconnected).toHaveLength(0);
    await act(async () => setRunning!(false));
    expect(disconnected).toEqual([node]);
    expect(container.querySelector("span")?.dataset["status"]).toBe("idle");
    act(() => root.unmount());
  });
});
