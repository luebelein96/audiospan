import type { NormalizedPluginManifest } from "@audiospan/manifest";
import { AS_OK, statusName } from "./abi.js";
import { RuntimeError, type RuntimeErrorCode } from "./errors.js";
import {
  DEFAULT_RUNTIME_CONFIG,
  PROTOCOL_VERSION,
  parseMainMessage,
  type MainToWorkletMessage,
  type RuntimeConfig,
  type RuntimeDiagnostic,
  type WorkletToMainMessage,
} from "./protocol.js";
import { mapSourceChannel, WasmPluginInstance } from "./wasm/instance.js";
import type { WasmMemoryInfo } from "./wasm/inspect.js";

export type PostMessageFn = (message: WorkletToMainMessage, transfer?: Transferable[]) => void;

interface LoadedPlugin {
  id: string;
  module: WebAssembly.Module | ArrayBuffer;
  memoryInfo: WasmMemoryInfo | undefined;
  manifest: NormalizedPluginManifest;
  instances: number;
}

interface Instance {
  id: string;
  plugin: LoadedPlugin;
  wasm: WasmPluginInstance;
  bypassed: boolean;
  /** Permanently bypassed after repeated failures until RESET or SET_STATE. */
  errored: boolean;
  consecutiveErrors: number;
  parameterSequence: number;
  bypassSequence: number;
  /** Latency last read from the plugin, or the manifest's static value. */
  latencyFrames: number;
  /** Set once `audiospan_get_output` fails; polling stops until RESET or SET_STATE. */
  outputsFailed: boolean;
}

/** Copies `srcCount` planar channels into `dstCount` channels with the v1 mapping rule. */
export function copyChannels(src: readonly Float32Array[], srcCount: number, dst: readonly Float32Array[], dstCount: number, frames: number): void {
  for (let c = 0; c < dstCount; c++) {
    const target = dst[c]!;
    const idx = mapSourceChannel(c, srcCount);
    if (idx < 0) {
      target.fill(0, 0, frames);
    } else {
      const source = src[idx]!;
      if (source.length === target.length) target.set(source);
      else for (let i = 0; i < frames; i++) target[i] = source[i]!;
    }
  }
}

const STATS_RING = 512;
const nowMs: (() => number) | undefined = typeof globalThis.performance?.now === "function" ? () => globalThis.performance.now() : undefined;

/** Limits how many unsolicited messages the audio thread posts per second. */
class TokenBucket {
  private tokens: number;
  private perSecond: number;
  private last = Date.now();
  /** Messages refused since the counter was last cleared. */
  dropped = 0;

  constructor(perSecond: number) {
    this.perSecond = perSecond;
    this.tokens = perSecond;
  }

  reset(perSecond: number): void {
    this.perSecond = perSecond;
    this.tokens = perSecond;
    this.last = Date.now();
    this.dropped = 0;
  }

  take(): boolean {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.perSecond, this.tokens + (elapsed / 1000) * this.perSecond);
      this.last = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    this.dropped++;
    return false;
  }
}

/**
 * The Audiospan runtime core. It is independent of AudioWorklet globals so
 * it can run in the worklet, in Node tests, or inside an in-process host.
 *
 * Threading model: `handleMessage` and `process` are always called from the
 * same thread (the rendering thread in a worklet; message handlers run
 * between render quanta). Commands therefore take effect at block
 * boundaries without a separate queue; sequence numbers still guard against
 * stale updates.
 */
export class AudiospanRuntime {
  private readonly post: PostMessageFn;
  private config: RuntimeConfig | null = null;
  private disposed = false;

  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly instances = new Map<string, Instance>();
  private chain: Instance[] = [];

  private scratchA: Float32Array[] = [];
  private scratchB: Float32Array[] = [];
  private scratchFrames = 0;

