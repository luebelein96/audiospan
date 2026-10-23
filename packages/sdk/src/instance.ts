import {
  bytesToBase64,
  clampParameterValue,
  fromNormalized,
  toNormalized,
  validatePluginState,
  type NormalizedParameter,
  type PluginState,
} from "@audiospan/manifest";
import { AudiospanError } from "./errors.js";
import { Emitter, type Unsubscribe } from "./events.js";
import type { HostInternals } from "./internal.js";
import type {
  OutputDescriptor,
  ParameterChangeSource,
  PluginDescriptor,
  PluginInstance,
  PluginInstanceEvents,
  PluginInstanceStatus,
  PluginLogEvent,
  SetStateOptions,
} from "./types.js";

export class PluginInstanceImpl implements PluginInstance {
  readonly id: string;
  readonly descriptor: PluginDescriptor;
  readonly channels: number;

  private readonly host: HostInternals;
  private readonly emitter: Emitter<PluginInstanceEvents>;
  private readonly values = new Map<string, number>();
  private readonly byId = new Map<string, NormalizedParameter>();
  private readonly outputById = new Map<string, OutputDescriptor>();
  private readonly outputValues = new Map<string, number>();
  private latency: number;
  private bypassed = false;
  private statusValue: PluginInstanceStatus = "created";
  private pendingOps = 0;

  constructor(host: HostInternals, id: string, descriptor: PluginDescriptor, channels: number, latencyFrames: number, initialValues: ReadonlyMap<string, number>) {
    this.host = host;
    this.id = id;
    this.descriptor = descriptor;
    this.channels = channels;
    this.latency = latencyFrames;
    this.emitter = new Emitter<PluginInstanceEvents>((error) => host.reportError(new AudiospanError("RUNTIME_ERROR", `listener threw: ${(error as Error).message}`, { cause: error, instanceId: id })));
    for (const p of descriptor.parameters) {
      this.byId.set(p.id, p);
      this.values.set(p.id, initialValues.get(p.id) ?? p.default);
    }
    for (const o of descriptor.outputs) {
      this.outputById.set(o.id, o);
      this.outputValues.set(o.id, o.min);
    }
  }

  get latencyFrames(): number {
    return this.latency;
  }

  getOutput(id: string): number {
    const o = this.outputById.get(id);
    if (!o) throw new AudiospanError("INVALID_PARAMETER", `plugin ${this.descriptor.id} has no output ${JSON.stringify(id)}`, { instanceId: this.id });
    return this.outputValues.get(o.id)!;
  }

