import {
  ABI_VERSION,
  ALLOWED_IMPORTS,
  AS_ERROR_UNSUPPORTED,
  AS_OK,
  EXPORT_ABI_VERSION,
  EXPORT_ALLOC,
  EXPORT_CREATE,
  EXPORT_DESTROY,
  EXPORT_FREE,
  EXPORT_GET_LATENCY,
  EXPORT_GET_OUTPUT,
  EXPORT_GET_PARAMETER,
  EXPORT_GET_STATE,
  EXPORT_GET_STATE_SIZE,
  EXPORT_INITIALIZE,
  EXPORT_MEMORY,
  IMPORT_LOG,
  IMPORT_LOG_MODULE,
  MAX_LOG_MESSAGE_BYTES,
  EXPORT_PROCESS,
  EXPORT_RESET,
  EXPORT_SET_PARAMETER,
  EXPORT_SET_STATE,
  HOST_CONFIG_OFFSET_MAX_FRAMES,
  HOST_CONFIG_OFFSET_MAX_INPUT_CHANNELS,
  HOST_CONFIG_OFFSET_MAX_OUTPUT_CHANNELS,
  HOST_CONFIG_OFFSET_SAMPLE_RATE,
  HOST_CONFIG_OFFSET_STRUCT_SIZE,
  HOST_CONFIG_STRUCT_SIZE,
  PROCESS_OFFSET_FRAME_COUNT,
  PROCESS_OFFSET_INPUTS,
  PROCESS_OFFSET_INPUT_CHANNELS,
  PROCESS_OFFSET_OUTPUTS,
  PROCESS_OFFSET_OUTPUT_CHANNELS,
  PROCESS_OFFSET_STRUCT_SIZE,
  PROCESS_STRUCT_SIZE,
  REQUIRED_FUNCTION_EXPORTS,
  WASM_PAGE_BYTES,
  statusName,
} from "../abi.js";
import { RuntimeError } from "../errors.js";
import { inspectWasmModule, logImportMessage, validateWasmModuleInfo, type WasmMemoryInfo } from "./inspect.js";

export interface WasmInstanceOptions {
  sampleRate: number;
  /** Largest frame count that will ever be passed to process(). */
  maxFrames: number;
  /** Channel count used for both input and output of this instance. */
  channels: number;
  maxMemoryBytes: number;
  maxStateBytes: number;
  /** Memory limits parsed from the binary; required when the module imports its memory. */
  memoryInfo?: WasmMemoryInfo | undefined;
  /** Provide the development-only `env.audiospan_log` import (default false: a module importing it is rejected). */
  allowLogging?: boolean | undefined;
  /**
   * Receives log lines when `allowLogging` is set, as a copy of the UTF-8
   * bytes (never decoded here: the worklet scope has no TextDecoder). Called
   * synchronously from inside the plugin's call.
   */
  onLog?: ((level: number, bytes: Uint8Array) => void) | undefined;
  /** Number of outputs the manifest declares; when > 0 the module must export `audiospan_get_output`. */
  outputCount?: number | undefined;
}

interface AbiExports {
  [EXPORT_MEMORY]?: WebAssembly.Memory;
  [EXPORT_INITIALIZE]?: () => void;
  [EXPORT_ABI_VERSION]: () => number;
  [EXPORT_ALLOC]: (size: number, alignment: number) => number;
  [EXPORT_FREE]: (ptr: number) => void;
  [EXPORT_CREATE]: (config: number, outInstance: number) => number;
  [EXPORT_DESTROY]: (instance: number) => number;
  [EXPORT_RESET]: (instance: number) => number;
  [EXPORT_PROCESS]: (instance: number, process: number) => number;
  [EXPORT_SET_PARAMETER]: (instance: number, index: number, value: number) => number;
  [EXPORT_GET_PARAMETER]: (instance: number, index: number, outValue: number) => number;
  [EXPORT_GET_STATE_SIZE]: (instance: number, outSize: number) => number;
  [EXPORT_GET_STATE]: (instance: number, destination: number, capacity: number, outWritten: number) => number;
  [EXPORT_SET_STATE]: (instance: number, source: number, size: number) => number;
  [EXPORT_GET_LATENCY]?: (instance: number, outFrames: number) => number;
  [EXPORT_GET_OUTPUT]?: (instance: number, index: number, outValue: number) => number;
}