  // Unsolicited errors and diagnostics are limited separately: a burst of
  // per-block diagnostics must never starve an error the host has to see.
  private readonly errorTokens = new TokenBucket(DEFAULT_RUNTIME_CONFIG.diagnosticsPerSecond);
  private readonly diagnosticTokens = new TokenBucket(DEFAULT_RUNTIME_CONFIG.diagnosticsPerSecond);
  // Plugin log lines get their own bucket so a chatty plugin cannot starve diagnostics or errors.
  private readonly logTokens = new TokenBucket(DEFAULT_RUNTIME_CONFIG.diagnosticsPerSecond);
  private durations = new Float64Array(STATS_RING);
  private durationCount = 0;
  private blocksSinceReport = 0;
  private blocksSinceOutputs = 0;
  /** Live instances whose manifest declares outputs. */
  private outputInstances = 0;

  constructor(post: PostMessageFn) {
    this.post = post;
  }

  get isInitialized(): boolean {
    return this.config !== null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get activePluginCount(): number {
    return this.chain.length;
  }

  // ---------------------------------------------------------------------
  // Control plane
  // ---------------------------------------------------------------------

  /** Handle an untrusted message. Never throws; errors are posted back. */
  handleMessage(data: unknown): void {
    const parsed = parseMainMessage(data);
    if (!parsed.ok) {
      this.postError("PROTOCOL_MESSAGE_INVALID", parsed.error, parsed.requestId);
      return;
    }
    const message = parsed.message;
    if (this.disposed) {
      this.postError("RUNTIME_DISPOSED", "runtime has been disposed", "requestId" in message ? message.requestId : undefined);
      return;
    }
    if (message.type === "INIT") {
      this.handleInit(message);
      return;
    }
    if (!this.config) {
      this.postError("RUNTIME_NOT_INITIALIZED", "runtime has not been initialized", "requestId" in message ? message.requestId : undefined);
      return;
    }
    try {
      switch (message.type) {
        case "LOAD_PLUGIN":
          void this.handleLoadPlugin(message);
          break;
        case "UNLOAD_PLUGIN":
          this.handleUnloadPlugin(message);
          break;
        case "CREATE_INSTANCE":
          void this.handleCreateInstance(message);
          break;
        case "DESTROY_INSTANCE":
          this.handleDestroyInstance(message);
          break;
        case "SET_PARAMETER":
          this.handleSetParameter(message);
          break;
        case "SET_BYPASS":
          this.handleSetBypass(message);
          break;
        case "REPLACE_CHAIN":
          this.handleReplaceChain(message);
          break;
        case "RESET":
          this.handleReset(message);
          break;
        case "GET_PARAMETER":
          this.handleGetParameter(message);
          break;
        case "GET_STATE":
          this.handleGetState(message);
          break;
        case "SET_STATE":
          this.handleSetState(message);
          break;
        case "PING":
          this.post({ type: "ACK", requestId: message.requestId });
          break;
        case "DISPOSE":
          this.dispose();
          this.post({ type: "ACK", requestId: message.requestId });
          break;
        default: {
          const exhaustive: never = message;
          throw new Error(`unhandled message ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (error instanceof RuntimeError) this.postError(error.code, error.message, requestId, "instanceId" in message ? message.instanceId : undefined);
      else this.postError("ABI_TRAP", `unexpected runtime failure: ${(error as Error).message}`, requestId);
    }
  }

  private handleInit(message: Extract<MainToWorkletMessage, { type: "INIT" }>): void {
    if (this.config) {
      this.postError("RUNTIME_ALREADY_INITIALIZED", "runtime is already initialized", message.requestId);
      return;
    }
    this.config = message.config;
    this.errorTokens.reset(message.config.diagnosticsPerSecond);
    this.diagnosticTokens.reset(message.config.diagnosticsPerSecond);
    this.logTokens.reset(message.config.diagnosticsPerSecond);
    this.ensureScratch(message.config.maxFrames);
    this.post({ type: "READY", protocolVersion: PROTOCOL_VERSION, requestId: message.requestId });
    this.diagnostic({ kind: "worklet-initialized", sampleRate: message.config.sampleRate, maxChannels: message.config.maxChannels, maxFrames: message.config.maxFrames });
  }

  private async handleLoadPlugin(message: Extract<MainToWorkletMessage, { type: "LOAD_PLUGIN" }>): Promise<void> {
    const { pluginId, requestId } = message;
    if (this.plugins.has(pluginId)) {
      this.postError("PLUGIN_ALREADY_LOADED", `plugin "${pluginId}" is already loaded`, requestId, undefined, pluginId);
      return;
    }
    this.diagnostic({ kind: "plugin-load-start", pluginId });
    try {
      let module: WebAssembly.Module;
      if (message.module instanceof WebAssembly.Module) {
        module = message.module;
      } else {
        module = await WebAssembly.compile(message.module);
      }
      if (this.disposed) return;
      // Prove the module instantiates and negotiates before advertising it.
      const probe = await WasmPluginInstance.instantiate(module, this.instanceOptions(message.manifest, message.memoryInfo, pluginId));
      probe.destroy();
      if (this.disposed) return;
      if (this.plugins.has(pluginId)) {
        this.postError("PLUGIN_ALREADY_LOADED", `plugin "${pluginId}" is already loaded`, requestId, undefined, pluginId);
        return;
      }
      this.plugins.set(pluginId, { id: pluginId, module, memoryInfo: message.memoryInfo, manifest: message.manifest, instances: 0 });
      this.diagnostic({ kind: "plugin-load-success", pluginId });
      this.post({ type: "PLUGIN_READY", requestId, pluginId });
    } catch (error) {
      const code: RuntimeErrorCode = error instanceof RuntimeError ? error.code : "MODULE_INVALID";
      const text = (error as Error).message;
      this.diagnostic({ kind: "plugin-load-failure", pluginId, message: text });
      this.postError(code, text, requestId, undefined, pluginId);
    }
  }

  private instanceOptions(manifest: NormalizedPluginManifest, memoryInfo: WasmMemoryInfo | undefined, pluginId: string, instanceId?: string) {
    const config = this.config!;
    const channels = this.negotiateChannels(manifest);
    if (manifest.audio.maxFramesPerProcess < config.maxFrames) {
      throw new RuntimeError("FRAMES_UNSUPPORTED", `plugin supports ${manifest.audio.maxFramesPerProcess} frames per process but the host delivers up to ${config.maxFrames}`);
    }
    return {
      sampleRate: config.sampleRate,
      maxFrames: config.maxFrames,
      channels,
      maxMemoryBytes: manifest.resources.maxMemoryBytes,
      maxStateBytes: manifest.resources.maxStateBytes,
      memoryInfo,
      allowLogging: config.pluginLogging,
      outputCount: manifest.outputs.length,
      onLog: config.pluginLogging ? (level: number, bytes: Uint8Array) => this.postLog(pluginId, instanceId, level, bytes) : undefined,
    };
  }

  private negotiateChannels(manifest: NormalizedPluginManifest): number {
    const config = this.config!;
    const input = manifest.audio.inputs[0];
    const output = manifest.audio.outputs[0];
    if (!output) throw new RuntimeError("CHANNELS_UNSUPPORTED", "plugin declares no output port");
    let channels = Math.min(config.maxChannels, output.channels.max, input ? input.channels.max : config.maxChannels);
    if (channels < output.channels.min || (input && channels < input.channels.min)) {
      throw new RuntimeError("CHANNELS_UNSUPPORTED", `plugin requires more channels than the host provides (host max ${config.maxChannels})`);
    }
    if (channels < 1) channels = 1;
    return channels;
  }

  private handleUnloadPlugin(message: Extract<MainToWorkletMessage, { type: "UNLOAD_PLUGIN" }>): void {
    const plugin = this.plugins.get(message.pluginId);
    if (!plugin) throw new RuntimeError("PLUGIN_NOT_LOADED", `plugin "${message.pluginId}" is not loaded`);
    if (plugin.instances > 0) throw new RuntimeError("PLUGIN_IN_USE", `plugin "${message.pluginId}" still has ${plugin.instances} live instance(s)`);
    this.plugins.delete(message.pluginId);
    this.post({ type: "ACK", requestId: message.requestId });
  }

  private async handleCreateInstance(message: Extract<MainToWorkletMessage, { type: "CREATE_INSTANCE" }>): Promise<void> {
    const { requestId, instanceId, pluginId } = message;
    try {
      const plugin = this.plugins.get(pluginId);
      if (!plugin) throw new RuntimeError("PLUGIN_NOT_LOADED", `plugin "${pluginId}" is not loaded`);
      if (this.instances.has(instanceId)) throw new RuntimeError("INSTANCE_ALREADY_EXISTS", `instance "${instanceId}" already exists`);
      if (this.instances.size >= this.config!.maxPlugins) throw new RuntimeError("INSTANCE_LIMIT", `instance limit of ${this.config!.maxPlugins} reached`);
      const wasm = await WasmPluginInstance.instantiate(plugin.module, this.instanceOptions(plugin.manifest, plugin.memoryInfo, pluginId, instanceId));
      if (this.disposed) {
        wasm.destroy();
        return;
      }
      // Other creations may have completed while this one was instantiating: check again.
      if (this.instances.has(instanceId)) {
        wasm.destroy();
        throw new RuntimeError("INSTANCE_ALREADY_EXISTS", `instance "${instanceId}" already exists`);
      }
      if (this.instances.size >= this.config!.maxPlugins) {
        wasm.destroy();
        throw new RuntimeError("INSTANCE_LIMIT", `instance limit of ${this.config!.maxPlugins} reached`);
      }
      const initial = message.initialParameters ?? plugin.manifest.parameters.map((p) => p.default);
      for (let i = 0; i < initial.length && i < plugin.manifest.parameters.length; i++) {
        const status = wasm.setParameter(i, initial[i]!);
        if (status !== AS_OK) {
          wasm.destroy();
          throw new RuntimeError("INSTANCE_CREATE_FAILED", `plugin rejected initial value for parameter ${i} with ${statusName(status)}`, status);
        }
      }
      const latencyFrames = this.readLatency(wasm, instanceId) ?? plugin.manifest.audio.latencyFrames;
      const instance: Instance = { id: instanceId, plugin, wasm, bypassed: false, errored: false, consecutiveErrors: 0, parameterSequence: -1, bypassSequence: -1, latencyFrames, outputsFailed: false };
      this.instances.set(instanceId, instance);
      plugin.instances++;
      if (plugin.manifest.outputs.length > 0) this.outputInstances++;
      this.diagnostic({ kind: "plugin-instance-created", instanceId, pluginId, channels: wasm.channels, memoryBytes: wasm.memoryBytes });
      this.post({ type: "INSTANCE_READY", requestId, instanceId, channels: wasm.channels, latencyFrames });
    } catch (error) {
      const code: RuntimeErrorCode = error instanceof RuntimeError ? error.code : "INSTANCE_CREATE_FAILED";
      this.postError(code, (error as Error).message, requestId, instanceId, pluginId);
    }
  }

  private requireInstance(instanceId: string): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new RuntimeError("INSTANCE_NOT_FOUND", `instance "${instanceId}" does not exist`);
    return instance;
  }

  private handleDestroyInstance(message: Extract<MainToWorkletMessage, { type: "DESTROY_INSTANCE" }>): void {
    const instance = this.requireInstance(message.instanceId);
    this.destroyInstance(instance);
    this.post({ type: "ACK", requestId: message.requestId });
  }

  private destroyInstance(instance: Instance): void {
    if (this.chain.includes(instance)) this.chain = this.chain.filter((i) => i !== instance);
    this.instances.delete(instance.id);
    instance.plugin.instances--;
    if (instance.plugin.manifest.outputs.length > 0) this.outputInstances--;
    instance.wasm.destroy();
    this.diagnostic({ kind: "plugin-instance-disposed", instanceId: instance.id, pluginId: instance.plugin.id });
  }

  private handleSetParameter(message: Extract<MainToWorkletMessage, { type: "SET_PARAMETER" }>): void {
    const instance = this.instances.get(message.instanceId);
    if (!instance) return; // Instance may have been destroyed; parameter updates are fire-and-forget.
    if (message.sequence < instance.parameterSequence) return; // stale
    instance.parameterSequence = message.sequence;
    if (message.parameterIndex >= instance.plugin.manifest.parameters.length) {
      this.postError("PARAMETER_INDEX_INVALID", `parameter index ${message.parameterIndex} is out of range`, undefined, instance.id);
      return;
    }
    const status = instance.wasm.setParameter(message.parameterIndex, message.value);
    if (status !== AS_OK) {
      this.postError("ABI_CALL_FAILED", `audiospan_set_parameter(${message.parameterIndex}) failed with ${statusName(status)}`, undefined, instance.id);
      return;
    }
    this.refreshLatency(instance);
  }

  /** Read the plugin's latency, or undefined when it reports none; a failing export is reported and ignored. */
  private readLatency(wasm: WasmPluginInstance, instanceId: string): number | undefined {
    try {
      return wasm.getLatency();
    } catch (error) {
      this.postError(error instanceof RuntimeError ? error.code : "ABI_CALL_FAILED", `audiospan_get_latency failed: ${(error as Error).message}`, undefined, instanceId);
      return undefined;
    }
  }

  /** Re-read the latency after a change that may affect it and tell the host when it moved. */
  private refreshLatency(instance: Instance): void {
    if (!instance.wasm.supportsLatency) return;
    const next = this.readLatency(instance.wasm, instance.id);
    if (next === undefined || next === instance.latencyFrames) return;
    instance.latencyFrames = next;
    this.post({ type: "LATENCY_CHANGED", instanceId: instance.id, latencyFrames: next });
  }

  private handleSetBypass(message: Extract<MainToWorkletMessage, { type: "SET_BYPASS" }>): void {
    const instance = this.instances.get(message.instanceId);
    if (!instance) return;
    if (message.sequence < instance.bypassSequence) return;
    instance.bypassSequence = message.sequence;
    instance.bypassed = message.bypassed;
  }

  private handleReplaceChain(message: Extract<MainToWorkletMessage, { type: "REPLACE_CHAIN" }>): void {
    const next: Instance[] = [];
    const seen = new Set<string>();
    for (const id of message.instanceIds) {
      if (seen.has(id)) throw new RuntimeError("PROTOCOL_MESSAGE_INVALID", `instance "${id}" appears twice in the chain`);
      seen.add(id);
      next.push(this.requireInstance(id));
    }
    if (next.length > this.config!.maxPlugins) throw new RuntimeError("INSTANCE_LIMIT", `chain exceeds the instance limit of ${this.config!.maxPlugins}`);
    this.chain = next; // atomic swap at a block boundary
    this.diagnostic({ kind: "chain-replaced", instanceIds: next.map((i) => i.id) });
    this.post({ type: "ACK", requestId: message.requestId });
  }

  private handleReset(message: Extract<MainToWorkletMessage, { type: "RESET" }>): void {
    const instance = this.requireInstance(message.instanceId);
    const status = instance.wasm.reset();
    if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_reset failed with ${statusName(status)}`, status);
    instance.errored = false;
    instance.consecutiveErrors = 0;
    instance.outputsFailed = false;
    this.refreshLatency(instance);
    this.post({ type: "ACK", requestId: message.requestId });
  }

  private handleGetParameter(message: Extract<MainToWorkletMessage, { type: "GET_PARAMETER" }>): void {
    const instance = this.requireInstance(message.instanceId);
    if (message.parameterIndex >= instance.plugin.manifest.parameters.length) throw new RuntimeError("PARAMETER_INDEX_INVALID", `parameter index ${message.parameterIndex} is out of range`);
    const value = instance.wasm.getParameter(message.parameterIndex);
    this.post({ type: "PARAMETER_VALUE", requestId: message.requestId, instanceId: instance.id, value });
  }

  private handleGetState(message: Extract<MainToWorkletMessage, { type: "GET_STATE" }>): void {
    const instance = this.requireInstance(message.instanceId);
    const bytes = instance.wasm.getState();
    const opaque = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    this.post({ type: "STATE", requestId: message.requestId, instanceId: instance.id, opaque: opaque as ArrayBuffer }, [opaque as ArrayBuffer]);
  }

  /**
   * Apply opaque state and/or parameter values as one unit: if any step is
   * refused, the instance is restored to what it held before the request.
   */
  private handleSetState(message: Extract<MainToWorkletMessage, { type: "SET_STATE" }>): void {
    const instance = this.requireInstance(message.instanceId);
    const parameters = instance.plugin.manifest.parameters;
    for (const [index] of message.parameters) {
      if (index >= parameters.length) throw new RuntimeError("PARAMETER_INDEX_INVALID", `parameter index ${index} is out of range`);
    }
    const wasm = instance.wasm;
    const previousOpaque = message.opaque ? wasm.getState() : undefined;
    const previousValues = parameters.map((_, index) => wasm.getParameter(index));
    try {
      if (message.opaque) {
        const status = wasm.setState(new Uint8Array(message.opaque));
        if (status !== AS_OK) throw new RuntimeError("STATE_REJECTED", `plugin rejected opaque state with ${statusName(status)}`, status);
      }
      for (const [index, value] of message.parameters) {
        const status = wasm.setParameter(index, value);
        if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_set_parameter(${index}) failed with ${statusName(status)}`, status);
      }
    } catch (error) {
      this.restoreState(wasm, previousOpaque, previousValues);
      throw error;
    }
    instance.errored = false;
    instance.consecutiveErrors = 0;
    instance.outputsFailed = false;
    // Report what the plugin holds now: the blob may have set parameters the message did not list.
    const applied = parameters.map((_, index) => wasm.getParameter(index));
    this.post({ type: "STATE_APPLIED", requestId: message.requestId, instanceId: instance.id, parameters: applied });
    this.refreshLatency(instance);
  }

  private restoreState(wasm: WasmPluginInstance, opaque: Uint8Array | undefined, values: readonly number[]): void {
    try {
      if (opaque !== undefined) wasm.setState(opaque);
      for (let i = 0; i < values.length; i++) wasm.setParameter(i, values[i]!);
    } catch {
      // The plugin failed while being restored; the original error is what the host sees.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chain = [];
    for (const instance of this.instances.values()) instance.wasm.destroy();
    this.instances.clear();
    this.plugins.clear();
  }

  // ---------------------------------------------------------------------
  // Audio thread
  // ---------------------------------------------------------------------

  private ensureScratch(frames: number): void {
    if (this.scratchFrames === frames && this.scratchA.length === this.config!.maxChannels) return;
    const channels = this.config!.maxChannels;
    this.scratchA = [];
    this.scratchB = [];
    for (let c = 0; c < channels; c++) {
      this.scratchA.push(new Float32Array(frames));
      this.scratchB.push(new Float32Array(frames));
    }
    this.scratchFrames = frames;
  }

  /**
   * Process one render quantum. `inputs` holds the planar channels of the
   * single input (possibly empty when disconnected); `outputs` the planar
   * channels of the single output. Returns true to keep the processor alive.
   *
   * Each stage reads straight from the previous plugin's output buffers in
   * module memory; the scratch buffers are only used to pass a block through
   * a bypassed, errored, or failing stage.
   */
  process(inputs: readonly Float32Array[], outputs: readonly Float32Array[]): boolean {
    if (this.disposed) return false;
    const config = this.config;
    const outCount = outputs.length;
    if (!config || outCount === 0) return true;
    const frames = outputs[0]!.length;
    const inCount = inputs.length;
    const chain = this.chain;

    if (chain.length === 0) {
      copyChannels(inputs, inCount, outputs, outCount, frames);
      return true;
    }
    if (frames > config.maxFrames) {
      copyChannels(inputs, inCount, outputs, outCount, frames);
      this.diagnostic({ kind: "frames-unsupported", frames, maxFrames: config.maxFrames });
      return true;
    }
    if (frames !== this.scratchFrames) this.ensureScratch(frames);

    const start = config.diagnostics && nowMs ? nowMs() : 0;
    let src: readonly Float32Array[] = inputs;
    let srcCount = inCount;
    let useA = true;
    for (let k = 0; k < chain.length; k++) {
      const instance = chain[k]!;
      const channels = instance.wasm.channels;
      let processed: readonly Float32Array[] | undefined;
      if (!instance.bypassed && !instance.errored) {
        let status = -1;
        let failure: string | undefined;
        try {
          status = instance.wasm.processBlock(src, srcCount, frames);
          if (status !== AS_OK) failure = `audiospan_process returned ${statusName(status)}`;
        } catch (error) {
          failure = (error as Error).message;
        }
        if (instance.wasm.memoryGrewDuringProcess) {
          instance.wasm.memoryGrewDuringProcess = false;
          failure ??= "memory grew during process";
          this.diagnostic({ kind: "memory-growth", instanceId: instance.id, memoryBytes: instance.wasm.memoryBytes });
        }
        if (failure !== undefined) {
          this.recordProcessError(instance, failure, status);
        } else {
          instance.consecutiveErrors = 0;
          processed = instance.wasm.outputViews;
          if (config.scanNonFinite) this.scanNonFinite(instance, processed, channels, frames);
        }
      }
      if (processed === undefined) {
        // Bypassed, errored, or failed this block: pass the input through.
        const dst = useA ? this.scratchA : this.scratchB;
        copyChannels(src, srcCount, dst, channels, frames);
        processed = dst;
        useA = !useA;
      }
      src = processed;
      srcCount = channels;
    }
    copyChannels(src, srcCount, outputs, outCount, frames);

    if (this.outputInstances > 0) this.pollOutputs(frames);
    if (start !== 0) this.recordDuration(nowMs!() - start, frames);
    return true;
  }

  /**
   * Read every live instance's output values (manifest `outputs`) at most
   * `outputsPerSecond` times per second and post them in one message. Runs on
   * the audio thread between plugin calls, which the ABI permits; the per-tick
   * allocation is bounded by the configured rate.
   */
  private pollOutputs(frames: number): void {
    const config = this.config!;
    if (config.outputsPerSecond <= 0) return;
    this.blocksSinceOutputs++;
    const interval = Math.max(1, Math.round(config.sampleRate / frames / config.outputsPerSecond));
    if (this.blocksSinceOutputs < interval) return;
    this.blocksSinceOutputs = 0;
    const values: [string, number[]][] = [];
    for (const instance of this.instances.values()) {
      const count = instance.plugin.manifest.outputs.length;
      if (count === 0 || instance.outputsFailed || instance.errored) continue;
      const list = new Array<number>(count);
      try {
        for (let i = 0; i < count; i++) list[i] = instance.wasm.getOutput(i);
      } catch (error) {
        instance.outputsFailed = true;
        this.postError(error instanceof RuntimeError ? error.code : "ABI_CALL_FAILED", `output polling stopped for instance "${instance.id}": ${(error as Error).message}`, undefined, instance.id);
        continue;
      }
      values.push([instance.id, list]);
    }
    if (values.length > 0) this.post({ type: "OUTPUT_VALUES", values });
  }

  private scanNonFinite(instance: Instance, buffers: readonly Float32Array[], channels: number, frames: number): void {
    let count = 0;
    for (let c = 0; c < channels; c++) {
      const buffer = buffers[c]!;
      for (let i = 0; i < frames; i++) {
        const v = buffer[i]!;
        if (v - v !== 0) {
          buffer[i] = 0;
          count++;
        }
      }
    }
    if (count > 0) this.diagnostic({ kind: "non-finite-output", instanceId: instance.id, count });
  }

  private recordProcessError(instance: Instance, message: string, status: number): void {
    instance.consecutiveErrors++;
    const threshold = this.config!.processErrorBypassThreshold;
    if (instance.consecutiveErrors >= threshold && !instance.errored) {
      instance.errored = true;
      this.postError("INSTANCE_ERRORED", `instance bypassed after ${instance.consecutiveErrors} consecutive processing failures: ${message}`, undefined, instance.id);
    }
    this.diagnostic({
      kind: "audio-processing-error",
      instanceId: instance.id,
      message,
      status: status >= 0 ? status : undefined,
      consecutiveErrors: instance.consecutiveErrors,
      bypassed: instance.errored,
    });
  }

  private recordDuration(durationMs: number, frames: number): void {
    const config = this.config!;
    this.durations[this.durationCount % STATS_RING] = durationMs;
    this.durationCount++;
    this.blocksSinceReport++;
    const budgetMs = (frames / config.sampleRate) * 1000;
    if (durationMs > budgetMs) this.diagnostic({ kind: "processing-over-budget", durationMs, budgetMs });
    const blocksPerSecond = Math.max(1, Math.round(config.sampleRate / frames));
    if (this.blocksSinceReport >= blocksPerSecond) {
      this.blocksSinceReport = 0;
      const n = Math.min(this.durationCount, STATS_RING);
      const sorted = Array.from(this.durations.subarray(0, n)).sort((a, b) => a - b);
      const pick = (q: number) => sorted[Math.min(n - 1, Math.floor(q * (n - 1)))] ?? 0;
      this.diagnostic({ kind: "processing-stats", blocks: n, medianMs: pick(0.5), p95Ms: pick(0.95), p99Ms: pick(0.99), maxMs: sorted[n - 1] ?? 0, budgetMs, activePlugins: this.chain.length });
    }
  }

  // ---------------------------------------------------------------------
  // Messaging helpers
  // ---------------------------------------------------------------------

  private postError(code: RuntimeErrorCode, message: string, requestId?: number, instanceId?: string, pluginId?: string): void {
    // Replies are never dropped. Unsolicited errors are rate limited, except the
    // one-shot INSTANCE_ERRORED transition, which the host must see to mirror the bypass.
    if (requestId === undefined && code !== "INSTANCE_ERRORED" && !this.errorTokens.take()) return;
    const error: WorkletToMainMessage = { type: "ERROR", code, message };
    if (requestId !== undefined) error.requestId = requestId;
    if (instanceId !== undefined) error.instanceId = instanceId;
    if (pluginId !== undefined) error.pluginId = pluginId;
    this.post(error);
  }

  /** Forward a plugin log line (raw UTF-8; the host decodes), rate limited by its own token bucket. */
  private postLog(pluginId: string, instanceId: string | undefined, level: number, bytes: Uint8Array): void {
    if (!this.config?.pluginLogging || this.disposed) return;
    if (!this.logTokens.take()) return;
    const dropped = this.logTokens.dropped;
    this.logTokens.dropped = 0;
    const log: WorkletToMainMessage = { type: "LOG", pluginId, level, bytes, dropped };
    if (instanceId !== undefined) log.instanceId = instanceId;
    this.post(log);
  }

  private diagnostic(event: RuntimeDiagnostic): void {
    if (!this.config?.diagnostics) return;
    if (!this.diagnosticTokens.take()) return;
    if (this.diagnosticTokens.dropped > 0) {
      const count = this.diagnosticTokens.dropped;
      this.diagnosticTokens.dropped = 0;
      this.post({ type: "DIAGNOSTIC", event: { kind: "diagnostics-dropped", count } });
    }
    this.post({ type: "DIAGNOSTIC", event });
  }
}