  getOutputs(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.outputValues);
  }

  /** @internal Called by the host with the runtime's latest output values, in manifest order. */
  handleOutputValues(list: readonly number[]): void {
    if (this.statusValue === "disposed") return;
    const values: Record<string, number> = {};
    for (const o of this.descriptor.outputs) {
      const v = list[o.index];
      if (v === undefined || !Number.isFinite(v)) continue;
      this.outputValues.set(o.id, v);
      values[o.id] = v;
    }
    this.emitter.emit("outputs", { instanceId: this.id, values });
  }

  /** @internal */
  handleLatency(latencyFrames: number): void {
    if (this.statusValue === "disposed" || latencyFrames === this.latency) return;
    this.latency = latencyFrames;
    this.emitter.emit("latencychange", { instanceId: this.id, latencyFrames });
  }

  /** @internal Returns true when a `log` listener received the line. */
  handleLog(event: PluginLogEvent): boolean {
    if (this.emitter.listenerCount("log") === 0) return false;
    this.emitter.emit("log", event);
    return true;
  }

  get status(): PluginInstanceStatus {
    return this.statusValue;
  }

  /** @internal */
  setStatus(status: PluginInstanceStatus): void {
    if (this.statusValue === status || this.statusValue === "disposed") return;
    this.statusValue = status;
    this.emitter.emit("statuschange", { instanceId: this.id, status });
  }

  /** @internal Called by the host when the runtime reports an instance-scoped error. */
  handleRuntimeError(error: AudiospanError): void {
    if (error.code === "INSTANCE_ERRORED") this.setStatus("error");
    this.emitter.emit("error", { instanceId: this.id, error });
  }

  /** @internal */
  get hasErrorListeners(): boolean {
    return this.emitter.listenerCount("error") > 0;
  }

  private assertLive(): void {
    if (this.statusValue === "disposed") throw new AudiospanError("DISPOSED", `plugin instance ${this.id} has been disposed`, { instanceId: this.id });
  }

  private param(id: string): NormalizedParameter {
    const p = this.byId.get(id);
    if (!p) throw new AudiospanError("INVALID_PARAMETER", `plugin ${this.descriptor.id} has no parameter ${JSON.stringify(id)}`, { instanceId: this.id });
    return p;
  }

  private applyParameter(p: NormalizedParameter, requested: number, source: ParameterChangeSource, send: boolean): number {
    if (typeof requested !== "number" || !Number.isFinite(requested)) {
      throw new AudiospanError("INVALID_PARAMETER", `value for parameter ${JSON.stringify(p.id)} must be a finite number`, { instanceId: this.id });
    }
    const { value, clamped } = clampParameterValue(p, requested);
    if (clamped && this.host.diagnosticsEnabled) {
      this.host.reportDiagnostic({ kind: "parameter-clamped", instanceId: this.id, parameterId: p.id, requested, applied: value });
    }
    const previous = this.values.get(p.id);
    this.values.set(p.id, value);
    if (send) {
      this.host.connection.send({ type: "SET_PARAMETER", instanceId: this.id, parameterIndex: p.index, value, sequence: this.host.connection.nextSequence() });
    }
    if (previous !== value || clamped) {
      if (this.host.diagnosticsEnabled) this.host.reportDiagnostic({ kind: "parameter-update", instanceId: this.id, parameterId: p.id, value, clamped });
      this.emitter.emit("parameterchange", { instanceId: this.id, parameterId: p.id, value, normalized: toNormalized(p, value), clamped, source });
    }
    return value;
  }

  setParameter(id: string, value: number): void {
    this.assertLive();
    this.applyParameter(this.param(id), value, "api", true);
  }

  getParameter(id: string): number {
    return this.values.get(this.param(id).id)!;
  }

  async readParameter(id: string): Promise<number> {
    this.assertLive();
    const p = this.param(id);
    return this.track(async () => {
      const response = await this.host.connection.request({ type: "GET_PARAMETER", requestId: this.host.connection.nextRequestId(), instanceId: this.id, parameterIndex: p.index }, ["PARAMETER_VALUE"]);
      return response.value;
    });
  }

  /**
   * @internal Adopt the values the runtime reports after a state restore for
   * every parameter the restore did not set explicitly: an opaque blob may
   * have changed them, and the mirror must say what the audio does.
   */
  adoptRuntimeValues(reported: readonly number[], except: ReadonlySet<string>, source: ParameterChangeSource): void {
    for (const p of this.descriptor.parameters) {
      if (except.has(p.id)) continue;
      const raw = reported[p.index];
      if (raw === undefined || !Number.isFinite(raw)) continue;
      // Quantise like setParameter would, so float32 round-trips do not show up as drift.
      const { value } = clampParameterValue(p, raw);
      if (this.values.get(p.id) === value) continue;
      this.values.set(p.id, value);
      if (this.host.diagnosticsEnabled) this.host.reportDiagnostic({ kind: "parameter-update", instanceId: this.id, parameterId: p.id, value, clamped: false });
      this.emitter.emit("parameterchange", { instanceId: this.id, parameterId: p.id, value, normalized: toNormalized(p, value), clamped: false, source });
    }
  }

  setParameterNormalized(id: string, normalized: number): void {
    this.assertLive();
    const p = this.param(id);
    if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
      throw new AudiospanError("INVALID_PARAMETER", `normalized value for ${JSON.stringify(id)} must be a finite number`, { instanceId: this.id });
    }
    this.applyParameter(p, fromNormalized(p, normalized), "api", true);
  }

  getParameterNormalized(id: string): number {
    const p = this.param(id);
    return toNormalized(p, this.values.get(p.id)!);
  }

  resetParameters(): void {
    this.assertLive();
    for (const p of this.descriptor.parameters) this.applyParameter(p, p.default, "reset", true);
    this.emitter.emit("statechange", { instanceId: this.id, reason: "reset", warnings: [] });
  }

  setBypassed(bypassed: boolean): void {
    this.assertLive();
    const next = Boolean(bypassed);
    if (next === this.bypassed) return;
    this.bypassed = next;
    this.host.connection.send({ type: "SET_BYPASS", instanceId: this.id, bypassed: next, sequence: this.host.connection.nextSequence() });
    this.emitter.emit("bypasschange", { instanceId: this.id, bypassed: next });
  }

  isBypassed(): boolean {
    return this.bypassed;
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingOps++;
    try {
      return await fn();
    } finally {
      this.pendingOps--;
    }
  }

  async reset(): Promise<void> {
    this.assertLive();
    await this.track(async () => {
      await this.host.connection.request({ type: "RESET", requestId: this.host.connection.nextRequestId(), instanceId: this.id }, ["ACK"]);
      if (this.statusValue === "error") this.setStatus("ready");
    });
  }

  async getState(): Promise<PluginState> {
    this.assertLive();
    return this.track(async () => {
      const parameters: Record<string, number> = {};
      for (const p of this.descriptor.parameters) parameters[p.id] = this.values.get(p.id)!;
      const state: PluginState = { schemaVersion: 1, pluginId: this.descriptor.id, pluginVersion: this.descriptor.version, parameters };
      if (this.descriptor.capabilities.state) {
        const response = await this.host.connection.request({ type: "GET_STATE", requestId: this.host.connection.nextRequestId(), instanceId: this.id }, ["STATE"]);
        if (response.opaque.byteLength > 0) state.opaqueState = bytesToBase64(new Uint8Array(response.opaque));
      }
      return state;
    });
  }

  async setState(state: PluginState, options: SetStateOptions = {}): Promise<void> {
    this.assertLive();
    await this.applyState(state, options, "restore", undefined);
  }

  private async applyState(state: PluginState, options: SetStateOptions, reason: "restore" | "preset", presetId: string | undefined): Promise<void> {
    const validation = validatePluginState(state, this.descriptor.manifest, { strict: options.strict ?? false });
    if (!validation.ok) {
      const summary = validation.errors.map((e) => `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("; ");
      throw new AudiospanError("INVALID_STATE", `state rejected for plugin ${this.descriptor.id}: ${summary}`, { issues: validation.errors, instanceId: this.id });
    }
    const { parameters, opaqueBytes } = validation.state;
    if (opaqueBytes && !this.descriptor.capabilities.state) {
      throw new AudiospanError("INVALID_STATE", `plugin ${this.descriptor.id} does not support opaque state`, { instanceId: this.id });
    }
    const entries: [number, number][] = [];
    for (const [id, value] of Object.entries(parameters)) entries.push([this.byId.get(id)!.index, value]);
    const source: ParameterChangeSource = reason === "preset" ? "preset" : "state";
    await this.track(async () => {
      const opaque: ArrayBuffer | undefined = opaqueBytes ? opaqueBytes.slice().buffer as ArrayBuffer : undefined;
      const message = { type: "SET_STATE" as const, requestId: this.host.connection.nextRequestId(), instanceId: this.id, parameters: entries, ...(opaque ? { opaque } : {}) };
      const applied = await this.host.connection.request(message, ["STATE_APPLIED"], opaque ? [opaque] : undefined);
      // The runtime applied the state as a unit; mirror it on the control plane.
      // Explicit values are canonical; anything else the blob changed is adopted from the runtime.
      const explicit = new Set<string>();
      for (const [id, value] of Object.entries(parameters)) {
        this.applyParameter(this.byId.get(id)!, value, source, false);
        explicit.add(id);
      }
      if (opaque) this.adoptRuntimeValues(applied.parameters, explicit, source);
      if (this.statusValue === "error") this.setStatus("ready");
      if (this.host.diagnosticsEnabled) this.host.reportDiagnostic({ kind: "state-restore", instanceId: this.id, warnings: validation.warnings.length });
      this.emitter.emit("statechange", { instanceId: this.id, reason, warnings: validation.warnings, ...(presetId !== undefined ? { presetId } : {}) });
    });
  }

  async loadPreset(presetId: string): Promise<void> {
    this.assertLive();
    const preset = this.descriptor.presets.find((p) => p.id === presetId);
    if (!preset) throw new AudiospanError("PRESET_NOT_FOUND", `plugin ${this.descriptor.id} has no preset ${JSON.stringify(presetId)}`, { instanceId: this.id });
    await this.applyState(preset.state, {}, "preset", presetId);
  }

  on<K extends keyof PluginInstanceEvents>(event: K, listener: (event: PluginInstanceEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  async dispose(): Promise<void> {
    if (this.statusValue === "disposed") return;
    this.host.onInstanceDisposed(this.id);
    const wasReady = this.statusValue !== "created";
    this.statusValue = "disposed";
    try {
      if (wasReady) {
        await this.host.connection.request({ type: "DESTROY_INSTANCE", requestId: this.host.connection.nextRequestId(), instanceId: this.id }, ["ACK"]);
      }
    } catch (error) {
      if (!AudiospanError.is(error, "DISPOSED")) throw error;
    } finally {
      this.emitter.emit("statuschange", { instanceId: this.id, status: "disposed" });
      this.emitter.clear();
    }
  }

  /** @internal Mark disposed without talking to the runtime (host disposal). */
  markDisposed(): void {
    if (this.statusValue === "disposed") return;
    this.statusValue = "disposed";
    this.emitter.emit("statuschange", { instanceId: this.id, status: "disposed" });
    this.emitter.clear();
  }

  /** @internal */
  get hasPendingOperations(): boolean {
    return this.pendingOps > 0;
  }
}