const WASI_ENOSYS = 52;

/** Maps a plugin input channel to a source channel index, or -1 for silence. */
export function mapSourceChannel(channel: number, sourceCount: number): number {
  if (sourceCount <= 0) return -1;
  if (sourceCount === 1) return 0;
  return channel < sourceCount ? channel : -1;
}

/**
 * One live plugin instance inside its own WebAssembly instance.
 *
 * Owns the host-side scratch allocations in module memory: the host config,
 * the process descriptor, planar channel pointer tables, and one sample
 * buffer per channel. All of these are allocated once at creation and reused
 * for every process() call; the hot path performs no allocation in steady
 * state (typed-array views are recreated only when memory grows or the frame
 * count changes).
 */
export class WasmPluginInstance {
  static async instantiate(
    source: WebAssembly.Module | ArrayBuffer | Uint8Array,
    options: WasmInstanceOptions,
  ): Promise<WasmPluginInstance> {
    let module: WebAssembly.Module;
    let memoryInfo = options.memoryInfo;
    if (source instanceof WebAssembly.Module) {
      module = source;
    } else {
      // Copy into a fresh ArrayBuffer-backed view: the caller may hand us a
      // subarray of a larger buffer, and the bytes may be reused after this call.
      const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(source instanceof Uint8Array ? source : new Uint8Array(source));
      let info;
      try {
        info = inspectWasmModule(bytes);
      } catch (error) {
        throw new RuntimeError("MODULE_INVALID", `invalid WebAssembly module: ${(error as Error).message}`);
      }
      const issues = validateWasmModuleInfo(info, { maxMemoryBytes: options.maxMemoryBytes, allowLogging: options.allowLogging ?? false, requireOutputs: (options.outputCount ?? 0) > 0 });
      if (issues.length > 0) throw new RuntimeError(issues[0]!.code, issues.map((i) => i.message).join("; "));
      memoryInfo = info.memory;
      try {
        module = await WebAssembly.compile(bytes);
      } catch (error) {
        throw new RuntimeError("MODULE_INVALID", `WebAssembly compilation failed: ${(error as Error).message}`);
      }
    }

    // Validate through the JS API as well; this covers precompiled modules.
    const exportList = WebAssembly.Module.exports(module);
    const importList = WebAssembly.Module.imports(module);
    const exportNames = new Set(exportList.filter((e) => e.kind === "function").map((e) => e.name));
    for (const name of REQUIRED_FUNCTION_EXPORTS) {
      if (!exportNames.has(name)) throw new RuntimeError("MODULE_EXPORT_MISSING", `module does not export required function "${name}"`);
    }
    if ((options.outputCount ?? 0) > 0 && !exportNames.has(EXPORT_GET_OUTPUT)) {
      throw new RuntimeError("MODULE_EXPORT_MISSING", `manifest declares outputs but the module does not export "${EXPORT_GET_OUTPUT}"`);
    }
    const importsMemory = importList.some((i) => i.module === "env" && i.name === "memory" && i.kind === "memory");
    if (!importsMemory && !exportList.some((e) => e.kind === "memory" && e.name === EXPORT_MEMORY)) {
      throw new RuntimeError("MODULE_MEMORY_INVALID", `module must export its linear memory as "${EXPORT_MEMORY}"`);
    }

    const growthFlag = { grew: false };
    const memoryRef: { memory: WebAssembly.Memory | undefined } = { memory: undefined };
    const importObject: Record<string, WebAssembly.ModuleImports> = {};
    for (const imp of importList) {
      if (imp.module === IMPORT_LOG_MODULE && imp.name === IMPORT_LOG && imp.kind === "function") {
        if (!options.allowLogging) throw new RuntimeError("MODULE_IMPORT_UNSUPPORTED", logImportMessage());
        (importObject[imp.module] ??= {})[imp.name] = (level: number, ptr: number, length: number) => {
          const memory = memoryRef.memory;
          const onLog = options.onLog;
          if (!memory || !onLog) return;
          const buffer = memory.buffer;
          const start = ptr >>> 0;
          if (start >= buffer.byteLength) return;
          const size = Math.min(length >>> 0, MAX_LOG_MESSAGE_BYTES, buffer.byteLength - start);
          try {
            onLog(level >>> 0, new Uint8Array(buffer, start, size).slice());
          } catch {
            // A host listener threw; never let that trap the plugin.
          }
        };
        continue;
      }
      const allowed = ALLOWED_IMPORTS[imp.module];
      if (!allowed || !allowed.includes(imp.name)) {
        throw new RuntimeError("MODULE_IMPORT_UNSUPPORTED", `module imports "${imp.module}.${imp.name}" which the runtime does not provide`);
      }
      const target = (importObject[imp.module] ??= {});
      if (imp.module === "env" && imp.name === "memory") {
        if (!memoryInfo || !memoryInfo.imported) {
          throw new RuntimeError("MODULE_MEMORY_INVALID", "module imports env.memory but no memory limits were supplied; pass the module bytes");
        }
        const limitPages = Math.floor(options.maxMemoryBytes / WASM_PAGE_BYTES);
        if (memoryInfo.initialPages > limitPages) {
          throw new RuntimeError("MODULE_MEMORY_LIMIT", `module requires ${memoryInfo.initialPages * WASM_PAGE_BYTES} bytes of memory but the limit is ${options.maxMemoryBytes}`);
        }
        const maximum = Math.min(memoryInfo.maximumPages ?? limitPages, limitPages);
        target[imp.name] = new WebAssembly.Memory({ initial: memoryInfo.initialPages, maximum });
      } else if (imp.module === "env" && imp.name === "emscripten_notify_memory_growth") {
        target[imp.name] = () => {
          growthFlag.grew = true;
        };
      } else if (imp.module === "wasi_snapshot_preview1") {
        target[imp.name] =
          imp.name === "proc_exit"
            ? (code: number) => {
                throw new RuntimeError("ABI_TRAP", `plugin called proc_exit(${code})`);
              }
            : () => WASI_ENOSYS;
      }
    }

    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(module, importObject);
    } catch (error) {
      throw new RuntimeError("MODULE_INVALID", `WebAssembly instantiation failed: ${(error as Error).message}`);
    }
    const exports = instance.exports as unknown as AbiExports;
    const memory = importsMemory ? (importObject["env"]!["memory"] as WebAssembly.Memory) : exports[EXPORT_MEMORY];
    if (!(memory instanceof WebAssembly.Memory)) throw new RuntimeError("MODULE_MEMORY_INVALID", "module memory is not a WebAssembly.Memory");
    memoryRef.memory = memory;

