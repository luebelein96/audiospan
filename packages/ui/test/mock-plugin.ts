import { assertManifest, type PluginState } from "@audiospan/manifest";
import { clampParameterValue, toNormalized, type PluginDescriptor, type PluginInstance, type PluginInstanceEvents, type PluginInstanceStatus } from "@audiospan/sdk";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use string paths: under happy-dom, `new URL()` yields a non-Node URL that fileURLToPath rejects.
const here = dirname(fileURLToPath(import.meta.url));

type Listener<K extends keyof PluginInstanceEvents> = (e: PluginInstanceEvents[K]) => void;

/** A control-plane-only PluginInstance for UI tests: no runtime, just events and values. */
export class MockPlugin implements PluginInstance {
  readonly id = "mock#1";
  readonly descriptor: PluginDescriptor;
  readonly channels = 2;
  latencyFrames = 0;
  status: PluginInstanceStatus = "ready";
  private values = new Map<string, number>();
  private outputs = new Map<string, number>();
  private bypassed = false;
  private listeners = new Map<string, Set<(e: never) => void>>();
  readonly calls: string[] = [];

  constructor(manifestOverride?: unknown) {
    const manifest = assertManifest(manifestOverride ?? JSON.parse(readFileSync(resolve(here, "../../../tests/fixtures/manifests/valid-gain.json"), "utf8")));
    this.descriptor = {
      id: manifest.id, name: manifest.name, version: manifest.version, vendor: manifest.vendor, description: manifest.description, category: manifest.category, license: manifest.license,
      parameters: manifest.parameters, outputs: manifest.outputs, audioInputs: manifest.audio.inputs, audioOutputs: manifest.audio.outputs, capabilities: manifest.capabilities, resources: manifest.resources,
      latencyFrames: 0, maxFramesPerProcess: 2048, sourceUrl: "mock", moduleByteLength: 0, warnings: [], manifest,
      presets: [{ id: "half", name: "Half", state: { schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, parameters: { gain: 0.5 } } }],
    };
    for (const p of manifest.parameters) this.values.set(p.id, p.default);
    for (const o of manifest.outputs) this.outputs.set(o.id, o.min);
  }

  getOutput(id: string): number { return this.outputs.get(id)!; }
  getOutputs(): Readonly<Record<string, number>> { return Object.fromEntries(this.outputs); }
  /** Test hook: push new output values as the runtime would. */
  pushOutputs(values: Record<string, number>): void {
    for (const [id, v] of Object.entries(values)) this.outputs.set(id, v);
    this.emit("outputs", { instanceId: this.id, values });
  }
  /** Test hook: report a latency change as the runtime would. */
  setLatency(frames: number): void {
    this.latencyFrames = frames;
    this.emit("latencychange", { instanceId: this.id, latencyFrames: frames });
  }

  emit<K extends keyof PluginInstanceEvents>(event: K, payload: PluginInstanceEvents[K]): void {
    for (const l of this.listeners.get(event) ?? []) (l as Listener<K>)(payload);
  }

  setParameter(id: string, value: number): void {
    this.calls.push(`set:${id}=${value}`);
    const p = this.descriptor.parameters.find((x) => x.id === id)!;
    const { value: v, clamped } = clampParameterValue(p, value);
    this.values.set(id, v);
    this.emit("parameterchange", { instanceId: this.id, parameterId: id, value: v, normalized: toNormalized(p, v), clamped, source: "api" });
  }
  getParameter(id: string): number { return this.values.get(id)!; }
  async readParameter(id: string): Promise<number> { return this.values.get(id)!; }
  setParameterNormalized(): void {}
  getParameterNormalized(id: string): number { return toNormalized(this.descriptor.parameters.find((x) => x.id === id)!, this.values.get(id)!); }
  resetParameters(): void {
    this.calls.push("reset");
    for (const p of this.descriptor.parameters) this.setParameter(p.id, p.default);
  }
  setBypassed(b: boolean): void {
    this.bypassed = b;
    this.emit("bypasschange", { instanceId: this.id, bypassed: b });
  }
  isBypassed(): boolean { return this.bypassed; }
  async reset(): Promise<void> {}
  async getState(): Promise<PluginState> { return { schemaVersion: 1, pluginId: this.descriptor.id, pluginVersion: this.descriptor.version, parameters: Object.fromEntries(this.values) }; }
  async setState(): Promise<void> {}
  async loadPreset(presetId: string): Promise<void> {
    this.calls.push(`preset:${presetId}`);
    if (presetId === "boom") throw new Error("kaboom");
    this.setParameter("gain", 0.5);
    this.emit("statechange", { instanceId: this.id, reason: "preset", presetId, warnings: [] });
  }
  on<K extends keyof PluginInstanceEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (e: never) => void);
    return () => set!.delete(listener as (e: never) => void);
  }
  listenerCount(): number { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
  async dispose(): Promise<void> { this.status = "disposed"; this.emit("statuschange", { instanceId: this.id, status: "disposed" }); }
}
