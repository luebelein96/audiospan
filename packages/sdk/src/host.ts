import type { ManifestPolicy, NormalizedPluginManifest, PluginState, ValidationIssue } from "@audiospan/manifest";
import { validatePluginState } from "@audiospan/manifest";
import {
  DEFAULT_RUNTIME_CONFIG,
  PROCESSOR_NAME,
  PROTOCOL_VERSION,
  validateRuntimeConfig,
  type RuntimeConfig,
  type RuntimeDiagnostic,
} from "@audiospan/runtime";
import { AudioChainImpl } from "./chain.js";
import { RuntimeConnection, type LogMessage } from "./connection.js";
import { AudiospanError } from "./errors.js";
import { Emitter, type Unsubscribe } from "./events.js";
import { PluginInstanceImpl } from "./instance.js";
import type { HostInternals } from "./internal.js";
import { loadArtifact, simdHint, throwIfAborted, type LoadedArtifact, type PluginSourceInput } from "./loader.js";
import { resolvePolicy, type PluginPolicy } from "./policy.js";
import { AudioWorkletTransport, type WorkletTransport } from "./transport.js";
import { WORKLET_SOURCE } from "./generated/worklet-source.js";
import type { AudioChain, AudiospanDiagnostic, HostEvents, HostStatus, PluginDescriptor, PluginInstance, PluginLogEvent, PluginLogLevel } from "./types.js";

const LOG_LEVELS: readonly PluginLogLevel[] = ["error", "warn", "info", "debug"];
const utf8 = new TextDecoder("utf-8", { fatal: false });

export interface AudiospanHostOptions {
  /** A caller-owned AudioContext (or OfflineAudioContext). Create/resume it from a user gesture. */
  audioContext?: BaseAudioContext;
  /**
   * URL of the worklet script (dist/audiospan-worklet.js from @audiospan/runtime).
   * Optional: without it the SDK loads its embedded copy of the same script
   * through a blob URL, so nothing has to be copied or served. Pass a URL when
   * your Content Security Policy forbids `blob:` scripts.
   */
  workletUrl?: string;
  /** Maximum live plugin instances (default 8). */
  maxPlugins?: number;
  /** Channel count routed through the chain (default 2). */
  maxChannels?: number;
  /** Largest render quantum the runtime will accept (default 128). */
  maxFrames?: number;
  /** Emit diagnostics events (default false). Lightweight but not free. */
  diagnostics?: boolean;
  /**
   * Replace NaN/Infinity samples in each plugin's output with zero (default
   * false). Independent of `diagnostics`; when both are on, each occurrence
   * is reported as a `non-finite-output` diagnostic. Costs one pass over
   * every output sample per plugin.
   */
  scanNonFinite?: boolean;
  /** Consecutive failed blocks before an instance is bypassed until reset (default 3). */
  processErrorBypassThreshold?: number;
  /** Maximum unsolicited diagnostics (and errors) per second from the audio thread (default 20). */
  diagnosticsPerSecond?: number;
  /**
   * Development aid (default false): accept plugins built with logging
   * enabled (`audiospan build --dev`) and deliver their log lines as
   * `pluginlog` host events and `log` instance events, or to the console when
   * nobody listens. Off, such modules are rejected at load because they
   * import `env.audiospan_log`. Lines are rate limited like diagnostics.
   */
  pluginLogging?: boolean;
  /** How many times per second read-only output values (manifest `outputs`) are delivered (default 30; 0 disables). */
  outputsPerSecond?: number;
  onError?: (error: AudiospanError) => void;
  onDiagnostic?: (event: AudiospanDiagnostic) => void;
  pluginPolicy?: Partial<PluginPolicy>;
  /** Milliseconds to wait for runtime acknowledgements (default 10000; 0 disables). */
  requestTimeoutMs?: number;
  /** Advanced: bypass AudioWorkletNode creation and talk to a runtime through this transport. */
  transport?: WorkletTransport;
  /** Sample rate for custom transports without an AudioContext. */
  sampleRate?: number;
  /** Custom fetch (tests, custom caching). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * How modules reach the worklet. "bytes" (default) transfers a copy of the
   * binary and compiles it in the worklet (asynchronously, off the audio
   * callback). "module" posts a precompiled WebAssembly.Module, which some
   * browsers cannot clone into an AudioWorklet; the host detects that and
   * falls back to bytes.
   */
  moduleTransfer?: "bytes" | "module";
}

