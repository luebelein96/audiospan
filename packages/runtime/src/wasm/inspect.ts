import { ALLOWED_IMPORTS, EXPORT_GET_OUTPUT, EXPORT_MEMORY, IMPORT_LOG, IMPORT_LOG_MODULE, REQUIRED_FUNCTION_EXPORTS, WASM_PAGE_BYTES } from "../abi.js";

export interface WasmImportInfo {
  module: string;
  name: string;
  kind: "function" | "table" | "memory" | "global" | "tag";
}

export interface WasmExportInfo {
  name: string;
  kind: "function" | "table" | "memory" | "global" | "tag";
}

export interface WasmMemoryInfo {
  /** True when the module imports `env.memory` instead of defining its own. */
  imported: boolean;
  initialPages: number;
  maximumPages: number | undefined;
  shared: boolean;
}

export interface WasmModuleInfo {
  imports: WasmImportInfo[];
  exports: WasmExportInfo[];
  /** Undefined when the module declares no memory at all. */
  memory: WasmMemoryInfo | undefined;
  byteLength: number;
}

export interface WasmValidationIssue {
  code: "MODULE_INVALID" | "MODULE_IMPORT_UNSUPPORTED" | "MODULE_EXPORT_MISSING" | "MODULE_MEMORY_INVALID" | "MODULE_MEMORY_LIMIT";
  message: string;
}

const KIND_NAMES = ["function", "table", "memory", "global", "tag"] as const;

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error("unexpected end of module");
    return this.bytes[this.pos++]!;
  }
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error("LEB128 overflow");
    }
    return result >>> 0;
  }
  u64(): number {
    // Used for memory64 limits; we only need a JS-safe approximation.
    let result = 0;
    let multiplier = 1;
    for (;;) {
      const byte = this.u8();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) break;
      multiplier *= 128;
      if (multiplier > 2 ** 63) throw new Error("LEB128 overflow");
    }
    return result;
  }
  name(): string {
    const length = this.u32();
    if (this.pos + length > this.bytes.length) throw new Error("unexpected end of module");
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    // Created per call on purpose: this parser runs on the main thread, in Node and in the CLI, never in the
    // AudioWorkletGlobalScope (which has no TextDecoder); nothing in this package may touch it at module load.
    return new TextDecoder("utf-8", { fatal: false }).decode(slice);
  }
  skip(n: number): void {
    if (this.pos + n > this.bytes.length) throw new Error("unexpected end of module");
    this.pos += n;
  }
}

function readLimits(r: Reader): { min: number; max: number | undefined; shared: boolean } {
  const flags = r.u8();
  const is64 = (flags & 0x04) !== 0;
  const hasMax = (flags & 0x01) !== 0;
  const shared = (flags & 0x02) !== 0;
  const min = is64 ? r.u64() : r.u32();
  const max = hasMax ? (is64 ? r.u64() : r.u32()) : undefined;
  return { min, max, shared };
}

/**
 * Parse the import, memory and export sections of a WebAssembly binary.
 * Works anywhere (no `WebAssembly` global needed), so the CLI and the host
 * can inspect a module before compiling it. Throws on malformed input.
 */
export function inspectWasmModule(input: Uint8Array | ArrayBuffer): WasmModuleInfo {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  if (bytes.length < 8 || r.u8() !== 0x00 || r.u8() !== 0x61 || r.u8() !== 0x73 || r.u8() !== 0x6d) {
    throw new Error("not a WebAssembly module (bad magic)");
  }
  const version = r.u8() | (r.u8() << 8) | (r.u8() << 16) | (r.u8() << 24);
  if (version !== 1) throw new Error(`unsupported WebAssembly binary version ${version}`);

  const imports: WasmImportInfo[] = [];
  const exports: WasmExportInfo[] = [];
  let memory: WasmMemoryInfo | undefined;

  while (!r.eof) {
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    if (end > bytes.length) throw new Error("section exceeds module size");
    if (id === 2) {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const module = r.name();
        const name = r.name();
        const kindByte = r.u8();
        const kind = KIND_NAMES[kindByte];
        if (!kind) throw new Error(`unknown import kind ${kindByte}`);
        switch (kindByte) {
          case 0:
            r.u32();
            break;
          case 1:
            r.u8();
            readLimits(r);
            break;
          case 2: {
            const limits = readLimits(r);
            memory = { imported: true, initialPages: limits.min, maximumPages: limits.max, shared: limits.shared };
            break;
          }
          case 3:
            r.u8();
            r.u8();
            break;
          case 4:
            r.u8();
            r.u32();
            break;
          default:
            break;
        }
        imports.push({ module, name, kind });
      }
    } else if (id === 5) {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const limits = readLimits(r);
        if (i === 0 && memory === undefined) {
          memory = { imported: false, initialPages: limits.min, maximumPages: limits.max, shared: limits.shared };
        }
      }
    } else if (id === 7) {
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const name = r.name();
        const kindByte = r.u8();
        r.u32();
        const kind = KIND_NAMES[kindByte];
        if (!kind) throw new Error(`unknown export kind ${kindByte}`);
        exports.push({ name, kind });
      }
    }
    r.pos = end;
  }
  return { imports, exports, memory, byteLength: bytes.length };
}