    const plugin = new WasmPluginInstance(exports, memory, options, growthFlag);
    plugin.initialize();
    return plugin;
  }

  readonly channels: number;
  readonly maxFrames: number;
  private readonly exports: AbiExports;
  private readonly memory: WebAssembly.Memory;
  private readonly options: WasmInstanceOptions;
  private readonly growthFlag: { grew: boolean };

  private handle = 0;
  private destroyed = false;

  private cachedBuffer: ArrayBufferLike | null = null;
  private u8!: Uint8Array;
  private u32!: Uint32Array;
  private f64!: Float64Array;
  private frames = 0;
  private viewFrames = -1;
  private inViews: Float32Array[] = [];
  private outViews: Float32Array[] = [];

  private configPtr = 0;
  private processPtr = 0;
  private scratchPtr = 0; // 8 bytes, 8-aligned: out params (u32 / f64)
  private inTablePtr = 0;
  private outTablePtr = 0;
  private inBuffers: number[] = [];
  private outBuffers: number[] = [];

  /** Set when memory grew during the last process() call; consumed by the runtime. */
  memoryGrewDuringProcess = false;

  private constructor(exports: AbiExports, memory: WebAssembly.Memory, options: WasmInstanceOptions, growthFlag: { grew: boolean }) {
    this.exports = exports;
    this.memory = memory;
    this.options = options;
    this.growthFlag = growthFlag;
    this.channels = options.channels;
    this.maxFrames = options.maxFrames;
  }

  get memoryBytes(): number {
    return this.memory.buffer.byteLength;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  private initialize(): void {
    const ex = this.exports;
    this.call("initialize", () => ex[EXPORT_INITIALIZE]?.());
    const version = this.call("abi version", () => ex[EXPORT_ABI_VERSION]()) >>> 0;
    if (version !== ABI_VERSION) {
      throw new RuntimeError("ABI_VERSION_MISMATCH", `module reports ABI version ${version}; this runtime supports ${ABI_VERSION}`);
    }
    const channels = this.channels;
    const maxFrames = this.maxFrames;
    this.configPtr = this.alloc(HOST_CONFIG_STRUCT_SIZE, 4);
    this.processPtr = this.alloc(PROCESS_STRUCT_SIZE, 4);
    this.scratchPtr = this.alloc(8, 8);
    this.inTablePtr = this.alloc(Math.max(1, channels) * 4, 4);
    this.outTablePtr = this.alloc(Math.max(1, channels) * 4, 4);
    for (let c = 0; c < channels; c++) {
      this.inBuffers.push(this.alloc(maxFrames * 4, 16));
      this.outBuffers.push(this.alloc(maxFrames * 4, 16));
    }
    this.refreshViews();
    const u32 = this.u32;
    u32[(this.configPtr + HOST_CONFIG_OFFSET_STRUCT_SIZE) >> 2] = HOST_CONFIG_STRUCT_SIZE;
    u32[(this.configPtr + HOST_CONFIG_OFFSET_SAMPLE_RATE) >> 2] = this.options.sampleRate >>> 0;
    u32[(this.configPtr + HOST_CONFIG_OFFSET_MAX_FRAMES) >> 2] = maxFrames;
    u32[(this.configPtr + HOST_CONFIG_OFFSET_MAX_INPUT_CHANNELS) >> 2] = channels;
    u32[(this.configPtr + HOST_CONFIG_OFFSET_MAX_OUTPUT_CHANNELS) >> 2] = channels;
    for (let c = 0; c < channels; c++) {
      u32[(this.inTablePtr >> 2) + c] = this.inBuffers[c]!;
      u32[(this.outTablePtr >> 2) + c] = this.outBuffers[c]!;
    }
    u32[(this.processPtr + PROCESS_OFFSET_STRUCT_SIZE) >> 2] = PROCESS_STRUCT_SIZE;
    u32[(this.processPtr + PROCESS_OFFSET_INPUTS) >> 2] = this.inTablePtr;
    u32[(this.processPtr + PROCESS_OFFSET_OUTPUTS) >> 2] = this.outTablePtr;

    const status = this.call("create", () => ex[EXPORT_CREATE](this.configPtr, this.scratchPtr));
    this.refreshViews();
    if (status !== AS_OK) throw new RuntimeError("INSTANCE_CREATE_FAILED", `audiospan_create failed with ${statusName(status)}`, status);
    this.handle = this.u32[this.scratchPtr >> 2]!;
    if (this.handle === 0) throw new RuntimeError("INSTANCE_CREATE_FAILED", "audiospan_create returned a null instance handle");
    this.checkMemoryLimit();
  }

  private alloc(size: number, alignment: number): number {
    const ptr = this.call("alloc", () => this.exports[EXPORT_ALLOC](size, alignment)) >>> 0;
    if (ptr === 0) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_alloc(${size}, ${alignment}) returned null`);
    if (ptr % alignment !== 0) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_alloc returned a misaligned pointer ${ptr}`);
    if (ptr + size > this.memory.buffer.byteLength) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_alloc returned a pointer outside linear memory`);
    this.cachedBuffer = null; // allocation may have grown memory
    return ptr;
  }

  private free(ptr: number): void {
    this.call("free", () => this.exports[EXPORT_FREE](ptr));
  }

  private call<T>(what: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("ABI_TRAP", `plugin trapped during ${what}: ${(error as Error).message}`);
    }
  }

  private checkMemoryLimit(): void {
    if (this.memory.buffer.byteLength > this.options.maxMemoryBytes) {
      throw new RuntimeError("MODULE_MEMORY_LIMIT", `plugin memory is ${this.memory.buffer.byteLength} bytes; limit is ${this.options.maxMemoryBytes}`);
    }
  }

  private refreshViews(): void {
    const buffer = this.memory.buffer;
    if (buffer === this.cachedBuffer && this.viewFrames === this.frames) return;
    if (buffer !== this.cachedBuffer) {
      this.cachedBuffer = buffer;
      this.u8 = new Uint8Array(buffer);
      this.u32 = new Uint32Array(buffer);
      this.f64 = new Float64Array(buffer);
    }
    const frames = this.frames;
    this.inViews.length = this.channels;
    this.outViews.length = this.channels;
    for (let c = 0; c < this.channels; c++) {
      this.inViews[c] = new Float32Array(buffer, this.inBuffers[c]!, frames);
      this.outViews[c] = new Float32Array(buffer, this.outBuffers[c]!, frames);
    }
    this.viewFrames = frames;
  }

  private assertLive(): void {
    if (this.destroyed) throw new RuntimeError("INSTANCE_NOT_FOUND", "plugin instance has been destroyed");
  }

  /**
   * Planar output buffers in module memory, holding the result of the most
   * recent successful processBlock() call. Valid only until the next call
   * into this instance (process, state, destroy) or until memory grows;
   * callers must consume them immediately and never retain them.
   */
  get outputViews(): readonly Float32Array[] {
    return this.outViews;
  }

  /**
   * Process one block. Reads `channels` planar channels from `source`
   * (mapping mono to all channels, silence for missing ones), writes
   * `channels` planar channels into `destination`.
   *
   * Returns the ABI status. Traps propagate as RuntimeError("ABI_TRAP").
   * Allocation-free once views are warm.
   */
  process(source: readonly Float32Array[], sourceCount: number, destination: readonly Float32Array[], frames: number): number {
    const status = this.processBlock(source, sourceCount, frames);
    if (status === AS_OK) {
      const outViews = this.outViews;
      for (let c = 0; c < this.channels; c++) destination[c]!.set(outViews[c]!);
    }
    return status;
  }

  /**
   * Like process() but leaves the result in module memory; read it through
   * `outputViews`. Lets a chain feed one plugin straight from the previous
   * one without an intermediate copy.
   */
  processBlock(source: readonly Float32Array[], sourceCount: number, frames: number): number {
    if (this.destroyed) return -1;
    if (frames > this.maxFrames) throw new RuntimeError("FRAMES_UNSUPPORTED", `frame count ${frames} exceeds negotiated maximum ${this.maxFrames}`);
    if (frames !== this.frames) {
      this.frames = frames;
      this.viewFrames = -1;
    }
    this.refreshViews();
    const channels = this.channels;
    const inViews = this.inViews;
    for (let c = 0; c < channels; c++) {
      const idx = mapSourceChannel(c, sourceCount);
      if (idx < 0) inViews[c]!.fill(0);
      else inViews[c]!.set(source[idx]!);
    }
    const u32 = this.u32;
    const p = this.processPtr >> 2;
    u32[p + (PROCESS_OFFSET_FRAME_COUNT >> 2)] = frames;
    u32[p + (PROCESS_OFFSET_INPUT_CHANNELS >> 2)] = channels;
    u32[p + (PROCESS_OFFSET_OUTPUT_CHANNELS >> 2)] = channels;

    let status: number;
    try {
      status = this.exports[EXPORT_PROCESS](this.handle, this.processPtr) >>> 0;
    } catch (error) {
      throw new RuntimeError("ABI_TRAP", `plugin trapped during process: ${(error as Error).message}`);
    }
    if (this.memory.buffer !== this.cachedBuffer || this.growthFlag.grew) {
      this.growthFlag.grew = false;
      this.memoryGrewDuringProcess = true;
      this.refreshViews();
    }
    return status;
  }

  setParameter(index: number, value: number): number {
    this.assertLive();
    return this.call("set_parameter", () => this.exports[EXPORT_SET_PARAMETER](this.handle, index >>> 0, value)) >>> 0;
  }

  getParameter(index: number): number {
    this.assertLive();
    const status = this.call("get_parameter", () => this.exports[EXPORT_GET_PARAMETER](this.handle, index >>> 0, this.scratchPtr)) >>> 0;
    if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_parameter(${index}) failed with ${statusName(status)}`, status);
    this.refreshViews();
    return this.f64[this.scratchPtr >> 3]!;
  }

  reset(): number {
    this.assertLive();
    return this.call("reset", () => this.exports[EXPORT_RESET](this.handle)) >>> 0;
  }

  /** True when the module exports the optional `audiospan_get_latency`. */
  get supportsLatency(): boolean {
    return typeof this.exports[EXPORT_GET_LATENCY] === "function";
  }

  /**
   * The latency the plugin currently reports, in frames, or undefined when
   * it reports none (export absent or AS_ERROR_UNSUPPORTED). Control plane
   * and between-block calls only.
   */
  getLatency(): number | undefined {
    this.assertLive();
    const fn = this.exports[EXPORT_GET_LATENCY];
    if (!fn) return undefined;
    const status = this.call("get_latency", () => fn(this.handle, this.scratchPtr)) >>> 0;
    if (status === AS_ERROR_UNSUPPORTED) return undefined;
    if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_latency failed with ${statusName(status)}`, status);
    this.refreshViews();
    return this.u32[this.scratchPtr >> 2]!;
  }

  /** True when the module exports the optional `audiospan_get_output`. */
  get supportsOutputs(): boolean {
    return typeof this.exports[EXPORT_GET_OUTPUT] === "function";
  }

  /** Read output `index` (the manifest's `outputs` order). Throws when the export is missing or refuses the index. */
  getOutput(index: number): number {
    this.assertLive();
    const fn = this.exports[EXPORT_GET_OUTPUT];
    if (!fn) throw new RuntimeError("MODULE_EXPORT_MISSING", `module does not export "${EXPORT_GET_OUTPUT}"`);
    const status = this.call("get_output", () => fn(this.handle, index >>> 0, this.scratchPtr)) >>> 0;
    if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_output(${index}) failed with ${statusName(status)}`, status);
    this.refreshViews();
    return this.f64[this.scratchPtr >> 3]!;
  }

  /** Copies the plugin's opaque state out of module memory. Control plane only. */
  getState(): Uint8Array {
    this.assertLive();
    const ex = this.exports;
    let status = this.call("get_state_size", () => ex[EXPORT_GET_STATE_SIZE](this.handle, this.scratchPtr)) >>> 0;
    if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_state_size failed with ${statusName(status)}`, status);
    this.refreshViews();
    const size = this.u32[this.scratchPtr >> 2]!;
    if (size > this.options.maxStateBytes) throw new RuntimeError("STATE_TOO_LARGE", `plugin state is ${size} bytes; limit is ${this.options.maxStateBytes}`);
    if (size === 0) return new Uint8Array(0);
    const ptr = this.alloc(size, 4);
    try {
      status = this.call("get_state", () => ex[EXPORT_GET_STATE](this.handle, ptr, size, this.scratchPtr)) >>> 0;
      this.refreshViews();
      if (status !== AS_OK) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_state failed with ${statusName(status)}`, status);
      const written = this.u32[this.scratchPtr >> 2]!;
      if (written > size) throw new RuntimeError("ABI_CALL_FAILED", `audiospan_get_state reported ${written} bytes written into a ${size} byte buffer`);
      return this.u8.slice(ptr, ptr + written);
    } finally {
      this.free(ptr);
      this.refreshViews();
      this.checkMemoryLimit();
    }
  }

  /** Copies opaque state into module memory and applies it. Control plane only. */
  setState(bytes: Uint8Array): number {
    this.assertLive();
    if (bytes.length > this.options.maxStateBytes) throw new RuntimeError("STATE_TOO_LARGE", `state is ${bytes.length} bytes; limit is ${this.options.maxStateBytes}`);
    const ptr = this.alloc(Math.max(1, bytes.length), 4);
    try {
      this.refreshViews();
      this.u8.set(bytes, ptr);
      const status = this.call("set_state", () => this.exports[EXPORT_SET_STATE](this.handle, ptr, bytes.length)) >>> 0;
      return status;
    } finally {
      this.free(ptr);
      this.refreshViews();
      this.checkMemoryLimit();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.exports[EXPORT_DESTROY](this.handle);
      for (const ptr of [...this.inBuffers, ...this.outBuffers, this.inTablePtr, this.outTablePtr, this.scratchPtr, this.processPtr, this.configPtr]) {
        this.exports[EXPORT_FREE](ptr);
      }
    } catch {
      // The instance is being discarded; a trap here cannot be acted on.
    }
    this.inViews = [];
    this.outViews = [];
  }

  /** Test hook: the raw instance handle returned by the plugin. */
  get rawHandle(): number {
    return this.handle;
  }
}