export interface CreatePluginOptions {
  initialState?: PluginState;
  /** Explicit instance id (must be unique within the host). */
  instanceId?: string;
}

export interface LoadPluginOptions {
  /**
   * Abort the load. Honoured while fetching, validating and compiling; once
   * the module has been handed to the runtime the load completes normally.
   * Rejects with `ABORTED`.
   */
  signal?: AbortSignal;
}

export interface AddPluginOptions extends CreatePluginOptions, LoadPluginOptions {
  /** Position in the active chain (default: the end). */
  index?: number;
}

interface LoadedPlugin {
  descriptor: PluginDescriptor;
  artifact: LoadedArtifact;
  instances: Set<string>;
}

let hostCounter = 0;

function sourceKeyOf(source: PluginSourceInput): string | undefined {
  return typeof source === "string" ? source : source instanceof URL ? source.href : undefined;
}

function describe(artifact: LoadedArtifact): PluginDescriptor {
  const m = artifact.manifest;
  return Object.freeze({
    id: m.id,
    name: m.name,
    version: m.version,
    vendor: m.vendor,
    description: m.description,
    category: m.category,
    license: m.license,
    parameters: m.parameters,
    outputs: m.outputs,
    audioInputs: m.audio.inputs,
    audioOutputs: m.audio.outputs,
    capabilities: m.capabilities,
    resources: m.resources,
    latencyFrames: m.audio.latencyFrames,
    maxFramesPerProcess: m.audio.maxFramesPerProcess,
    presets: artifact.presets,
    sourceUrl: artifact.sourceUrl,
    moduleByteLength: artifact.moduleBytes.byteLength,
    warnings: artifact.warnings,
    manifest: m,
  });
}

/**
 * The Audiospan host: owns one AudioWorkletNode running the Audiospan
 * runtime, the plugin registry, and the active serial chain.
 */
export class AudiospanHost {
  static async create(options: AudiospanHostOptions): Promise<AudiospanHost> {
    const policy = resolvePolicy(options.pluginPolicy);
    const config: RuntimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      sampleRate: Math.round(options.sampleRate ?? options.audioContext?.sampleRate ?? 0),
      maxChannels: options.maxChannels ?? DEFAULT_RUNTIME_CONFIG.maxChannels,
      maxFrames: options.maxFrames ?? DEFAULT_RUNTIME_CONFIG.maxFrames,
      maxPlugins: options.maxPlugins ?? policy.maxInstances,
      diagnostics: options.diagnostics ?? DEFAULT_RUNTIME_CONFIG.diagnostics,
      scanNonFinite: options.scanNonFinite ?? DEFAULT_RUNTIME_CONFIG.scanNonFinite,
      processErrorBypassThreshold: options.processErrorBypassThreshold ?? DEFAULT_RUNTIME_CONFIG.processErrorBypassThreshold,
      diagnosticsPerSecond: options.diagnosticsPerSecond ?? DEFAULT_RUNTIME_CONFIG.diagnosticsPerSecond,
      pluginLogging: options.pluginLogging ?? DEFAULT_RUNTIME_CONFIG.pluginLogging,
      outputsPerSecond: options.outputsPerSecond ?? DEFAULT_RUNTIME_CONFIG.outputsPerSecond,
    };
    if (!Number.isInteger(config.sampleRate) || config.sampleRate <= 0) throw new AudiospanError("NOT_SUPPORTED", "an audioContext (or sampleRate) is required");
    const checked = validateRuntimeConfig(config);
    if (typeof checked === "string") throw new AudiospanError("NOT_SUPPORTED", checked);