export interface WasmModuleLimits {
  /** Hard cap on the module's maximum memory in bytes. */
  maxMemoryBytes: number;
  /** Accept the development-only `env.audiospan_log` import (default false). */
  allowLogging?: boolean;
  /** Require `audiospan_get_output` because the manifest declares outputs (default false). */
  requireOutputs?: boolean;
}

export function logImportMessage(): string {
  return `module imports the development-only "${IMPORT_LOG_MODULE}.${IMPORT_LOG}"; enable pluginLogging on the host, or rebuild without AUDIOSPAN_ENABLE_LOG (audiospan build without --dev)`;
}

/**
 * Check an inspected module against ABI requirements and host limits.
 * Returns an empty array when the module is acceptable.
 */
export function validateWasmModuleInfo(info: WasmModuleInfo, limits: WasmModuleLimits): WasmValidationIssue[] {
  const issues: WasmValidationIssue[] = [];
  const exportNames = new Set(info.exports.filter((e) => e.kind === "function").map((e) => e.name));
  for (const name of REQUIRED_FUNCTION_EXPORTS) {
    if (!exportNames.has(name)) issues.push({ code: "MODULE_EXPORT_MISSING", message: `module does not export required function "${name}"` });
  }
  if (limits.requireOutputs && !exportNames.has(EXPORT_GET_OUTPUT)) {
    issues.push({ code: "MODULE_EXPORT_MISSING", message: `manifest declares outputs but the module does not export "${EXPORT_GET_OUTPUT}"` });
  }
  for (const imp of info.imports) {
    if (imp.module === IMPORT_LOG_MODULE && imp.name === IMPORT_LOG && imp.kind === "function") {
      if (!limits.allowLogging) issues.push({ code: "MODULE_IMPORT_UNSUPPORTED", message: logImportMessage() });
      continue;
    }
    const allowed = ALLOWED_IMPORTS[imp.module];
    if (!allowed || !allowed.includes(imp.name)) {
      issues.push({ code: "MODULE_IMPORT_UNSUPPORTED", message: `module imports "${imp.module}.${imp.name}" which the runtime does not provide` });
    }
  }
  if (!info.memory) {
    issues.push({ code: "MODULE_MEMORY_INVALID", message: "module declares no linear memory" });
  } else {
    if (!info.memory.imported && !info.exports.some((e) => e.kind === "memory" && e.name === EXPORT_MEMORY)) {
      issues.push({ code: "MODULE_MEMORY_INVALID", message: `module must export its linear memory as "${EXPORT_MEMORY}"` });
    }
    if (info.memory.shared) {
      issues.push({ code: "MODULE_MEMORY_INVALID", message: "shared memory is not supported by the v1 runtime" });
    }
    const maxPagesAllowed = Math.floor(limits.maxMemoryBytes / WASM_PAGE_BYTES);
    if (!info.memory.imported) {
      if (info.memory.maximumPages === undefined) {
        issues.push({ code: "MODULE_MEMORY_LIMIT", message: `module must declare a maximum memory size (at most ${limits.maxMemoryBytes} bytes); link with a maximum memory setting` });
      } else if (info.memory.maximumPages > maxPagesAllowed) {
        issues.push({ code: "MODULE_MEMORY_LIMIT", message: `module declares a maximum memory of ${info.memory.maximumPages * WASM_PAGE_BYTES} bytes but the limit is ${limits.maxMemoryBytes}` });
      }
    }
    if (info.memory.initialPages > maxPagesAllowed) {
      issues.push({ code: "MODULE_MEMORY_LIMIT", message: `module requires an initial memory of ${info.memory.initialPages * WASM_PAGE_BYTES} bytes but the limit is ${limits.maxMemoryBytes}` });
    }
  }
  return issues;
}