    let node: AudioWorkletNode | null = null;
    let transport: WorkletTransport;
    if (options.transport) {
      transport = options.transport;
    } else {
      const context = options.audioContext;
      if (!context) throw new AudiospanError("NOT_SUPPORTED", "audioContext is required unless a custom transport is supplied");
      if (typeof AudioWorkletNode === "undefined" || !context.audioWorklet) {
        throw new AudiospanError("NOT_SUPPORTED", "AudioWorklet is not available in this environment; Audiospan requires a browser with AudioWorklet support on a secure context");
      }
      // No workletUrl: load the embedded copy of the worklet through a blob URL, so nothing has to be copied or served.
      const embedded = options.workletUrl === undefined;
      const workletUrl = options.workletUrl ?? URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(workletUrl);
      } catch (error) {
        const where = embedded ? "the embedded Audiospan worklet (blob URL)" : `the Audiospan worklet from ${workletUrl}`;
        const advice = embedded
          ? "If your Content Security Policy restricts script-src, allow blob: or serve @audiospan/runtime/dist/audiospan-worklet.js and pass its URL as workletUrl."
          : "Verify the URL is reachable, served as JavaScript, same-origin or CORS-enabled, and that the page is a secure context.";
        throw new AudiospanError("WORKLET_INIT_FAILED", `failed to load ${where}: ${(error as Error).message}. ${advice}`, { cause: error });
      } finally {
        if (embedded) URL.revokeObjectURL(workletUrl);
      }
      try {
        node = new AudioWorkletNode(context, PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [config.maxChannels],
          channelCount: config.maxChannels,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
      } catch (error) {
        const message = (error as Error).message;
        // addModule resolves even when the worklet script throws while evaluating; the failure only shows here.
        const hint = /not defined in AudioWorkletGlobalScope/.test(message)
          ? ` The worklet script${options.workletUrl ? ` at ${options.workletUrl}` : ""} loaded but never registered its processor, which means it threw while evaluating, typically by using an API that AudioWorkletGlobalScope does not provide (TextDecoder, fetch, timers). Check the browser console for the thrown error and that the file is an unmodified Audiospan worklet build.`
          : "";
        throw new AudiospanError("WORKLET_INIT_FAILED", `failed to create the Audiospan AudioWorkletNode: ${message}.${hint}`, { cause: error });
      }
      transport = new AudioWorkletTransport(node);
    }

    const host = new AudiospanHost(options, policy, config, transport, node);
    try {
      await host.initialize();
    } catch (error) {
      host.teardown();
      throw error;
    }
    return host;
  }

  readonly id: string;
  readonly audioContext: BaseAudioContext | undefined;
  readonly node: AudioWorkletNode | null;
  readonly policy: Readonly<PluginPolicy>;
  readonly config: Readonly<RuntimeConfig>;

  private readonly connection: RuntimeConnection;
  private readonly emitter: Emitter<HostEvents>;
  private readonly fetchFn: typeof fetch | undefined;
  private readonly moduleTransfer: "bytes" | "module";
  private readonly plugins = new Map<string, LoadedPlugin>();
  /** Plugin ids whose load is in flight, so concurrent loads of one id are refused up front. */
  private readonly loading = new Set<string>();
  /** URL or href as passed to loadPlugin → plugin id, so addPlugin can reuse a load without refetching. */
  private readonly loadedSources = new Map<string, string>();
  private readonly instances = new Map<string, PluginInstanceImpl>();
  /** Instance ids reserved by in-flight creations; they count against maxPlugins. */
  private readonly reservedIds = new Set<string>();
  private readonly chains = new Set<AudioChainImpl>();
  private activeChain: AudioChainImpl | null = null;
  private readonly sources = new Set<AudioNode>();
  private readonly destinations = new Set<AudioNode>();
  private statusValue: HostStatus = "ready";
  private instanceCounter = 0;
  private readonly internals: HostInternals;

  private constructor(options: AudiospanHostOptions, policy: PluginPolicy, config: RuntimeConfig, transport: WorkletTransport, node: AudioWorkletNode | null) {
    this.id = `audiospan-host-${++hostCounter}`;
    this.audioContext = options.audioContext;
    this.node = node;
    this.policy = Object.freeze({ ...policy });
    this.config = Object.freeze({ ...config });
    this.fetchFn = options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    this.moduleTransfer = options.moduleTransfer ?? "bytes";
    this.emitter = new Emitter<HostEvents>((error) => {
      // A listener threw. Avoid recursion: report to console in diagnostics mode only.
      if (this.config.diagnostics) console.error("[audiospan] listener error", error);
    });
    if (options.onError) this.emitter.on("error", options.onError);
    if (options.onDiagnostic) this.emitter.on("diagnostic", options.onDiagnostic);
    this.connection = new RuntimeConnection(transport, options.requestTimeoutMs ?? 10_000, {
      onError: (error) => this.handleRuntimeError(error),
      onDiagnostic: (event) => this.handleRuntimeDiagnostic(event),
      onLatency: (instanceId, latencyFrames) => this.instances.get(instanceId)?.handleLatency(latencyFrames),
      onOutputs: (values) => {
        for (const [instanceId, list] of values) this.instances.get(instanceId)?.handleOutputValues(list);
      },
      onLog: (message) => this.handlePluginLog(message),
    });
    if (node) {
      node.onprocessorerror = () => {
        this.emitError(new AudiospanError("WORKLET_PROCESSOR_ERROR", "the Audiospan AudioWorkletProcessor threw an unrecoverable error; audio through this host has stopped"));
      };
    }
    this.internals = {
      connection: this.connection,
      diagnosticsEnabled: config.diagnostics,
      reportError: (error) => this.emitError(error),
      reportDiagnostic: (event) => this.emitter.emit("diagnostic", event),
      onInstanceDisposed: (instanceId) => this.forgetInstance(instanceId),
      onChainDisposed: (chainId) => this.forgetChain(chainId),
    };
  }

  private async initialize(): Promise<void> {
    try {
      await this.connection.request({ type: "INIT", protocolVersion: PROTOCOL_VERSION, requestId: this.connection.nextRequestId(), config: { ...this.config } }, ["READY"]);
    } catch (error) {
      const detail = AudiospanError.is(error, "REQUEST_TIMEOUT")
        ? `${error.message}. The worklet file may be stale or from a different version.`
        : `${(error as Error).message}. The worklet file may be from a different Audiospan version (this SDK speaks protocol ${PROTOCOL_VERSION}).`;
      throw new AudiospanError("WORKLET_INIT_FAILED", `the Audiospan runtime did not become ready: ${detail}`, { cause: error });
    }
  }

  get status(): HostStatus {
    return this.statusValue;
  }

  private assertLive(): void {
    if (this.statusValue === "disposed") throw new AudiospanError("DISPOSED", "host has been disposed");
  }

  /**
   * Deliver an error to host listeners. When nobody is listening, here or on
   * the instance it concerns, warn on the console rather than drop it: a
   * bypassed plugin or a refused chain edit must not vanish silently.
   */
  private emitError(error: AudiospanError, observedElsewhere = false): void {
    if (this.emitter.listenerCount("error") === 0) {
      if (!observedElsewhere) console.warn(`[audiospan] unhandled error ${error.code}: ${error.message} (pass onError or subscribe with host.on("error") to receive it)`);
      return;
    }
    this.emitter.emit("error", error);
  }

  private handleRuntimeError(error: AudiospanError): void {
    const instance = error.instanceId !== undefined ? this.instances.get(error.instanceId) : undefined;
    instance?.handleRuntimeError(error);
    this.emitError(error, instance?.hasErrorListeners ?? false);
  }

  private handleRuntimeDiagnostic(event: RuntimeDiagnostic): void {
    this.emitter.emit("diagnostic", event);
  }

  /**
   * Deliver a plugin log line to the instance's `log` listeners and the host's
   * `pluginlog` listeners; print it when neither has any, so a development
   * build's output is never silently lost.
   */
  private handlePluginLog(raw: LogMessage): void {
    const level = LOG_LEVELS[raw.level] ?? "info";
    const event: PluginLogEvent = { pluginId: raw.pluginId, instanceId: raw.instanceId, level, message: utf8.decode(raw.bytes), dropped: raw.dropped };
    const instance = raw.instanceId !== undefined ? this.instances.get(raw.instanceId) : undefined;
    const seenByInstance = instance?.handleLog(event) ?? false;
    const seenByHost = this.emitter.listenerCount("pluginlog") > 0;
    if (seenByHost) this.emitter.emit("pluginlog", event);
    if (seenByInstance || seenByHost) return;
    const print = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.info;
    print(`[audiospan] ${raw.pluginId}${raw.instanceId !== undefined ? ` ${raw.instanceId}` : ""}: ${event.message}${raw.dropped > 0 ? ` (+${raw.dropped} dropped)` : ""}`);
  }

  on<K extends keyof HostEvents>(event: K, listener: (payload: HostEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener);
  }

  // -------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------

  private manifestPolicy(): ManifestPolicy {
    return {
      maxMemoryBytes: this.policy.maxMemoryBytes,
      maxStateBytes: this.policy.maxStateBytes,
      maxChannels: this.config.maxChannels,
      maxFramesPerProcess: this.config.maxFrames,
      allowedCapabilities: { customUI: this.policy.allowedUiModes.some((m) => m !== "none") },
    };
  }

  /** Fetch, validate, and register a plugin. Resolves with its descriptor once the runtime has compiled it. */
  async loadPlugin(source: PluginSourceInput, options: LoadPluginOptions = {}): Promise<PluginDescriptor> {
    this.assertLive();
    const signal = options.signal;
    const started = Date.now();
    const sourceLabel = typeof source === "string" ? source : source instanceof URL ? source.href : (source.sourceUrl ?? "inline");
    const fetchFn = this.fetchFn;
    if (!fetchFn && (typeof source === "string" || source instanceof URL)) {
      throw new AudiospanError("NOT_SUPPORTED", "fetch is not available; pass an inline PluginSource or a custom fetch");
    }
    // Keep opaque origins ("null" for file:// and sandboxed pages) so same-origin
    // checks still apply; undefined means there is no page at all.
    const pageOrigin = typeof globalThis.location !== "undefined" ? globalThis.location.origin : undefined;
    let artifact: LoadedArtifact;
    try {
      artifact = await loadArtifact(source, {
        policy: this.policy,
        manifestPolicy: this.manifestPolicy(),
        fetch: fetchFn ?? (() => Promise.reject(new Error("fetch unavailable"))),
        pageOrigin,
        allowLogging: this.config.pluginLogging,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const err = error instanceof AudiospanError ? error : new AudiospanError("MANIFEST_INVALID", (error as Error).message, { cause: error });
      this.emitter.emit("diagnostic", { kind: "plugin-load-failure", pluginId: err.pluginId ?? "unknown", sourceUrl: sourceLabel, message: err.message });
      throw err;
    }
    const manifest = artifact.manifest;
    if (this.plugins.has(manifest.id) || this.loading.has(manifest.id)) {
      throw new AudiospanError("PLUGIN_ALREADY_LOADED", `plugin ${manifest.id} is already loaded`, { pluginId: manifest.id });
    }
    this.loading.add(manifest.id);
    try {
      this.emitter.emit("diagnostic", { kind: "plugin-load-start", pluginId: manifest.id, sourceUrl: artifact.sourceUrl });
      if (artifact.warnings.length > 0) this.emitter.emit("diagnostic", { kind: "plugin-load-warning", pluginId: manifest.id, issues: artifact.warnings });

      await this.sendLoad(manifest, artifact, signal);
      const descriptor = describe(artifact);
      this.plugins.set(manifest.id, { descriptor, artifact, instances: new Set() });
      const sourceKey = sourceKeyOf(source);
      if (sourceKey !== undefined) this.loadedSources.set(sourceKey, manifest.id);
      this.emitter.emit("diagnostic", { kind: "plugin-load-success", pluginId: manifest.id, sourceUrl: artifact.sourceUrl, moduleByteLength: artifact.moduleBytes.byteLength, durationMs: Date.now() - started });
      return descriptor;
    } finally {
      this.loading.delete(manifest.id);
    }
  }

  private async sendLoad(manifest: NormalizedPluginManifest, artifact: LoadedArtifact, signal: AbortSignal | undefined): Promise<void> {
    const memoryInfo = artifact.moduleInfo.memory;
    const base = { type: "LOAD_PLUGIN" as const, pluginId: manifest.id, manifest, ...(memoryInfo ? { memoryInfo } : {}) };

    if (this.moduleTransfer === "module") {
      let compiled: WebAssembly.Module;
      try {
        compiled = await WebAssembly.compile(artifact.moduleBytes);
      } catch (error) {
        throw new AudiospanError("MODULE_INVALID", `module for ${manifest.id} failed to compile: ${(error as Error).message}${simdHint()}`, { cause: error, pluginId: manifest.id });
      }
      throwIfAborted(signal, `loading plugin ${manifest.id}`);
      // Not every browser can structured-clone a WebAssembly.Module into an
      // AudioWorklet (Chromium reports messageerror). The worklet answers with an
      // unsolicited PROTOCOL_CLONE_FAILED; retire the pending request and retry with bytes.
      const requestId = this.connection.nextRequestId();
      const off = this.connection.onCloneFailure(() => {
        this.connection.cancel(requestId, new AudiospanError("RUNTIME_ERROR", "the worklet could not deserialize the WebAssembly.Module", { runtimeCode: "PROTOCOL_CLONE_FAILED", pluginId: manifest.id }));
        return true;
      });
      try {
        await this.connection.request({ ...base, requestId, module: compiled }, ["PLUGIN_READY"]);
        return;
      } catch (error) {
        if (!(AudiospanError.is(error) && error.runtimeCode === "PROTOCOL_CLONE_FAILED")) throw this.wrapLoadError(error, manifest.id);
      } finally {
        off();
      }
    } else {
      // The binary was inspected structurally during loading; let the engine
      // validate it here, cheaply and synchronously, before anything reaches
      // the audio thread. The worklet then compiles it exactly once.
      if (!WebAssembly.validate(artifact.moduleBytes)) {
        throw new AudiospanError("MODULE_INVALID", `module for ${manifest.id} failed WebAssembly validation${simdHint()}`, { pluginId: manifest.id });
      }
    }

    throwIfAborted(signal, `loading plugin ${manifest.id}`);
    const bytes = artifact.moduleBytes.slice().buffer;
    try {
      await this.connection.request({ ...base, requestId: this.connection.nextRequestId(), module: bytes }, ["PLUGIN_READY"], [bytes]);
    } catch (error) {
      throw this.wrapLoadError(error, manifest.id);
    }
  }

  private wrapLoadError(error: unknown, pluginId: string): AudiospanError {
    const err = error instanceof AudiospanError ? error : new AudiospanError("RUNTIME_ERROR", (error as Error).message, { cause: error, pluginId });
    this.emitter.emit("diagnostic", { kind: "plugin-load-failure", pluginId, sourceUrl: "", message: err.message });
    return err;
  }

  getPlugin(pluginId: string): PluginDescriptor | undefined {
    return this.plugins.get(pluginId)?.descriptor;
  }

  listPlugins(): PluginDescriptor[] {
    return Array.from(this.plugins.values(), (p) => p.descriptor);
  }

  /** Unload a plugin with no live instances. */
  async unloadPlugin(pluginId: string): Promise<void> {
    this.assertLive();
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new AudiospanError("PLUGIN_NOT_FOUND", `plugin ${pluginId} is not loaded`, { pluginId });
    if (plugin.instances.size > 0) throw new AudiospanError("PLUGIN_IN_USE", `plugin ${pluginId} still has ${plugin.instances.size} live instance(s)`, { pluginId });
    await this.connection.request({ type: "UNLOAD_PLUGIN", requestId: this.connection.nextRequestId(), pluginId }, ["ACK"]);
    this.plugins.delete(pluginId);
    for (const [key, id] of this.loadedSources) if (id === pluginId) this.loadedSources.delete(key);
  }

  /**
   * The one-call path: load the plugin if this host has not loaded it yet,
   * create an instance, and append it to the active chain, creating and
   * connecting a chain when there is none. Returns the instance; dispose it
   * to remove it again. Pass a generated type (`dist/plugin.d.ts`) as the type
   * argument for compile-time checked ids.
   */
  async addPlugin<T extends PluginInstance = PluginInstance>(source: PluginSourceInput, options: AddPluginOptions = {}): Promise<T> {
    this.assertLive();
    const { index, signal, ...createOptions } = options;
    const key = sourceKeyOf(source);
    let pluginId = key !== undefined ? this.loadedSources.get(key) : undefined;
    if (pluginId === undefined || !this.plugins.has(pluginId)) {
      try {
        pluginId = (await this.loadPlugin(source, signal ? { signal } : {})).id;
      } catch (error) {
        // The same plugin was loaded from another source (or inline): reuse it.
        if (AudiospanError.is(error, "PLUGIN_ALREADY_LOADED") && error.pluginId !== undefined && this.plugins.has(error.pluginId)) pluginId = error.pluginId;
        else throw error;
      }
    }
    const plugin = await this.createPlugin<T>(pluginId, createOptions);
    const chain = this.activeChain ?? this.createChain();
    chain.add(plugin, index);
    if (this.activeChain === chain) await chain.flush();
    else await this.connectChain(chain);
    return plugin;
  }

  // -------------------------------------------------------------------
  // Instances
  // -------------------------------------------------------------------

  async createPlugin<T extends PluginInstance = PluginInstance>(pluginId: string, options: CreatePluginOptions = {}): Promise<T> {
    this.assertLive();
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new AudiospanError("PLUGIN_NOT_FOUND", `plugin ${pluginId} is not loaded; call loadPlugin() first`, { pluginId });
    if (this.instances.size + this.reservedIds.size >= this.config.maxPlugins) {
      throw new AudiospanError("INSTANCE_LIMIT", `cannot create another instance: the limit is ${this.config.maxPlugins}`, { pluginId });
    }
    const instanceId = options.instanceId ?? `${pluginId}#${++this.instanceCounter}`;
    if (this.instances.has(instanceId) || this.reservedIds.has(instanceId)) {
      throw new AudiospanError("INSTANCE_CREATE_FAILED", `instance id ${instanceId} is already in use`, { pluginId, instanceId });
    }

    const initial = new Map<string, number>();
    let warnings: readonly ValidationIssue[] = [];
    let opaque: ArrayBuffer | undefined;
    if (options.initialState) {
      const validation = validatePluginState(options.initialState, plugin.descriptor.manifest);
      if (!validation.ok) {
        const summary = validation.errors.map((e) => `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}`).join("; ");
        throw new AudiospanError("INVALID_STATE", `initial state rejected for plugin ${pluginId}: ${summary}`, { issues: validation.errors, pluginId });
      }
      for (const [id, value] of Object.entries(validation.state.parameters)) initial.set(id, value);
      warnings = validation.warnings;
      if (validation.state.opaqueBytes && validation.state.opaqueBytes.byteLength > 0) opaque = validation.state.opaqueBytes.slice().buffer as ArrayBuffer;
    }
    const initialParameters = plugin.descriptor.parameters.map((p) => initial.get(p.id) ?? p.default);

    // Reserve the id and a slot so concurrent calls cannot exceed maxPlugins while this one is in flight.
    this.reservedIds.add(instanceId);
    let ready: PluginInstanceImpl;
    try {
      const response = await this.connection.request({ type: "CREATE_INSTANCE", requestId: this.connection.nextRequestId(), pluginId, instanceId, initialParameters }, ["INSTANCE_READY"]);
      ready = new PluginInstanceImpl(this.internals, instanceId, plugin.descriptor, response.channels, response.latencyFrames, initial);
      this.instances.set(instanceId, ready);
      plugin.instances.add(instanceId);
    } finally {
      this.reservedIds.delete(instanceId);
    }
    ready.setStatus("ready");
    if (opaque) {
      // Opaque state first, then explicit parameter values win (same order as setState()).
      const entries: [number, number][] = plugin.descriptor.parameters.filter((p) => initial.has(p.id)).map((p) => [p.index, initial.get(p.id)!]);
      try {
        const applied = await this.connection.request({ type: "SET_STATE", requestId: this.connection.nextRequestId(), instanceId, parameters: entries, opaque }, ["STATE_APPLIED"], [opaque]);
        ready.adoptRuntimeValues(applied.parameters, new Set(initial.keys()), "state");
      } catch (error) {
        await ready.dispose().catch(() => undefined);
        throw error;
      }
    }
    if (warnings.length > 0 && this.config.diagnostics) this.emitter.emit("diagnostic", { kind: "state-restore", instanceId, warnings: warnings.length });
    return ready as unknown as T;
  }

  private forgetInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    this.instances.delete(instanceId);
    this.plugins.get(instance.descriptor.id)?.instances.delete(instanceId);
    for (const chain of this.chains) chain.dropInstance(instanceId);
  }

  listInstances(): PluginInstance[] {
    return Array.from(this.instances.values());
  }

  // -------------------------------------------------------------------
  // Chain and graph
  // -------------------------------------------------------------------

  createChain(): AudioChain {
    this.assertLive();
    const chain = new AudioChainImpl(this.internals, (plugin): plugin is PluginInstanceImpl => plugin instanceof PluginInstanceImpl && this.instances.get(plugin.id) === plugin);
    this.chains.add(chain);
    return chain;
  }

  /** Make `chain` the chain the runtime processes. Resolves when the runtime has switched. */
  async connectChain(chain: AudioChain): Promise<void> {
    this.assertLive();
    if (!(chain instanceof AudioChainImpl) || !this.chains.has(chain)) throw new AudiospanError("CHAIN_ERROR", "chain was not created by this host");
    if (this.activeChain && this.activeChain !== chain) this.activeChain.deactivate();
    this.activeChain = chain;
    await chain.activate();
  }

  getActiveChain(): AudioChain | null {
    return this.activeChain;
  }

  private forgetChain(chainId: string): void {
    for (const chain of this.chains) {
      if (chain.id !== chainId) continue;
      this.chains.delete(chain);
      if (this.activeChain === chain) this.activeChain = null;
    }
  }

  /** Route an AudioNode into the chain. Requires an AudioContext-backed host. */
  connectSource(source: AudioNode, output = 0): void {
    this.assertLive();
    const node = this.requireNode();
    source.connect(node, output, 0);
    this.sources.add(source);
  }

  disconnectSource(source?: AudioNode): void {
    const node = this.node;
    if (!node) return;
    const targets = source ? [source] : Array.from(this.sources);
    for (const s of targets) {
      try {
        s.disconnect(node);
      } catch {
        // already disconnected
      }
      this.sources.delete(s);
    }
  }

  /** Route the chain output to an AudioNode (typically audioContext.destination). */
  connectDestination(destination: AudioNode, input = 0): void {
    this.assertLive();
    const node = this.requireNode();
    node.connect(destination, 0, input);
    this.destinations.add(destination);
  }

  disconnectDestination(destination?: AudioNode): void {
    const node = this.node;
    if (!node) return;
    const targets = destination ? [destination] : Array.from(this.destinations);
    for (const d of targets) {
      try {
        node.disconnect(d);
      } catch {
        // already disconnected
      }
      this.destinations.delete(d);
    }
  }

  private requireNode(): AudioWorkletNode {
    if (!this.node) throw new AudiospanError("NOT_SUPPORTED", "this host has no AudioWorkletNode (custom transport); audio graph connections are unavailable");
    return this.node;
  }

  /** Resolves once every message sent so far has been processed by the runtime. */
  async sync(): Promise<void> {
    this.assertLive();
    for (const chain of this.chains) await chain.flush();
    await this.connection.request({ type: "PING", requestId: this.connection.nextRequestId() }, ["ACK"]);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.statusValue === "disposed") return;
    this.statusValue = "disposed";
    try {
      await this.connection.request({ type: "DISPOSE", requestId: this.connection.nextRequestId() }, ["ACK"]);
    } catch {
      // best effort: the runtime may already be gone
    }
    this.teardown();
  }

  private teardown(): void {
    this.statusValue = "disposed";
    for (const chain of this.chains) chain.markDisposed();
    this.chains.clear();
    this.activeChain = null;
    for (const instance of this.instances.values()) instance.markDisposed();
    this.instances.clear();
    this.reservedIds.clear();
    this.plugins.clear();
    this.loading.clear();
    this.disconnectSource();
    this.disconnectDestination();
    if (this.node) {
      this.node.onprocessorerror = null;
      try {
        this.node.disconnect();
      } catch {
        // ignore
      }
    }
    this.connection.close();
    this.emitter.clear();
  }
}
